#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
  autoStart: false,
  ensureBackend: true,
  backendStartupTimeoutMs: 30 * 1000,
  stateFile: "user/tools/controller-state.json",
  autoAdvanceEpisodes: true,
  requireSevereIssueResolution: true,
  generateFinalVideoPrompts: false,
  finalPromptTimeoutMs: 30 * 60 * 1000,
  finalPromptPollIntervalMs: 5000,
  startPrompt: "从导演规划开始，严格按 Toonflow 自身的制作流程推进；每个需要用户确认的节点完成后等待审批。",
  nextEpisodeStartPrompt:
    "从导演规划开始，严格按 Toonflow 自身的完整制作流程推进当前新分集；每个需要用户确认的节点完成后等待审批，直到视频工作台全部轨道生成 Seedance 2.0 最终视频提示词。",
  approvalPrompt: "审核通过，继续 Toonflow 原生流程的下一阶段。",
  confirmPrompt: "确认。若当前节点要求选择生成范围，选择 Toonflow 当前清单中的全部项目；其余情况按 Toonflow 当前默认路线继续下一阶段。",
  repairPrompt:
    "确认修复。严格采用刚才 Toonflow 审核报告的问题清单与建议方案；单一方案按原建议执行，多选方案采用每项列出的第一个方案。不要增加新的问题或方案；完成后按 Toonflow 原规则重新审核。",
  severeRepairPrompt:
    "确认继续修复。问题清单中仍有“严重程度：严重”的审核项；请逐项严格采用各严重项后面对应的 Toonflow 原生建议方案完成修复。不要自行增加问题、标准或方案；完成后按 Toonflow 原规则重新审核，并输出新的问题清单、严重程度和建议方案。",
  quietPeriodMs: 4000,
  pollIntervalMs: 5000,
  generationTimeoutMs: 30 * 60 * 1000,
  turnTimeoutMs: 30 * 60 * 1000,
  concurrentCount: 5,
  maxRepairRounds: 2,
  maxNoEvidenceRetries: 1,
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
    ensureBackend: undefined,
    list: false,
    probe: false,
    finalPrompts: false,
    selfTest: false,
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
    } else if (arg === "--ensure-backend") {
      args.ensureBackend = true;
    } else if (arg === "--no-ensure-backend") {
      args.ensureBackend = false;
    } else if (arg === "--list") {
      args.list = true;
    } else if (arg === "--probe") {
      args.probe = true;
    } else if (arg === "--final-prompts") {
      args.finalPrompts = true;
    } else if (arg === "--self-test") {
      args.selfTest = true;
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
  process.stdout.write(
    `  node user/tools/toonflow-controller.mjs --config <配置文件> [--start] [--auto|--no-auto] [--ensure-backend|--no-ensure-backend]\n`,
  );
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --config <配置文件> --list\n`);
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --config <配置文件> --probe\n\n`);
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --config <配置文件> --final-prompts\n\n`);
  process.stdout.write(`  node user/tools/toonflow-controller.mjs --self-test\n\n`);
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
    ensureBackend: args.ensureBackend ?? config.ensureBackend ?? DEFAULTS.ensureBackend,
  };
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULTS.baseUrl)
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backendIsReady(baseUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/`, {
      method: "GET",
      signal: controller.signal,
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isLocalBackendUrl(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return localHosts.has(url.hostname) && port === "10588";
}

async function ensureBackend(config) {
  if (await backendIsReady(config.baseUrl)) {
    emit("backend.ready", { source: "existing", baseUrl: normalizeBaseUrl(config.baseUrl) });
    return;
  }
  if (!config.ensureBackend) {
    throw fail(`Toonflow 后端未运行: ${normalizeBaseUrl(config.baseUrl)}`);
  }
  if (!isLocalBackendUrl(config.baseUrl)) {
    throw fail("自动启动仅支持本机 http://localhost:10588；远程地址必须由用户自行启动");
  }

  const entryPath = path.join(repoRoot, "data", "serve", "app.js");
  await fs.access(entryPath);
  const child = spawn(process.execPath, [entryPath], {
    cwd: repoRoot,
    detached: true,
    env: { ...process.env, NODE_ENV: "prod" },
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();
  emit("backend.started", { pid: child.pid, entry: "data/serve/app.js" });

  const deadline = Date.now() + Number(config.backendStartupTimeoutMs || DEFAULTS.backendStartupTimeoutMs);
  while (Date.now() < deadline) {
    if (spawnError) throw fail("Toonflow 后端启动失败", spawnError);
    if (child.exitCode !== null) throw fail(`Toonflow 后端启动后退出，退出码 ${child.exitCode}`);
    if (await backendIsReady(config.baseUrl)) {
      emit("backend.ready", { source: "started", baseUrl: normalizeBaseUrl(config.baseUrl), pid: child.pid });
      return;
    }
    await wait(500);
  }
  throw fail(`等待 Toonflow 后端启动超时: ${normalizeBaseUrl(config.baseUrl)}`);
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
    videoModel: project.videoModel,
    videoMode: project.mode,
  };
  emit("context.ready", context);
  return context;
}

function contextFromProjectScript(project, script) {
  return {
    projectId: Number(project.id),
    projectName: itemName(project),
    scriptId: Number(script.id),
    scriptName: itemName(script),
    videoModel: project.videoModel,
    videoMode: project.mode,
  };
}

function nextScriptInOrder(scripts, currentScriptId) {
  const index = scripts.findIndex((script) => Number(script.id) === Number(currentScriptId));
  if (index < 0) throw fail(`当前分集 ID ${currentScriptId} 已不在项目分集列表中`);
  return scripts[index + 1] ?? null;
}

async function resolveNextContext(api, currentContext) {
  const projects = (await api.post("/project/getProject", {})) ?? [];
  const project = pickByIdOrName(projects, currentContext.projectId, null, "项目");
  const scripts = (await api.post("/script/getScrptApi", { projectId: Number(project.id) })) ?? [];
  const script = nextScriptInOrder(scripts, currentContext.scriptId);
  if (!script) return null;
  return contextFromProjectScript(project, script);
}

function stateFileForEpisode(config, context, isInitialEpisode) {
  const configured = String(config.stateFile || DEFAULTS.stateFile);
  if (configured.includes("{scriptId}") || configured.includes("{projectId}")) {
    return configured.replaceAll("{projectId}", String(context.projectId)).replaceAll("{scriptId}", String(context.scriptId));
  }
  if (isInitialEpisode) return configured;
  const extension = path.extname(configured);
  const stem = extension ? configured.slice(0, -extension.length) : configured;
  return `${stem}.script-${context.scriptId}${extension}`;
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

function hashValue(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

const WORKSPACE_MIN_CHARACTERS = { scriptPlan: 200, storyboardTable: 200 };
const WORKSPACE_PLACEHOLDER_PATTERN = /^(?:\.{3,}|…+|\{\s*\}|\[\s*\]|null|undefined|待补充|省略)$/i;
const EXECUTION_PROMISE_PATTERN = /(?:将|现在|立即|接下来).{0,24}(?:派发|开始|进入|执行)|让我.{0,24}(?:派发|执行)|请前往.{0,16}工作台/;

function workspaceValueIssue(tag, incoming, current = "") {
  const value = String(incoming ?? "").trim();
  const previous = String(current ?? "").trim();
  const minimum = Number(WORKSPACE_MIN_CHARACTERS[tag]) || 100;
  if (!value) return `${tag} 为空`;
  if (WORKSPACE_PLACEHOLDER_PATTERN.test(value)) return `${tag} 是占位内容`;
  if (previous.length >= minimum * 5 && value.length < minimum && value.length < previous.length * 0.1) {
    return `${tag} 从 ${previous.length} 字异常缩短为 ${value.length} 字`;
  }
  return null;
}

function phaseKey(phase) {
  return String(phase || "unassigned");
}

function phaseCounter(state, mapName, phase, legacyName) {
  const stored = state?.[mapName]?.[phaseKey(phase)];
  if (Number.isFinite(Number(stored))) return Math.max(0, Number(stored));
  if (phase === state?.currentPhase && Number.isFinite(Number(state?.[legacyName]))) return Math.max(0, Number(state[legacyName]));
  return 0;
}

function hasActionableRepairAdvice(text) {
  return /问题清单|建议方案|建议修复|修复方案|方案\s*[A-C]|按.{0,20}修复/.test(String(text ?? ""));
}

function problemListSection(text) {
  const source = String(text ?? "");
  const heading = /问题清单\s*[:：]?/i.exec(source);
  if (!heading) return "";
  const section = source.slice(heading.index + heading[0].length);
  const endHeading = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:审核结论|最终结论|总体评价|综合评价|评分|评级|等级)\s*[:：]/im.exec(section);
  return endHeading ? section.slice(0, endHeading.index) : section;
}

function analyzeSevereIssues(text) {
  const section = problemListSection(text);
  const severityPattern = /(?:\*{0,2})严重程度(?:\*{0,2})\s*[:：]\s*(?:\*{0,2})严重(?:\*{0,2})(?=$|[\s，,；;。])/g;
  const matches = [...section.matchAll(severityPattern)];
  const issues = matches.map((match, index) => {
    const following = section.slice(match.index + match[0].length, matches[index + 1]?.index ?? section.length);
    const advice = /(?:\*{0,2})建议方案(?:\*{0,2})\s*[:：]\s*(?!无(?:\s|$)|未提供|缺失)(\S[\s\S]*)/i.exec(following);
    return { hasAdvice: Boolean(advice), adviceCharacters: advice ? advice[1].trim().length : 0 };
  });
  return {
    count: issues.length,
    missingAdvice: issues.filter((issue) => !issue.hasAdvice).length,
    issues,
  };
}

function executionRetryPrompt(phase, rejections = []) {
  if (rejections.length) {
    const tags = [...new Set(rejections.map((item) => item.tag))].join("、");
    return `检测到 ${tags} 的写入内容是占位符或异常短文本，已拒绝覆盖原有效数据。请仅恢复当前节点：实际调用执行层重新输出完整的 ${tags} 标签内容并写回工作区；不要只回复将要执行，不要重跑或修改已经验收的其他阶段。`;
  }
  return `当前${phase ? ` ${phase} ` : ""}节点只收到承诺性回复，但没有观察到工具事件、工作区变化或后台任务。请现在实际调用执行层和该节点既定工具完成当前节点；不要只说明“将派发”或让用户前往其他页面，也不要重跑已经验收的阶段。`;
}

function buildFlowSnapshot(flowData) {
  const flow = flowData ?? {};
  const derives = (flow.assets ?? [])
    .flatMap((asset) => (asset.derive ?? []).map((derive) => ({ id: Number(derive.id), state: String(derive.state ?? "") })))
    .filter((item) => Number.isFinite(item.id))
    .sort((a, b) => a.id - b.id);
  const storyboard = (flow.storyboard ?? [])
    .map((item) => ({
      id: Number(item.id),
      promptHash: hashValue(item.prompt),
      promptCharacters: String(item.prompt ?? "").trim().length,
      videoDescHash: hashValue(item.videoDesc),
      videoDescCharacters: String(item.videoDesc ?? "").trim().length,
      shouldGenerateImage: Number(item.shouldGenerateImage) === 1 ? 1 : 0,
      state: String(item.state ?? ""),
    }))
    .filter((item) => Number.isFinite(item.id))
    .sort((a, b) => a.id - b.id);
  const snapshot = {
    scriptPlanHash: hashValue(flow.scriptPlan),
    scriptPlanCharacters: String(flow.scriptPlan ?? "").length,
    storyboardTableHash: hashValue(flow.storyboardTable),
    storyboardTableCharacters: String(flow.storyboardTable ?? "").length,
    derives,
    storyboard,
  };
  return { ...snapshot, digest: hashValue(JSON.stringify(snapshot)) };
}

function diffFlowSnapshots(before, after) {
  const beforeDerives = new Map((before?.derives ?? []).map((item) => [item.id, item]));
  const afterDerives = new Map((after?.derives ?? []).map((item) => [item.id, item]));
  const beforeStoryboard = new Map((before?.storyboard ?? []).map((item) => [item.id, item]));
  const afterStoryboard = new Map((after?.storyboard ?? []).map((item) => [item.id, item]));
  return {
    scriptPlanChanged: before?.scriptPlanHash !== after?.scriptPlanHash,
    storyboardTableChanged: before?.storyboardTableHash !== after?.storyboardTableHash,
    deriveAdded: [...afterDerives.keys()].filter((id) => !beforeDerives.has(id)),
    deriveRemoved: [...beforeDerives.keys()].filter((id) => !afterDerives.has(id)),
    deriveStateChanged: [...afterDerives.values()].filter((item) => beforeDerives.has(item.id) && beforeDerives.get(item.id).state !== item.state),
    storyboardAdded: [...afterStoryboard.values()].filter((item) => !beforeStoryboard.has(item.id)),
    storyboardRemoved: [...beforeStoryboard.keys()].filter((id) => !afterStoryboard.has(id)),
    storyboardChanged: [...afterStoryboard.values()].filter((item) => {
      const previous = beforeStoryboard.get(item.id);
      return previous && JSON.stringify(previous) !== JSON.stringify(item);
    }),
  };
}

function detectWorkflowEvidence(turn, beforeSnapshot, afterSnapshot, state) {
  const diff = diffFlowSnapshots(beforeSnapshot, afterSnapshot);
  const events = turn.toolEvents ?? [];
  const hasTool = (tool) => events.some((event) => event.tool === tool);
  const hasGeneration = (kind) => events.some((event) => event.tool === "generation.complete" && event.kind === kind);

  if (hasGeneration("storyboard")) return { phase: "stage6", kind: "generation", diff };
  if (diff.storyboardAdded.length || hasTool("addStoryboard")) {
    const added = diff.storyboardAdded.length
      ? diff.storyboardAdded
      : events.filter((event) => event.tool === "addStoryboard");
    const noImages = added.length > 0 && added.every((item) => Number(item.shouldGenerateImage) === 0);
    return { phase: "stage5", kind: "workspace", terminalNoImages: noImages, diff };
  }
  if (diff.storyboardTableChanged || hasTool("storyboardTable")) return { phase: "stage4", kind: "workspace", diff };
  if (diff.deriveStateChanged.length || hasGeneration("assets")) return { phase: "stage3", kind: "generation", diff };
  if (diff.deriveAdded.length || diff.deriveRemoved.length || hasTool("addDeriveAsset") || hasTool("delDeriveAsset")) {
    return { phase: "stage2", kind: "workspace", diff };
  }
  if (diff.scriptPlanChanged || hasTool("scriptPlan")) return { phase: "stage1", kind: "workspace", diff };

  const grade = gradeFromText(turn.text);
  if (grade && state?.currentPhase) return { phase: state.currentPhase, kind: "review", diff };
  return null;
}

function gradeDecision(grade, config, repairRounds, text) {
  const severe = config.requireSevereIssueResolution === false ? { count: 0, missingAdvice: 0 } : analyzeSevereIssues(text);
  if (grade && "AB".includes(grade) && severe.count > 0) {
    if (severe.missingAdvice > 0) {
      return {
        action: "pause",
        grade,
        severeIssues: severe.count,
        reason: `问题清单仍有 ${severe.count} 个严重项，其中 ${severe.missingAdvice} 个缺少可关联的 Toonflow 原生建议方案`,
      };
    }
    const cycleSize = Math.max(1, Number(config.maxRepairRounds) || 1);
    return {
      action: "repair",
      grade,
      severeIssues: severe.count,
      prompt: config.severeRepairPrompt || DEFAULTS.severeRepairPrompt,
      resetRepairCycle: repairRounds >= cycleSize,
      reason: `评分为 ${grade}，但问题清单仍有 ${severe.count} 个“严重程度：严重”的审核项，必须按对应建议方案继续修复`,
    };
  }
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
    if (!hasActionableRepairAdvice(text)) {
      return { action: "pause", grade, reason: `${grade} 级审核缺少明确问题清单或原生修复建议` };
    }
    const cycleSize = Math.max(1, Number(config.maxRepairRounds) || 1);
    return {
      action: "repair",
      grade,
      prompt: config.repairPrompt,
      resetRepairCycle: repairRounds >= cycleSize,
      reason: repairRounds >= cycleSize ? `已完成 ${cycleSize} 轮本地修复计数；原生建议仍明确，重置当前节点计数并继续修复` : undefined,
    };
  }
  return null;
}

function classifyTurn(turn, config, state, beforeSnapshot, afterSnapshot) {
  const text = turn.text;
  if (turn.statuses.some((status) => status === "error" || status === "stop")) {
    return { action: "pause", reason: `消息终态为 ${turn.statuses.join(",")}` };
  }
  if (turn.generationFailures.length) {
    return { action: "pause", reason: "后台生成存在失败项", failures: turn.generationFailures };
  }
  const evidence = detectWorkflowEvidence(turn, beforeSnapshot, afterSnapshot, state);
  if (!evidence) {
    const retries = phaseCounter(state, "continuationRetriesByPhase", state?.currentPhase, "continuationRetries");
    const maxRetries = Math.max(0, Number(config.maxNoEvidenceRetries) || 0);
    const rejections = turn.workspaceRejections ?? [];
    if ((rejections.length || EXECUTION_PROMISE_PATTERN.test(text)) && retries < maxRetries) {
      return {
        action: "retry",
        phase: state?.currentPhase ?? null,
        prompt: executionRetryPrompt(state?.currentPhase, rejections),
        reason: rejections.length ? "关键工作区字段写入被完整性保护拒绝，自动要求执行层恢复" : "仅收到执行承诺但没有完成证据，自动续催当前节点",
      };
    }
    return {
      action: "pause",
      reason: rejections.length
        ? "关键工作区字段连续返回无效内容，已达到自动恢复次数"
        : "未观察到工具事件或工作区数据变化；保持静默，不自动审批",
    };
  }

  const recoveryTags = Array.isArray(state?.workspaceRecoveryTags) ? state.workspaceRecoveryTags : [];
  const recoveredTools = new Set((turn.toolEvents ?? []).map((event) => event.tool));
  if (
    state?.workspaceRecoveryPhase &&
    recoveryTags.length &&
    recoveryTags.every((tag) => recoveredTools.has(tag)) &&
    evidence.phase !== state.workspaceRecoveryPhase
  ) {
    return {
      action: "retry",
      phase: state.workspaceRecoveryPhase,
      prompt: executionRetryPrompt(state.workspaceRecoveryPhase),
      reason: "关键字段已恢复，返回异常发生前的节点继续执行",
      workspaceRecoveryCompleted: true,
    };
  }

  const grade = gradeFromText(text);

  if (evidence.phase === "stage6") return { action: "finish", phase: evidence.phase, reason: "阶段6后台生成已完成" };
  if (evidence.phase === "stage5" && evidence.terminalNoImages) {
    return config.generateFinalVideoPrompts
      ? { action: "generate_prompts", phase: evidence.phase, reason: "阶段5已写入且全部不出图，进入最终视频提示词生成" }
      : { action: "finish", phase: evidence.phase, reason: "阶段5已写入且全部不出图，流程到达终点" };
  }

  const repairRounds = phaseCounter(state, "repairRoundsByPhase", evidence.phase, "repairRounds");
  const scored = gradeDecision(grade, config, repairRounds, text);
  if (scored) return { ...scored, phase: evidence.phase };
  if (evidence.phase === "stage4") {
    return { action: "pause", phase: evidence.phase, reason: "阶段4数据已变化，但尚未收到 Toonflow 原生评分" };
  }
  return {
    action: "confirm",
    phase: evidence.phase,
    reason: `${evidence.phase} 已由工具事件和工作区数据变化确认完成`,
    prompt: config.confirmPrompt,
  };
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class ToonflowController {
  constructor(api, context, config, onEpisodeFinished = null) {
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
    this.rejectedTags = new Set();
    this.generations = new Map();
    this.statePath = this.resolveStatePath();
    this.state = {
      version: 2,
      projectId: context.projectId,
      scriptId: context.scriptId,
      currentPhase: null,
      repairRounds: Math.max(0, Number(config.initialRepairRounds) || 0),
      repairRoundsByPhase: {},
      continuationRetries: 0,
      continuationRetriesByPhase: {},
      workspaceRecoveryPhase: null,
      workspaceRecoveryTags: [],
      approvedDecisionKeys: [],
      lastSnapshot: null,
      pid: null,
      updatedAt: null,
    };
    this.closed = false;
    this.rl = null;
    this.onEpisodeFinished = onEpisodeFinished;
  }

  async initialize() {
    this.flowData = await this.fetchFlowData();
    await this.loadState();
    if (this.state.pid && this.state.pid !== process.pid && processIsRunning(Number(this.state.pid))) {
      throw fail(`该项目已有控制器实例在运行，PID ${this.state.pid}`);
    }
    this.state.pid = process.pid;
    this.state.lastSnapshot = buildFlowSnapshot(this.flowData);
    await this.saveState();
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
      stateFile: this.statePath,
    });
    emit("workflow.progress", { phase: this.state.currentPhase, status: "monitoring", message: "Codex 监控轨已连接" });
  }

  resolveStatePath() {
    const configured = String(this.config.stateFile || DEFAULTS.stateFile);
    const resolved = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured);
    const userRoot = path.resolve(repoRoot, "user");
    if (resolved !== userRoot && !resolved.startsWith(`${userRoot}${path.sep}`)) {
      throw fail(`stateFile 必须位于用户定义层 user/ 内: ${resolved}`);
    }
    return resolved;
  }

  async loadState() {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") emit("state.warning", { message: `状态文件读取失败，将使用新状态: ${error.message}` });
      return;
    }
    if (Number(saved.projectId) !== this.context.projectId || Number(saved.scriptId) !== this.context.scriptId) {
      emit("state.warning", { message: "状态文件属于其他项目或分集，已忽略" });
      return;
    }
    this.state = {
      ...this.state,
      ...saved,
      version: 2,
      repairRounds: Math.max(0, Number(saved.repairRounds) || 0),
      repairRoundsByPhase: saved.repairRoundsByPhase && typeof saved.repairRoundsByPhase === "object" ? saved.repairRoundsByPhase : {},
      continuationRetries: Math.max(0, Number(saved.continuationRetries) || 0),
      continuationRetriesByPhase:
        saved.continuationRetriesByPhase && typeof saved.continuationRetriesByPhase === "object"
          ? saved.continuationRetriesByPhase
          : {},
      workspaceRecoveryPhase: saved.workspaceRecoveryPhase || null,
      workspaceRecoveryTags: Array.isArray(saved.workspaceRecoveryTags) ? saved.workspaceRecoveryTags : [],
      approvedDecisionKeys: Array.isArray(saved.approvedDecisionKeys) ? saved.approvedDecisionKeys.slice(-100) : [],
    };
    const currentKey = phaseKey(this.state.currentPhase);
    if (!Number.isFinite(Number(this.state.repairRoundsByPhase[currentKey]))) {
      this.state.repairRoundsByPhase[currentKey] = this.state.repairRounds;
    }
    if (!Number.isFinite(Number(this.state.continuationRetriesByPhase[currentKey]))) {
      this.state.continuationRetriesByPhase[currentKey] = this.state.continuationRetries;
    }
    emit("state.loaded", {
      phase: this.state.currentPhase,
      repairRounds: this.state.repairRounds,
      continuationRetries: this.state.continuationRetries,
      approvedDecisions: this.state.approvedDecisionKeys.length,
    });
  }

  async saveState() {
    this.state.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.statePath);
  }

  setRepairRounds(phase, value) {
    const normalized = Math.max(0, Number(value) || 0);
    this.state.repairRoundsByPhase ??= {};
    this.state.repairRoundsByPhase[phaseKey(phase)] = normalized;
    if (phase === this.state.currentPhase) this.state.repairRounds = normalized;
  }

  setContinuationRetries(phase, value) {
    const normalized = Math.max(0, Number(value) || 0);
    this.state.continuationRetriesByPhase ??= {};
    this.state.continuationRetriesByPhase[phaseKey(phase)] = normalized;
    if (phase === this.state.currentPhase) this.state.continuationRetries = normalized;
  }

  enterPhase(phase) {
    if (!phase || phase === this.state.currentPhase) return;
    const nextRepairRounds = Math.max(0, Number(this.state.repairRoundsByPhase?.[phaseKey(phase)]) || 0);
    const nextContinuationRetries = Math.max(0, Number(this.state.continuationRetriesByPhase?.[phaseKey(phase)]) || 0);
    this.state.currentPhase = phase;
    this.setRepairRounds(phase, nextRepairRounds);
    this.setContinuationRetries(phase, nextContinuationRetries);
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
        this.recordToolEvent({ tool: "addDeriveAsset", id: data?.id, assetsId: data?.assetsId });
        emit("tool.complete", { tool: "addDeriveAsset", id: data?.id, assetsId: data?.assetsId });
      } catch (error) {
        callback?.({ error: error.message });
      }
    });
    this.socket.on("delDeriveAsset", async (data, callback) => {
      try {
        this.flowData = await this.fetchFlowData();
        callback?.({ success: true, message: "衍生资产已删除" });
        this.recordToolEvent({ tool: "delDeriveAsset", id: data?.id, assetsId: data?.assetsId });
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
        const ids = this.normalizeIds(data?.ids, { allowEmpty: true });
        if (!ids.length) {
          const message = "未提供分镜 ID；当前调用已跳过，未启动分镜图生成";
          callback?.({ success: true, skipped: true, message });
          emit("generation.skipped", { kind: "storyboard", ids, reason: "empty_ids" });
          return;
        }
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
        const event = {
          tool: "addStoryboard",
          track: item.track,
          duration: item.duration,
          shouldGenerateImage: item.shouldGenerateImage,
          promptCharacters: item.prompt.trim().length,
        };
        this.recordToolEvent(event);
        emit("tool.complete", event);
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

  normalizeIds(ids, { allowEmpty = false } = {}) {
    if (!Array.isArray(ids)) throw fail("ID 列表无效");
    const normalized = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (!normalized.length && !allowEmpty) throw fail("ID 列表不能为空");
    return normalized;
  }

  recordToolEvent(event) {
    if (this.currentTurn) this.currentTurn.toolEvents.push({ ...event, time: new Date().toISOString() });
    emit("workflow.progress", {
      phase: this.state.currentPhase,
      status: "tool_event",
      tool: event.tool,
      message: `已观察到 Toonflow 工具事件: ${event.tool}`,
    });
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
        if (this.persistedTags.has(fingerprint) || this.rejectedTags.has(fingerprint)) continue;
        this.persistQueue = this.persistQueue
          .then(async () => {
            const flow = await this.fetchFlowData();
            const issue = workspaceValueIssue(tag, value, flow[tag]);
            if (issue) {
              this.rejectedTags.add(fingerprint);
              const rejection = { tag, characters: value.length, previousCharacters: String(flow[tag] ?? "").length, reason: issue };
              if (this.currentTurn) this.currentTurn.workspaceRejections.push(rejection);
              emit("workspace.rejected", rejection);
              return;
            }
            this.persistedTags.add(fingerprint);
            flow[tag] = value;
            await this.saveFlowData(flow);
            this.flowData = flow;
            this.recordToolEvent({ tool: tag, characters: value.length });
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
    this.flowData = await this.fetchFlowData();
    const afterSnapshot = buildFlowSnapshot(this.flowData);
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
      toolEvents: [...turn.toolEvents],
      workspaceRejections: [...turn.workspaceRejections],
      text,
    };
    this.currentTurn = null;
    emit("turn.complete", result);
    if (!this.config.autoApprove) {
      emit("approval.required", { turnId: result.id, reason: "autoApprove 已关闭" });
      return;
    }
    const decision = classifyTurn(result, this.config, this.state, turn.beforeSnapshot, afterSnapshot);
    emit("approval.decision", { turnId: result.id, ...decision, prompt: undefined });
    this.enterPhase(decision.phase);
    const activePhase = this.state.currentPhase;
    const managedActions = ["approve", "confirm", "repair", "retry"];
    const decisionKey = hashValue(
      JSON.stringify({ phase: decision.phase, action: decision.action, grade: decision.grade, snapshot: afterSnapshot.digest }),
    );
    if (managedActions.includes(decision.action) && this.state.approvedDecisionKeys.includes(decisionKey)) {
      this.state.lastSnapshot = afterSnapshot;
      await this.saveState();
      emit("approval.duplicate_skipped", { turnId: result.id, phase: decision.phase, action: decision.action });
      emit("approval.required", { turnId: result.id, reason: "同一节点已经审批过；保持静默，等待真实状态变化" });
      return;
    }
    if (decision.action === "repair") {
      if (decision.resetRepairCycle) this.setRepairRounds(activePhase, 0);
      this.setRepairRounds(activePhase, phaseCounter(this.state, "repairRoundsByPhase", activePhase, "repairRounds") + 1);
    }
    if (decision.action === "approve") this.setRepairRounds(activePhase, 0);
    if (decision.action === "retry") {
      if (result.workspaceRejections.length) {
        this.state.workspaceRecoveryPhase = activePhase;
        this.state.workspaceRecoveryTags = [...new Set(result.workspaceRejections.map((item) => item.tag))];
      }
      if (decision.workspaceRecoveryCompleted) {
        this.state.workspaceRecoveryPhase = null;
        this.state.workspaceRecoveryTags = [];
      }
      this.setContinuationRetries(
        activePhase,
        phaseCounter(this.state, "continuationRetriesByPhase", activePhase, "continuationRetries") + 1,
      );
    } else if (decision.action !== "pause") {
      this.setContinuationRetries(activePhase, 0);
    }
    if (managedActions.includes(decision.action)) {
      this.state.approvedDecisionKeys.push(decisionKey);
      this.state.approvedDecisionKeys = this.state.approvedDecisionKeys.slice(-100);
    }
    if (decision.action === "finish") this.enterPhase("finished");
    if (decision.action === "generate_prompts") this.enterPhase("stage5.5");
    this.state.lastSnapshot = afterSnapshot;
    await this.saveState();
    emit("workflow.progress", {
      phase: this.state.currentPhase,
      status: decision.action,
      grade: decision.grade,
      message: decision.reason,
    });
    if (managedActions.includes(decision.action)) {
      setTimeout(() => {
        this.send(decision.prompt, `auto:${decision.action}`).catch((error) => emit("controller.error", { message: error.message }));
      }, 100);
    } else if (decision.action === "pause") {
      emit("approval.required", { turnId: result.id, reason: decision.reason, grade: decision.grade, failures: decision.failures });
    } else if (decision.action === "finish") {
      emit("workflow.finished", { turnId: result.id, reason: decision.reason });
      await this.close();
      await this.advanceAfterEpisode();
    } else if (decision.action === "generate_prompts") {
      try {
        const rows = await this.generateFinalVideoPrompts();
        this.enterPhase("finished");
        await this.saveState();
        emit("workflow.finished", {
          turnId: result.id,
          reason: "Seedance 2.0 最终视频提示词已生成",
          prompts: rows.map((row) => ({ id: row.id, characters: String(row.prompt ?? "").length })),
        });
        await this.close();
        await this.advanceAfterEpisode();
      } catch (error) {
        emit("approval.required", { turnId: result.id, reason: `最终视频提示词生成失败: ${error.message}` });
      }
    }
  }

  async send(content, source = "manual") {
    const prompt = String(content ?? "").trim();
    if (!prompt) throw fail("发送内容不能为空");
    if (!this.socket?.connected) throw fail("Socket 未连接");
    if (this.currentTurn) throw fail("Toonflow 正在运行；当前轮次完成前禁止发送新指令");
    if (this.generations.size) throw fail("后台生成任务仍在运行；完成前禁止发送新指令");
    await this.persistQueue;
    this.flowData = await this.fetchFlowData();
    const turn = {
      id: ++this.turnCounter,
      source,
      messageIds: new Set(),
      generationFailures: [],
      toolEvents: [],
      workspaceRejections: [],
      beforeSnapshot: buildFlowSnapshot(this.flowData),
      startedAt: Date.now(),
    };
    this.currentTurn = turn;
    this.socket.emit("chat", { content: prompt });
    emit("turn.sent", { id: turn.id, source, characters: prompt.length });
    emit("workflow.progress", {
      phase: this.state.currentPhase,
      status: "toonflow_running",
      turnId: turn.id,
      message: "Toonflow 执行轨正在运行，Codex 监控轨保持只读监听",
    });
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
      .then((rows) => {
        this.recordToolEvent({ tool: "generation.complete", kind, ids, results: rows });
        return rows;
      })
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
    return terminalRows;
  }

  async validateFinalWorkflow(rows) {
    const flow = await this.fetchFlowData();
    const issues = [];
    for (const tag of ["scriptPlan", "storyboardTable"]) {
      const issue = workspaceValueIssue(tag, flow[tag]);
      if (issue || String(flow[tag] ?? "").trim().length < WORKSPACE_MIN_CHARACTERS[tag]) {
        issues.push(issue || `${tag} 内容过短`);
      }
    }
    const storyboard = Array.isArray(flow.storyboard) ? flow.storyboard : [];
    if (!storyboard.length) issues.push("分镜面板轨道数为 0");
    const emptyVideoDesc = storyboard.filter((item) => !String(item.videoDesc ?? "").trim());
    if (emptyVideoDesc.length) issues.push(`${emptyVideoDesc.length} 条分镜缺少 videoDesc`);
    const imageRequests = storyboard.filter((item) => Number(item.shouldGenerateImage) === 1);
    if (imageRequests.length) issues.push(`${imageRequests.length} 条分镜仍请求生成分镜图`);
    if (rows.length !== storyboard.length) issues.push(`最终提示词轨道数 ${rows.length} 与分镜轨道数 ${storyboard.length} 不一致`);
    const incompletePrompts = rows.filter(
      (row) =>
        !String(row?.prompt ?? "").trim() ||
        /失败|error|failed|生成中|pending/i.test(String(row?.state ?? "")),
    );
    if (incompletePrompts.length) issues.push(`${incompletePrompts.length} 条最终提示词为空、失败或仍在生成`);
    if (issues.length) throw fail(`最终数据验收未通过: ${issues.join("；")}`);
    this.flowData = flow;
    this.state.lastSnapshot = buildFlowSnapshot(flow);
    emit("workflow.acceptance", {
      scriptPlanCharacters: String(flow.scriptPlan).length,
      storyboardTableCharacters: String(flow.storyboardTable).length,
      storyboardTracks: storyboard.length,
      finalPrompts: rows.length,
      emptyVideoDesc: 0,
      imageRequests: 0,
      incompletePrompts: 0,
    });
  }

  async generateFinalVideoPrompts() {
    const model = String(this.context.videoModel ?? "");
    if (!/seedance[\s._-]*2(?:[.\s_-]*0)?/i.test(model)) {
      throw fail(`当前视频模型不是 Seedance 2.0: ${model || "未配置"}`);
    }
    const workbench = await this.api.post("/production/workbench/getGenerateData", {
      projectId: this.context.projectId,
      scriptId: this.context.scriptId,
    });
    const availableTracks = (workbench?.trackList ?? []).filter((track) => Number.isFinite(Number(track.id)));
    const isReady = (track) =>
      String(track?.prompt ?? "").trim() && !/失败|error|failed|生成中|pending/i.test(String(track?.state ?? ""));
    const existing = availableTracks.filter(isReady);
    const existingById = new Map(
      existing.map((track) => [Number(track.id), { id: Number(track.id), state: track.state, prompt: track.prompt, existing: true }]),
    );
    if (availableTracks.length && existing.length === availableTracks.length) {
      const rows = availableTracks.map((track) => existingById.get(Number(track.id)));
      await this.validateFinalWorkflow(rows);
      emit("final_prompt.skipped", { reason: "all_tracks_already_have_prompts", tracks: rows.map((row) => row.id) });
      return rows;
    }
    const trackData = availableTracks
      .filter((track) => !isReady(track))
      .map((track) => {
        const seen = new Set();
        const info = (track.medias ?? [])
          .filter((item) => Number.isFinite(Number(item.id)) && ["storyboard", "assets"].includes(String(item.sources)))
          .map((item) => ({ id: Number(item.id), sources: String(item.sources) }))
          .filter((item) => {
            const key = `${item.sources}:${item.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        return { trackId: Number(track.id), info };
      })
      .filter((track) => track.info.length > 0);
    if (!trackData.length) throw fail("视频工作台中没有可生成提示词的轨道数据");

    const mode =
      typeof this.context.videoMode === "string" ? this.context.videoMode : JSON.stringify(this.context.videoMode ?? "");
    emit("final_prompt.started", { model, tracks: trackData.map((track) => track.trackId), mode });
    emit("workflow.progress", {
      phase: "stage5.5",
      status: "generating_final_prompts",
      completed: 0,
      total: trackData.length,
      message: "正在通过 Toonflow 官方工作台接口生成 Seedance 2.0 最终视频提示词",
    });
    await this.api.post("/production/workbench/batchGeneratePrompt", {
      projectId: this.context.projectId,
      trackData,
      mode,
      model,
      concurrentCount: this.config.concurrentCount,
    });

    const trackIds = trackData.map((track) => track.trackId);
    const completed = new Map();
    const deadline = Date.now() + Number(this.config.finalPromptTimeoutMs || DEFAULTS.finalPromptTimeoutMs);
    while (completed.size < trackIds.length) {
      if (Date.now() >= deadline) {
        const remaining = trackIds.filter((id) => !completed.has(id));
        throw fail(`最终视频提示词生成超时，未完成轨道: ${remaining.join(",")}`);
      }
      await wait(Number(this.config.finalPromptPollIntervalMs || DEFAULTS.finalPromptPollIntervalMs));
      const rows =
        (await this.api.post("/production/workbench/checkVideoPrompt", {
          projectId: this.context.projectId,
          scriptId: this.context.scriptId,
          trackIds,
        })) ?? [];
      for (const row of rows) completed.set(Number(row.id), row);
      emit("final_prompt.progress", { completed: completed.size, total: trackIds.length, remaining: trackIds.filter((id) => !completed.has(id)) });
      emit("workflow.progress", {
        phase: "stage5.5",
        status: "generating_final_prompts",
        completed: completed.size,
        total: trackIds.length,
        message: `Seedance 2.0 最终视频提示词进度 ${completed.size}/${trackIds.length}`,
      });
    }

    const generatedRows = trackIds.map((id) => completed.get(id));
    const failures = generatedRows.filter(
      (row) => row?.state === "生成失败" || !String(row?.prompt ?? "").trim() || /生成中|pending/i.test(String(row?.state ?? "")),
    );
    if (failures.length) {
      throw fail(
        `最终视频提示词生成失败: ${failures.map((row) => `${row?.id ?? "未知轨道"}${row?.reason ? `(${row.reason})` : ""}`).join(", ")}`,
      );
    }
    const generatedById = new Map(generatedRows.map((row) => [Number(row.id), row]));
    const rows = availableTracks.map((track) => generatedById.get(Number(track.id)) ?? existingById.get(Number(track.id)));
    await this.validateFinalWorkflow(rows);
    emit("final_prompt.complete", {
      model,
      prompts: rows.map((row) => ({ id: row.id, characters: String(row.prompt).length })),
    });
    return rows;
  }

  status() {
    emit("controller.status", {
      connected: Boolean(this.socket?.connected),
      activeTurn: this.currentTurn?.id ?? null,
      activeMessages: this.currentTurn ? [...this.currentTurn.messageIds] : [],
      generations: [...this.generations.keys()],
      phase: this.state.currentPhase,
      repairRounds: this.state.repairRounds,
      continuationRetries: this.state.continuationRetries,
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
      storyboardPrompts: (flow.storyboard ?? []).filter((item) => String(item.prompt ?? "").trim()).length,
      storyboardImagesRequested: (flow.storyboard ?? []).filter((item) => Number(item.shouldGenerateImage) === 1).length,
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
    this.state.pid = null;
    await this.saveState().catch((error) => emit("state.warning", { message: `状态文件保存失败: ${error.message}` }));
    this.socket?.disconnect();
    this.rl?.close();
    emit("controller.closed", { projectId: this.context.projectId, scriptId: this.context.scriptId });
    process.exitCode = 0;
  }

  async advanceAfterEpisode() {
    if (!this.onEpisodeFinished) return;
    try {
      await this.onEpisodeFinished(this.context);
    } catch (error) {
      emit("series.error", {
        projectId: this.context.projectId,
        scriptId: this.context.scriptId,
        message: error.message,
      });
      process.exitCode = 1;
    }
  }
}

let activeController = null;

function runSelfTests() {
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw fail(`自检失败: ${name}`);
    checks.push(name);
  };

  const continuedRepair = gradeDecision(
    "C",
    { ...DEFAULTS, maxRepairRounds: 2 },
    2,
    "评分：C。问题清单：台词时长不足。建议方案：延长镜头。",
  );
  check("C/D 达到本地轮数后重置并继续", continuedRepair?.action === "repair" && continuedRepair.resetRepairCycle === true);

  const stable = buildFlowSnapshot({ scriptPlan: "计".repeat(300), storyboardTable: "镜".repeat(300), assets: [], storyboard: [] });
  const changed = buildFlowSnapshot({ scriptPlan: "计".repeat(300), storyboardTable: "新".repeat(300), assets: [], storyboard: [] });
  const reviewDecision = classifyTurn(
    {
      statuses: ["complete"],
      generationFailures: [],
      workspaceRejections: [],
      toolEvents: [{ tool: "storyboardTable" }],
      text: "评分：B。此前错误均已修复，失败项为零。",
    },
    DEFAULTS,
    { currentPhase: "stage4", repairRounds: 1, repairRoundsByPhase: { stage4: 1 } },
    stable,
    changed,
  );
  check("审核正文中的错误/失败不触发系统误停", reviewDecision?.action === "approve");

  const isolatedState = { currentPhase: "stage1", repairRounds: 2, repairRoundsByPhase: { stage1: 2 } };
  check("阶段修复轮数隔离", phaseCounter(isolatedState, "repairRoundsByPhase", "stage4", "repairRounds") === 0);

  const retryDecision = classifyTurn(
    {
      statuses: ["complete"],
      generationFailures: [],
      workspaceRejections: [],
      toolEvents: [],
      text: "现在进入阶段5，让我立即派发执行层。",
    },
    { ...DEFAULTS, maxNoEvidenceRetries: 1 },
    { currentPhase: "stage5", continuationRetries: 0, continuationRetriesByPhase: { stage5: 0 } },
    stable,
    stable,
  );
  check("承诺性回复无证据时自动续催", retryDecision?.action === "retry");

  const retryExhausted = classifyTurn(
    {
      statuses: ["complete"],
      generationFailures: [],
      workspaceRejections: [],
      toolEvents: [],
      text: "现在进入阶段5，让我立即派发执行层。",
    },
    { ...DEFAULTS, maxNoEvidenceRetries: 1 },
    { currentPhase: "stage5", continuationRetries: 1, continuationRetriesByPhase: { stage5: 1 } },
    stable,
    stable,
  );
  check("自动续催有界", retryExhausted?.action === "pause");

  const recoveryDecision = classifyTurn(
    {
      statuses: ["complete"],
      generationFailures: [],
      workspaceRejections: [],
      toolEvents: [{ tool: "scriptPlan" }],
      text: "完整导演计划已恢复。",
    },
    DEFAULTS,
    { currentPhase: "stage4", workspaceRecoveryPhase: "stage4", workspaceRecoveryTags: ["scriptPlan"] },
    stable,
    { ...stable, scriptPlanHash: hashValue("恢复后的完整计划") },
  );
  check("关键字段恢复后返回原阶段", recoveryDecision?.action === "retry" && recoveryDecision.phase === "stage4");

  check("拒绝 scriptPlan 占位覆盖", Boolean(workspaceValueIssue("scriptPlan", "...", "完整计划".repeat(300))));
  check("接受完整 scriptPlan", !workspaceValueIssue("scriptPlan", "完整计划".repeat(300), "原计划".repeat(300)));
  check(
    "按项目分集顺序选择下一集",
    Number(nextScriptInOrder([{ id: 3 }, { id: 8 }, { id: 13 }], 8)?.id) === 13,
  );
  check("最后一集没有下一集", nextScriptInOrder([{ id: 3 }, { id: 8 }], 8) === null);
  check(
    "后续分集状态文件隔离",
    stateFileForEpisode({ stateFile: "user/tools/controller-state.json" }, { projectId: 1, scriptId: 8 }, false) ===
      "user/tools/controller-state.script-8.json",
  );
  check(
    "状态文件模板绑定准确分集",
    stateFileForEpisode(
      { stateFile: "user/tools/controller-state.{projectId}.{scriptId}.json" },
      { projectId: 5, scriptId: 8 },
      false,
    ) === "user/tools/controller-state.5.8.json",
  );

  const severeReport = "评分：A\n问题清单：\n1. 因果链缺失\n严重程度：严重\n建议方案：补齐证据来源。\n审核结论：暂不通过";
  const severeA = gradeDecision("A", DEFAULTS, 0, severeReport);
  check("A 级仍有严重项时继续修复", severeA?.action === "repair" && severeA.severeIssues === 1);

  const severeRepairedB = gradeDecision("B", DEFAULTS, 1, severeReport.replace("评分：A", "评分：B"));
  check("修复后 B 级仍有严重项时继续修复", severeRepairedB?.action === "repair");

  const cleanRepairedB = gradeDecision(
    "B",
    DEFAULTS,
    1,
    "评分：B\n问题清单：\n1. 表述略长\n严重程度：一般\n建议方案：精简台词。",
  );
  check("修复后 B 级无严重项时通过", cleanRepairedB?.action === "approve");

  const cleanA = gradeDecision("A", DEFAULTS, 0, "评分：A\n问题清单：无");
  check("A 级无严重项时通过", cleanA?.action === "approve");

  const descriptiveSevere = gradeDecision(
    "A",
    DEFAULTS,
    0,
    "评分：A\n问题清单：\n1. 若不处理可能造成严重影响\n严重程度：一般\n建议方案：调整措辞。",
  );
  check("普通正文出现严重二字不误判", descriptiveSevere?.action === "approve");

  const missingSevereAdvice = gradeDecision(
    "A",
    DEFAULTS,
    0,
    "评分：A\n问题清单：\n1. 因果断裂\n严重程度：严重\n审核结论：暂不通过",
  );
  check("严重项缺少对应建议方案时暂停", missingSevereAdvice?.action === "pause");

  emit("self_test.complete", { passed: checks.length, checks });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.selfTest) {
    runSelfTests();
    return;
  }
  const config = await loadConfig(args);
  await ensureBackend(config);
  const api = new ToonflowApi(config.baseUrl);
  await api.authenticate();
  if (args.list) {
    await listContexts(api);
    return;
  }
  const context = await resolveContext(api, config);
  if (args.finalPrompts) {
    const controller = new ToonflowController(api, context, config);
    activeController = controller;
    await controller.initialize();
    controller.enterPhase("stage5.5");
    await controller.saveState();
    const rows = await controller.generateFinalVideoPrompts();
    controller.enterPhase("finished");
    await controller.saveState();
    emit("workflow.finished", {
      reason: "Seedance 2.0 最终视频提示词已生成",
      prompts: rows.map((row) => ({ id: row.id, characters: String(row.prompt ?? "").length, existing: Boolean(row.existing) })),
    });
    await controller.close();
    return;
  }
  if (args.probe) {
    const controller = new ToonflowController(api, context, config);
    activeController = controller;
    await controller.initialize();
    controller.flowSummary();
    await controller.close();
    return;
  }
  const runEpisode = async (episodeContext, isInitialEpisode) => {
    const episodeConfig = {
      ...config,
      stateFile: stateFileForEpisode(config, episodeContext, isInitialEpisode),
    };
    const controller = new ToonflowController(api, episodeContext, episodeConfig, async (completedContext) => {
      if (!config.autoAdvanceEpisodes) {
        emit("series.finished", {
          projectId: completedContext.projectId,
          scriptId: completedContext.scriptId,
          reason: "autoAdvanceEpisodes_disabled",
        });
        return;
      }
      const nextContext = await resolveNextContext(api, completedContext);
      if (!nextContext) {
        emit("series.finished", {
          projectId: completedContext.projectId,
          scriptId: completedContext.scriptId,
          reason: "no_next_episode",
        });
        return;
      }
      emit("episode.advancing", {
        fromScriptId: completedContext.scriptId,
        toScriptId: nextContext.scriptId,
        toScriptName: nextContext.scriptName,
      });
      await runEpisode(nextContext, false);
    });
    activeController = controller;
    await controller.initialize();
    if (controller.state.currentPhase === "finished") {
      emit("episode.already_finished", {
        projectId: episodeContext.projectId,
        scriptId: episodeContext.scriptId,
        stateFile: controller.statePath,
      });
      await controller.close();
      await controller.advanceAfterEpisode();
      return;
    }
    controller.startConsole();
    if (episodeConfig.autoStart) {
      const prompt = isInitialEpisode ? episodeConfig.startPrompt : episodeConfig.nextEpisodeStartPrompt;
      await controller.send(prompt, isInitialEpisode ? "auto:start" : "auto:next_episode");
    }
  };

  process.on("SIGINT", () => activeController?.close());
  process.on("SIGTERM", () => activeController?.close());
  await runEpisode(context, true);
}

main().catch(async (error) => {
  emit("fatal", { message: error.message, cause: error.cause?.message });
  await activeController?.close().catch((closeError) => {
    emit("controller.close_warning", { message: closeError.message });
  });
  process.exitCode = 1;
});
