# Toonflow 用户侧控制器

该控制器直接复用 Toonflow 本地 HTTP API 与 `productionAgent` Socket，不操作浏览器、不修改框架，也不直接读写数据库。

它负责：

- 每次执行前检查 `localhost:10588`；未运行时自动启动现有生产后端 `data/serve/app.js`，等待就绪后再连接；
- 从导演规划开始发送一次启动指令；
- 采用双轨协作：Toonflow 独立执行，Codex 控制器只监控工具事件、工作区数据变化和后台任务；
- 在 Toonflow 运行期间只监听消息并响应 Toonflow 主动发起的工作区工具回调；普通“已完成”等文字不作为节点完成依据；
- 将 `<scriptPlan>`、`<storyboardTable>` 通过官方保存 API 写回工作区；
- 等待完整对话轮次、流式消息和异步图片生成全部结束；
- 依据 Toonflow 自身的 A/B/C/D 评分与建议方案审批：A 直接继续；首次 B 按原报告修复，修复后复审达到 B 即通过，不再追求 A；C/D 继续按原报告修复并复审；多选方案取报告列出的第一个方案；
- 同一节点状态只审批一次；没有工具事件或工作区数据变化时保持静默；
- 每个阶段独立记录修复轮数；C/D 达到本地计数周期后，只要 Toonflow 仍给出明确问题清单和建议方案，就重置该阶段计数并继续修复，不把本地轮数上限当作整集终点；
- 审核正文中的“错误”“失败”等文字只作为报告内容，不作为系统故障证据；只有消息错误终态、工具/接口错误或后台失败项才会暂停；
- Toonflow 只回复“将派发”“现在开始”等承诺性文字却没有工具事件时，控制器会在当前阶段自动续催一次；续催仍无完成证据才暂停；
- `scriptPlan` 或 `storyboardTable` 若被 `...`、空对象或异常短文本覆盖，控制器会拒绝写入并要求执行层恢复完整字段；
- 将阶段、修复轮次和已审批节点持久化到 `user/tools/controller-state.json`，重启后继续使用；
- 当阶段5全部分镜均为“不出图”且 `generateFinalVideoPrompts=true` 时，调用 Toonflow 官方视频工作台接口生成 Seedance 2.0 最终视频提示词，然后结束流程，不生成分镜图或视频；
- 当前集完成后重新读取项目分集列表，按 Toonflow 返回的分集顺序绑定下一集准确的 `scriptId` 并从导演规划继续；只有没有下一集时才退出；
- 每个后续分集使用独立状态文件，避免修复轮数、审批指纹和完成状态跨集复用；
- 以 `workflow.progress` JSON Lines 事件持续输出监控进度，供 Codex 显示和追踪。

`initialRepairRounds` 只在首次创建状态文件时作为初始值；之后以持久化状态为准。

`maxRepairRounds` 是单个阶段的本地计数周期，不是 C/D 审核的终止上限；达到该数值且原生修复建议仍明确时会清零并继续。`maxNoEvidenceRetries` 控制承诺性空回复的自动续催次数，默认仅续催 1 次，避免无限发送。

默认配置 `"autoAdvanceEpisodes": true`。当前集完整验收后，控制器会重新调用 Toonflow 分集列表接口定位下一集；有下一集时自动开始该集，没有下一集时输出 `series.finished` 并退出。若只想运行当前一集，可设为 `false`。

首集使用 `stateFile` 原路径，自动切换后的分集会在文件名中追加 `.script-<scriptId>`。也可显式使用模板，例如 `user/tools/controller-state.{projectId}.{scriptId}.json`。这样重启时会跳过已完成集，并从尚未完成的下一集继续。

## 凭据

凭据只放环境变量，不能写进配置文件。

PowerShell 登录方式：

```powershell
$env:TOONFLOW_USERNAME="你的 Toonflow 用户名"
$env:TOONFLOW_PASSWORD="你的 Toonflow 密码"
```

也可以使用已有 Token：

```powershell
$env:TOONFLOW_TOKEN="Bearer 你的Token"
```

## 先核对项目和分集

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --list
```

示例配置已按当前项目名称选择项目，并用 `scriptIndex: 0` 选择第一集。若列表结果不同，请把配置改为明确的 `projectId` 与 `scriptId`。

## 启动

自动从导演规划开始并按 Toonflow 原生审批流程推进：

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --start
```

默认配置 `"ensureBackend": true`。因此上面的单条命令同时覆盖“后端尚未启动”和“后端已经运行”两种情况，不会重复启动。若只允许连接现有后端，可追加 `--no-ensure-backend`。

只连接和检查，不启动流程：

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --probe
```

阶段5已经完成时，只生成视频工作台最终 Seedance 2.0 提示词：

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --final-prompts
```

该命令会自动检查/启动后端，读取现有分镜轨道、视频描述和关联资产，通过官方 `batchGeneratePrompt` 接口生成提示词并轮询到终态。它不会向 Toonflow 对话框发送新任务，也不会调用图片或视频生成接口。所有轨道已经存在非空提示词时会直接跳过，避免重复生成。`--final-prompts` 是当前集专项命令，不触发自动切集；完整自动切集由常规控制器流程执行。

控制器内置纯逻辑自检，不连接后端、不发送项目内容：

```powershell
node .\user\tools\toonflow-controller.mjs --self-test
```

关闭自动审批、由终端命令逐步控制：

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --no-auto
```

交互命令：`start`、`send <内容>`、`approve`、`confirm`、`repair`、`status`、`flow`、`stop`、`quit`。

## 运行边界

- 同一分集只运行一个控制器实例。
- 自动启动只调用仓库现有生产入口，不运行 `build`、不修改框架；非本机 `localhost:10588` 地址不会自动启动。
- 启动后端不代表自动授权向外部模型供应商发送项目内容；在 Codex 受限环境中，这类网络访问仍需用户明确授权。
- `turn.sent` 后到 `turn.complete` 前，控制器拒绝发送任何新对话。
- 节点推进只依据 `<scriptPlan>`、衍生资产、`<storyboardTable>`、分镜记录和生成任务等权威数据变化；自然语言确认不触发推进。
- `controller-state.json` 只保存阶段、摘要哈希、修复轮次和审批指纹，不保存项目正文或登录凭据。
- 衍生资产图或分镜图处于生成中时，控制器持续轮询并阻止推进。
- 分镜表文本审核或修复阶段若误收到空 ID 的 `generateStoryboard` 调用，控制器只返回“已跳过”，不调用图片生成接口，也不把它记为流程失败。
- `approval.required` 表示 Toonflow 输出不够明确、自动续催后仍无完成证据、缺少原生修复建议、接口错误或生成失败，需要人工查看。
- 输出采用 JSON Lines，便于 Codex 或其他进程监听；不会输出密码、Token、Cookie 或供应商密钥。
