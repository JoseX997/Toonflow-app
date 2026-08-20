#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");
const socketServerEntry = require.resolve("socket.io", { paths: [repoRoot] });
const socketClientBundle = path.resolve(path.dirname(socketServerEntry), "../client-dist/socket.io.js");
const { io } = require(socketClientBundle);

const TERMINAL_STATUSES = new Set(["complete", "error", "stop"]);
const DEFAULTS = {
  baseUrl: "http://localhost:10588",
  autoApprove: true,
  autoApproveUnscored: true,
  autoStart: false,
  startPrompt: "从导演规划开始，严格按 Toonflow 自身的制作流程推进；每个需要用户确认的节点完成后等待审批。",
  approvalPrompt: "审核通过，继续 Toonflow 原生流程的下一阶段。",
  confirmPrompt: "确认。若当前节点要求选择生成范围，选择 Toonflow 当前清单中的全部项目；其余情况按 Toonflow 当前默认路线继续下一阶段。",
  repairPrompt:
    "确认修复。严格采用刚才 Toonflow 审核报告的问题清单与建议方案；单一方案按原建议执行，多选方案采用每项列出的第一个方案。不要增加新的问题或方案；完成后按 Toonflow 原规则重新审核。",
  quietPeriodMs: 4000,
  pollIntervalMs: 5000,
  generationTimeoutMs: 30 * 60 * 1000,
  turnTimeoutMs: 30 * 60 * 1000,
  concurrentCount: 5,
  maxRepairRounds: 2,
  initialRepairRounds: 0,
  think: false,
  thinkLevel: 0,
};

function emit(type, data = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), type, ...data })}\n`);
}

function fail(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  return error;
}

function parseArgs(argv) {
  const args = {
    configPath: path.join(moduleDir, "config.json"),
    configExplicit: false,
    autoStart: undefined,
    autoApprove: undefined,
    list: false,
    probe: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      args.configPath = path.resolve(argv[++index] ?? "");
      args.configExplicit = true;
    } else if (arg === "--start") {
      args.autoStart = true;
    } else if (arg === "--auto") {
      args.autoApprove = true;
    } else if (arg === "--no-auto") {
      args.autoApprove = false;
    } else if (arg === "--list") {
      args.list = true;
    } else if (arg === "--probe") {
      args.probe = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw fail(`未知参数: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Toonflow 用户侧控制器\n\n`);
  process.stdout.write(`用法:\n`);
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --config <配置文件> [--start] [--auto|--no-auto]\n`);
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --config <配置文件> --list\n`);
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --config <配置文件> --probe\n\n`);
  process.stdout.write(`凭据只从 TOONFLOW_TOKEN，或 TOONFLOW_USERNAME + TOONFLOW_PASSWORD 环境变量读取。\n`);
}

async function loadConfig(args) {
  let config = {};
  try {
    config = JSON.parse(await fs.readFile(args.configPath, "utf8"));
  } catch (error) {
    if (args.configExplicit || error?.code !== "ENOENT") throw fail(`无法读取配置文件: ${args.configPath}`, error);
    const examplePath = path.join(moduleDir, "config.example.json");
    config = JSON.parse(await fs.readFile(examplePath, "utf8"));
    emit("config.fallback", { path: examplePath });
  }
  return {
    ...DEFAULTS,
    ...config,
    autoStart: args.autoStart ?? config.autoStart ?? DEFAULTS.autoStart,
    autoApprove: args.autoApprove ?? config.autoApprove ?? DEFAULTS.autoApprove,
  };
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULTS.baseUrl)
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
}

class ToonflowApi {
  constructor(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = "";
  }

  async authenticate() {
    const envToken = process.env.TOONFLOW_TOKEN?.trim();
    if (envToken) {
      this.token = /^Bearer\s+/i.test(envToken) ? envToken : `Bearer ${envToken}`;
      await this.post("/project/getProject", {});
      emit("auth.ready", { method: "token" });
      return;
    }

    const username = process.env.TOONFLOW_USERNAME;
    const password = process.env.TOONFLOW_PASSWORD;
    if (!username || !password) {
      throw fail("缺少登录凭据：设置 TOONFLOW_TOKEN，或同时设置 TOONFLOW_USERNAME 与 TOONFLOW_PASSWORD");
    }
    const data = await this.post("/login/login", { username, password }, false);
    if (!data?.token) throw fail("登录成功响应中缺少 token");
    this.token = data.token;
    emit("auth.ready", { method: "login", username: data.name ?? username });
  }

  async post(route, body, authenticated = true) {
    const url = new URL(`/api${route}`, `${this.baseUrl}/`);
    const headers = { "Content-Type": "application/json" };
    if (authenticated) {
      if (!this.token) throw fail("尚未认证");
      headers.Authorization = this.token;
    }
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      throw fail(`无法连接 Toonflow: ${url.origin}`, error);
    }
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw fail(`Toonflow 返回了非 JSON 响应 (${response.status})`);
    }
    if (!response.ok || (payload.code !== undefined && payload.code !== 200)) {
      const details = Array.isArray(payload.errors) ? `: ${payload.errors.join("; ")}` : "";
      throw fail(`${payload.message || `HTTP ${response.status}`}${details}`);
    }
    return payload.data;
  }
}

function itemName(item) {
  return item?.name ?? item?.title ?? item?.projectName ?? "";
}

async function listContexts(api) {
  const projects = (await api.post("/project/getProject", {})) ?? [];
  const result = [];
  for (const project of projects) {
    const scripts = (await api.post("/script/getScrptApi", { projectId: Number(project.id) })) ?? [];
    result.push({
      id: project.id,
      name: itemName(project),
      scripts: scripts.map((script, index) => ({ index, id: script.id, name: itemName(script), extractState: script.extractState })),
    });
  }
  emit("context.list", { projects: result });
  return { projects, detailed: result };
}

function pickByIdOrName(items, id, name, kind) {
  if (id !== null && id !== undefined && id !== "") {
    const found = items.find((item) => Number(item.id) === Number(id));
    if (!found) throw fail(`未找到${kind} ID ${id}`);
    return found;
  }
  if (name) {
    const exact = items.filter((item) => itemName(item) === name);
    if (exact.length === 1) return exact[0];
    const partial = items.filter((item) => itemName(item).includes(name));
    if (partial.length === 1) return partial[0];
    if (exact.length > 1 || partial.length > 1) throw fail(`${kind}名称匹配到多项: ${name}`);
    throw fail(`未找到${kind}: ${name}`);
  }
  if (items.length === 1) return items[0];
  throw fail(`配置中缺少${kind} ID/名称；先运行 --list 查看可选项`);
}

async function resolveContext(api, config) {
  const projects = (await api.post("/project/getProject", {})) ?? [];
  const project = pickByIdOrName(projects, config.projectId, config.projectName, "项目");
  const scripts = (await api.post("/script/getScrptApi", { projectId: Number(project.id) })) ?? [];
  let script;
  if (config.scriptId !== null && config.scriptId !== undefined && config.scriptId !== "" || config.scriptName) {
    script = pickByIdOrName(scripts, config.scriptId, config.scriptName, "剧本/分集");
  } else if (Number.isInteger(config.scriptIndex)) {
    script = scripts[config.scriptIndex];
    if (!script) throw fail(`scriptIndex 越界: ${config.scriptIndex}`);
  } else {
    script = pickByIdOrName(scripts, null, null, "剧本/分集");
  }
  const context = {
    projectId: Number(project.id),
    projectName: itemName(project),
    scriptId: Number(script.id),
    scriptName: itemName(script),
  };
  emit("context.ready", context);
  return context;
}

function appendValue(current, incoming) {
  if (incoming === undefined) return current;
  if (typeof current === "string" && typeof incoming === "string") return current + incoming;
  if (Array.isArray(current) && Array.isArray(incoming)) return [...current, ...incoming];
  if (current && incoming && typeof current === "object" && typeof incoming === "object") {
    const result = { ...current };
    for (const [key, value] of Object.entries(incoming)) result[key] = appendValue(result[key], value);
    return result;
  }
  return incoming;
}

function mergeValue(current, incoming) {
  if (incoming === undefined) return current;
  if (current && incoming && !Array.isArray(current) && !Array.isArray(incoming) && typeof current === "object" && typeof incoming === "object") {
    return { ...current, ...incoming };
  }
  return incoming;
}

function sanitizeFlowData(flowData) {
  const copy = structuredClone(flowData);
  for (const asset of copy.assets ?? []) {
    delete asset.prompt;
    delete asset.flowId;
    delete asset.src;
    for (const derive of asset.derive ?? []) {
      delete derive.prompt;
      delete derive.flowId;
      delete derive.src;
    }
  }
  for (const storyboard of copy.storyboard ?? []) {
    delete storyboard.prompt;
    delete storyboard.src;
    delete storyboard.flowId;
  }
  return copy;
}

function stripWorkspaceXml(text) {
  return String(text ?? "")
    .replace(/<scriptPlan>[\s\S]*?<\/scriptPlan>/gi, "[导演计划已写入工作区]")
    .replace(/<storyboardTable>[\s\S]*?<\/storyboardTable>/gi, "[分镜表已写入工作区]")
    .trim();
}

function gradeFromText(text) {
  const patterns = [
    /(?:评分|评级|等级)\s*\**\s*[:：]\s*\**\s*([ABCD])(?:\s*级|\b|\s*[—-])/i,
    /总评[\s\S]{0,40}?\b([ABCD])(?:\s*级|\b|\s*[—-])/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function classifyTurn(turn, config, repairRounds) {
  const text = turn.text;
  if (turn.statuses.some((status) => status === "error" || status === "stop")) {
    return { action: "pause", reason: `消息终态为 ${turn.statuses.join(",")}` };
  }
  if (turn.generationFailures.length) {
    return { action: "pause", reason: "后台生成存在失败项", failures: turn.generationFailures };
  }
  if (/流程(?:已经|已)?(?:全部)?完成|制作完成|结束流程|任务已启动并结束流程/.test(text)) {
    return { action: "finish", reason: "Toonflow 已声明流程结束" };
  }
  const grade = gradeFromText(text);
  if (grade === "A") return { action: "approve", grade, prompt: config.approvalPrompt };
  if (grade === "B" && repairRounds > 0) {
    return {
      action: "approve",
      grade,
      reason: "修复后复审达到 B 级，按用户审批规则通过",
      prompt: config.approvalPrompt,
    };
  }
  if (grade && "BCD".includes(grade)) {
    if (repairRounds >= config.maxRepairRounds) {
      return { action: "pause", grade, reason: `已达到最大原生修复轮数 ${config.maxRepairRounds}` };
    }
    return { action: "repair", grade, prompt: config.repairPrompt };
  }
  if (/无法识别|不存在|参数错误|执行失败|审核失败|生成失败|发生错误|请检查/.test(text)) {
    return { action: "pause", reason: "Toonflow 返回错误或无法识别状态" };
  }
  const asksForDecision = /需要您决定|等待(?:用户|您的)?(?:确认|审批|决定)|请(?:您)?确认|是否(?:继续|进入|生成|修复)|下一步(?:是否|计划)|回复[“\"]?(?:继续|确认)/.test(text);
  const reportsCompletion = /已完成|完成确认|写入完成|开始生成|清单|审核报告|下一阶段/.test(text);
  if (config.autoApproveUnscored && asksForDecision && reportsCompletion) {
    return { action: "confirm", prompt: config.confirmPrompt };
  }
  return { action: "pause", reason: grade ? `未配置评分 ${grade} 的处理规则` : "没有识别到 Toonflow 原生评分或明确审批请求" };
}

class ToonflowController {
  constructor(api, context, config) {
    this.api = api;
    this.context = context;
    this.config = config;
    this.socket = null;
    this.flowData = null;
    this.messages = new Map();
    this.currentTurn = null;
    this.turnCounter = 0;
    this.eventVersion = 0;
    this.quietTimer = null;
    this.turnTimer = null;
    this.persistQueue = Promise.resolve();
    this.persistedTags = new Set();
    this.generations = new Map();
    this.repairRounds = Math.max(0, Number(config.initialRepairRounds) || 0);
    this.closed = false;
    this.rl = null;
  }

  async initialize() {
    this.flowData = await this.fetchFlowData();
    this.socket = io(`${this.api.baseUrl}/api/socket/productionAgent`, {
      auth: {
        token: this.api.token,
        isolationKey: `${this.context.projectId}:productionAgent:${this.context.scriptId}`,
        projectId: this.context.projectId,
        scriptId: this.context.scriptId,
      },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 15000,
      autoConnect: false,
    });
    this.installSocketHandlers();
    await new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(fail(`Socket 连接失败: ${error?.message ?? error}`));
      };
      const cleanup = () => {
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
      };
      this.socket.on("connect", onConnect);
      this.socket.on("connect_error", onError);
      this.socket.connect();
    });
    this.socket.emit("updateThinkConfig", {
      think: Boolean(this.config.think),
      thinlLevel: Math.max(0, Math.min(3, Number(this.config.thinkLevel) || 0)),
    });
    emit("controller.ready", {
      socketId: this.socket.id,
      projectId: this.context.projectId,
      scriptId: this.context.scriptId,
      autoApprove: Boolean(this.config.autoApprove),
    });
  }

  installSocketHandlers() {
    this.socket.on("message", (message) => this.onMessage(message));
    this.socket.on("message:update", (update) => this.onMessageUpdate(update));
    this.socket.on("content:add", (event) => this.onContentAdd(event));
    this.socket.on("content:update", (event) => this.onContentUpdate(event));
    this.socket.on("getFlowData", async (_data, callback) => {
      try {
        await this.persistQueue;
        this.flowData = await this.fetchFlowData();
        callback?.(sanitizeFlowData(this.flowData));
      } catch (error) {
        emit("tool.error", { tool: "getFlowData", message: error.message });
        callback?.(sanitizeFlowData(this.flowData ?? {}));
      }
    });
    this.socket.on("addDeriveAsset", async (data, callback) => {
      try {
        this.flowData = await this.fetchFlowData();
        callback?.({ success: true, message: "衍生资产已同步" });
        emit("tool.complete", { tool: "addDeriveAsset", id: data?.id, assetsId: data?.assetsId });
      } catch (error) {
        callback?.({ error: error.message });
      }
    });
    this.socket.on("delDeriveAsset", async (data, callback) => {
      try {
        this.flowData = await this.fetchFlowData();
        callback?.({ success: true, message: "衍生资产已删除" });
        emit("tool.complete", { tool: "delDeriveAsset", id: data?.id, assetsId: data?.assetsId });
      } catch (error) {
        callback?.({ error: error.message });
      }
    });
    this.socket.on("generateDeriveAsset", async (data, callback) => {
      try {
        const ids = this.normalizeIds(data?.ids);
        const result = await this.api.post("/production/assets/batchGenerateAssetsImage", {
          assetIds: ids,
          projectId: this.context.projectId,
          scriptId: this.context.scriptId,
          concurrentCount: this.config.concurrentCount,
        });
        callback?.({ success: true, message: result });
        this.trackGeneration("assets", ids, "/production/assets/pollingImage");
      } catch (error) {
        callback?.({ error: error.message });
        this.recordGenerationFailure("assets", [], error.message);
      }
    });
    this.socket.on("generateStoryboard", async (data, callback) => {
      try {
        const ids = this.normalizeIds(data?.ids);
        const result = await this.api.post("/production/storyboard/batchGenerateImage", {
          storyboardIds: ids,
          projectId: this.context.projectId,
          scriptId: this.context.scriptId,
          concurrentCount: this.config.concurrentCount,
          compulsory: false,
        });
        callback?.({ success: true, message: result });
        this.trackGeneration("storyboard", ids, "/production/storyboard/pollingImage");
      } catch (error) {
        callback?.({ error: error.message });
        this.recordGenerationFailure("storyboard", [], error.message);
      }
    });
    this.socket.on("addStoryboard", async (data, callback) => {
      try {
        const item = {
          prompt: data?.prompt || "",
          duration: Number(data?.duration) || 0,
          track: String(data?.track || ""),
          state: "未生成",
          src: null,
          videoDesc: String(data?.videoDesc || ""),
          shouldGenerateImage:
            typeof data?.shouldGenerateImage === "boolean"
              ? Number(data.shouldGenerateImage)
              : String(data?.shouldGenerateImage).toLowerCase() === "true"
                ? 1
                : 0,
          associateAssetsIds: this.normalizeIds(data?.associateAssetsIds ?? []),
        };
        await this.api.post("/production/storyboard/batchAddStoryboardInfo", {
          data: [item],
          scriptId: this.context.scriptId,
          projectId: this.context.projectId,
        });
        this.flowData = await this.fetchFlowData();
        await this.saveFlowData(this.flowData);
        callback?.({ success: true, message: "分镜面板已写入" });
        emit("tool.complete", { tool: "addStoryboard", track: item.track, duration: item.duration });
      } catch (error) {
        callback?.({ error: error.message });
      }
    });
    this.socket.on("disconnect", (reason) => {
      emit("socket.disconnected", { reason });
      if (this.currentTurn) this.pauseTurn(`Socket 已断开: ${reason}`);
    });
    this.socket.on("connect_error", (error) => emit("socket.error", { message: error?.message ?? String(error) }));
  }

  normalizeIds(ids) {
    if (!Array.isArray(ids)) throw fail("ID 列表无效");
    const normalized = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (!normalized.length) throw fail("ID 列表不能为空");
    return normalized;
  }

  async fetchFlowData() {
    return await this.api.post("/production/getFlowData", {
      projectId: this.context.projectId,
      episodesId: this.context.scriptId,
    });
  }

  async saveFlowData(flowData) {
    await this.api.post("/production/saveFlowData", {
      projectId: this.context.projectId,
      episodesId: this.context.scriptId,
      data: flowData,
    });
  }

  onMessage(message) {
    const normalized = { ...message, content: new Map() };
    for (const content of message?.content ?? []) normalized.content.set(content.id, { ...content });
    this.messages.set(message.id, normalized);
    if (this.currentTurn) this.currentTurn.messageIds.add(message.id);
    this.touch();
    emit("message.started", { id: message.id, name: message.name, status: message.status });
  }

  onMessageUpdate(update) {
    const message = this.messages.get(update.id) ?? { id: update.id, content: new Map() };
    Object.assign(message, update);
    this.messages.set(update.id, message);
    this.touch();
    if (TERMINAL_STATUSES.has(update.status)) {
      emit("message.terminal", { id: update.id, name: message.name, status: update.status });
    }
  }

  onContentAdd(event) {
    const message = this.messages.get(event.messageId) ?? { id: event.messageId, content: new Map() };
    message.content.set(event.content.id, { ...event.content });
    this.messages.set(event.messageId, message);
    this.scanWorkspaceTags(message, event.content);
    this.touch();
  }

  onContentUpdate(event) {
    const message = this.messages.get(event.messageId) ?? { id: event.messageId, content: new Map() };
    const content = message.content.get(event.contentId) ?? { id: event.contentId, type: event.type, data: undefined };
    if (event.type) content.type = event.type;
    content.data = event.strategy === "append" ? appendValue(content.data, event.data) : mergeValue(content.data, event.data);
    if (event.status) content.status = event.status;
    message.content.set(event.contentId, content);
    this.messages.set(event.messageId, message);
    this.scanWorkspaceTags(message, content);
    this.touch();
  }

  scanWorkspaceTags(message, content) {
    if (message.name !== "执行导演" || !["text", "markdown"].includes(content.type) || typeof content.data !== "string") return;
    for (const tag of ["scriptPlan", "storyboardTable"]) {
      const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
      let match;
      while ((match = pattern.exec(content.data))) {
        const value = match[1].trim();
        if (!value) continue;
        const fingerprint = createHash("sha256").update(`${tag}\0${value}`).digest("hex");
        if (this.persistedTags.has(fingerprint)) continue;
        this.persistedTags.add(fingerprint);
        this.persistQueue = this.persistQueue
          .then(async () => {
            const flow = await this.fetchFlowData();
            flow[tag] = value;
            await this.saveFlowData(flow);
            this.flowData = flow;
            emit("workspace.persisted", { key: tag, characters: value.length });
          })
          .catch((error) => {
            this.recordGenerationFailure("workspace", [], `${tag} 写入失败: ${error.message}`);
            emit("workspace.error", { key: tag, message: error.message });
          });
      }
    }
  }

  touch() {
    this.eventVersion += 1;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (!this.currentTurn || !this.canSettle()) return;
    const version = this.eventVersion;
    this.quietTimer = setTimeout(() => this.settleTurn(version), this.config.quietPeriodMs);
  }

  canSettle() {
    if (!this.currentTurn || this.currentTurn.messageIds.size === 0 || this.generations.size > 0) return false;
    for (const id of this.currentTurn.messageIds) {
      const status = this.messages.get(id)?.status;
      if (!TERMINAL_STATUSES.has(status)) return false;
    }
    return true;
  }

  async settleTurn(version) {
    const turn = this.currentTurn;
    if (!turn || version !== this.eventVersion || !this.canSettle()) return;
    await this.persistQueue;
    if (turn !== this.currentTurn || version !== this.eventVersion || !this.canSettle()) return;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    const messages = [...turn.messageIds].map((id) => this.messages.get(id)).filter(Boolean);
    const text = stripWorkspaceXml(
      messages
        .flatMap((message) =>
          [...message.content.values()]
            .filter((content) => content.type === "text" || content.type === "markdown")
            .map((content) => (typeof content.data === "string" ? content.data : "")),
        )
        .join("\n"),
    );
    const result = {
      id: turn.id,
      source: turn.source,
      statuses: messages.map((message) => message.status),
      generationFailures: [...turn.generationFailures],
      text,
    };
    this.currentTurn = null;
    emit("turn.complete", result);
    if (!this.config.autoApprove) {
      emit("approval.required", { turnId: result.id, reason: "autoApprove 已关闭" });
      return;
    }
    const decision = classifyTurn(result, this.config, this.repairRounds);
    emit("approval.decision", { turnId: result.id, ...decision, prompt: undefined });
    if (decision.action === "repair") this.repairRounds += 1;
    if (decision.action === "approve") this.repairRounds = 0;
    if (["approve", "confirm", "repair"].includes(decision.action)) {
      setTimeout(() => {
        this.send(decision.prompt, `auto:${decision.action}`).catch((error) => emit("controller.error", { message: error.message }));
      }, 100);
    } else if (decision.action === "pause") {
      emit("approval.required", { turnId: result.id, reason: decision.reason, grade: decision.grade, failures: decision.failures });
    } else if (decision.action === "finish") {
      emit("workflow.finished", { turnId: result.id, reason: decision.reason });
    }
  }

  async send(content, source = "manual") {
    const prompt = String(content ?? "").trim();
    if (!prompt) throw fail("发送内容不能为空");
    if (!this.socket?.connected) throw fail("Socket 未连接");
    if (this.currentTurn) throw fail("Toonflow 正在运行；当前轮次完成前禁止发送新指令");
    if (this.generations.size) throw fail("后台生成任务仍在运行；完成前禁止发送新指令");
    const turn = {
      id: ++this.turnCounter,
      source,
      messageIds: new Set(),
      generationFailures: [],
      startedAt: Date.now(),
    };
    this.currentTurn = turn;
    this.socket.emit("chat", { content: prompt });
    emit("turn.sent", { id: turn.id, source, characters: prompt.length });
    this.turnTimer = setTimeout(() => {
      if (this.currentTurn === turn) this.pauseTurn(`轮次超过 ${this.config.turnTimeoutMs}ms 未结束`);
    }, this.config.turnTimeoutMs);
  }

  pauseTurn(reason) {
    if (!this.currentTurn) return;
    clearTimeout(this.turnTimer);
    const turnId = this.currentTurn.id;
    this.currentTurn = null;
    emit("approval.required", { turnId, reason });
  }

  recordGenerationFailure(kind, ids, message) {
    if (this.currentTurn) this.currentTurn.generationFailures.push({ kind, ids, message });
  }

  trackGeneration(kind, ids, pollingRoute) {
    const key = `${kind}:${Date.now()}:${ids.join(",")}`;
    const task = this.pollGeneration(kind, ids, pollingRoute)
      .catch((error) => {
        this.recordGenerationFailure(kind, ids, error.message);
        emit("generation.error", { kind, ids, message: error.message });
      })
      .finally(async () => {
        this.generations.delete(key);
        try {
          this.flowData = await this.fetchFlowData();
          await this.saveFlowData(this.flowData);
        } catch (error) {
          this.recordGenerationFailure(kind, ids, `生成结果同步失败: ${error.message}`);
        }
        this.touch();
      });
    this.generations.set(key, task);
    emit("generation.started", { kind, ids });
  }

  async pollGeneration(kind, ids, pollingRoute) {
    const remaining = new Set(ids);
    const deadline = Date.now() + this.config.generationTimeoutMs;
    const terminalRows = [];
    while (remaining.size) {
      if (Date.now() >= deadline) throw fail(`${kind} 生成轮询超时，未完成 ID: ${[...remaining].join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
      let rows;
      try {
        rows = (await this.api.post(pollingRoute, { ids: [...remaining] })) ?? [];
      } catch (error) {
        emit("generation.poll_retry", { kind, remaining: [...remaining], message: error.message });
        continue;
      }
      for (const row of rows) {
        const id = Number(row.id);
        if (!remaining.has(id)) continue;
        remaining.delete(id);
        terminalRows.push({ id, state: row.state, reason: row.errorReason ?? row.reason ?? "" });
      }
      emit("generation.progress", { kind, completed: ids.length - remaining.size, total: ids.length, remaining: [...remaining] });
    }
    const failures = terminalRows.filter((row) => /失败|error|failed/i.test(String(row.state)));
    if (failures.length) throw fail(`${kind} 生成失败: ${failures.map((row) => `${row.id}${row.reason ? `(${row.reason})` : ""}`).join(", ")}`);
    emit("generation.complete", { kind, results: terminalRows });
  }

  status() {
    emit("controller.status", {
      connected: Boolean(this.socket?.connected),
      activeTurn: this.currentTurn?.id ?? null,
      activeMessages: this.currentTurn ? [...this.currentTurn.messageIds] : [],
      generations: [...this.generations.keys()],
      repairRounds: this.repairRounds,
      autoApprove: Boolean(this.config.autoApprove),
    });
  }

  flowSummary() {
    const flow = this.flowData ?? {};
    emit("flow.summary", {
      scriptCharacters: String(flow.script ?? "").length,
      scriptPlanCharacters: String(flow.scriptPlan ?? "").length,
      storyboardTableCharacters: String(flow.storyboardTable ?? "").length,
      assets: flow.assets?.length ?? 0,
      storyboard: flow.storyboard?.length ?? 0,
    });
  }

  startConsole() {
    if (!process.stdin.isTTY) return;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "toonflow> " });
    this.rl.on("line", async (line) => {
      const [command, ...rest] = line.trim().split(/\s+/);
      const text = rest.join(" ");
      try {
        if (!command) {
          // no-op
        } else if (command === "start") {
          await this.send(this.config.startPrompt, "manual:start");
        } else if (command === "send") {
          await this.send(text, "manual:send");
        } else if (command === "approve") {
          await this.send(this.config.approvalPrompt, "manual:approve");
        } else if (command === "confirm") {
          await this.send(this.config.confirmPrompt, "manual:confirm");
        } else if (command === "repair") {
          await this.send(this.config.repairPrompt, "manual:repair");
        } else if (command === "status") {
          this.status();
        } else if (command === "flow") {
          this.flowSummary();
        } else if (command === "stop") {
          this.socket.emit("stop");
          emit("turn.stop_requested");
        } else if (command === "quit" || command === "exit") {
          await this.close();
          return;
        } else if (command === "help") {
          emit("console.help", { commands: ["start", "send <内容>", "approve", "confirm", "repair", "status", "flow", "stop", "quit"] });
        } else {
          emit("console.error", { message: `未知命令: ${command}` });
        }
      } catch (error) {
        emit("console.error", { message: error.message });
      }
      this.rl?.prompt();
    });
    this.rl.on("close", () => this.close());
    this.rl.prompt();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.quietTimer);
    clearTimeout(this.turnTimer);
    this.socket?.disconnect();
    this.rl?.close();
    emit("controller.closed");
    process.exitCode = 0;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = await loadConfig(args);
  const api = new ToonflowApi(config.baseUrl);
  await api.authenticate();
  if (args.list) {
    await listContexts(api);
    return;
  }
  const context = await resolveContext(api, config);
  const controller = new ToonflowController(api, context, config);
  await controller.initialize();
  if (args.probe) {
    controller.flowSummary();
    await controller.close();
    return;
  }
  process.on("SIGINT", () => controller.close());
  process.on("SIGTERM", () => controller.close());
  controller.startConsole();
  if (config.autoStart) await controller.send(config.startPrompt, "auto:start");
}

main().catch((error) => {
  emit("fatal", { message: error.message, cause: error.cause?.message });
  process.exitCode = 1;
});
