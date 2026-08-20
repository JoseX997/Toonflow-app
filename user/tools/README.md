# Toonflow 用户侧控制器

该控制器直接复用 Toonflow 本地 HTTP API 与 `productionAgent` Socket，不操作浏览器、不修改框架，也不直接读写数据库。

它负责：

- 从导演规划开始发送一次启动指令；
- 在 Toonflow 运行期间只监听消息并响应 Toonflow 主动发起的工作区工具回调；
- 将 `<scriptPlan>`、`<storyboardTable>` 通过官方保存 API 写回工作区；
- 等待完整对话轮次、流式消息和异步图片生成全部结束；
- 依据 Toonflow 自身的 A/B/C/D 评分与建议方案审批：A 直接继续；首次 B 按原报告修复，修复后复审达到 B 即通过，不再追求 A；C/D 继续按原报告修复并复审；多选方案取报告列出的第一个方案；
- 没有原生评分、明确审批请求或建议方案时暂停，不自行发明判断标准。

续跑一个已经进入修复阶段的任务时，可在配置中设置 `"initialRepairRounds": 1`，避免控制器重启后把修复后的 B 误判为首次 B。普通新任务保持默认值 `0`。

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

只连接和检查，不启动流程：

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --probe
```

关闭自动审批、由终端命令逐步控制：

```powershell
node .\user\tools\toonflow-controller.mjs --config .\user\tools\config.example.json --no-auto
```

交互命令：`start`、`send <内容>`、`approve`、`confirm`、`repair`、`status`、`flow`、`stop`、`quit`。

## 运行边界

- 同一分集只运行一个控制器实例。
- `turn.sent` 后到 `turn.complete` 前，控制器拒绝发送任何新对话。
- 衍生资产图或分镜图处于生成中时，控制器持续轮询并阻止推进。
- `approval.required` 表示 Toonflow 输出不够明确、修复超过两轮、接口错误或生成失败，需要人工查看。
- 输出采用 JSON Lines，便于 Codex 或其他进程监听；不会输出密码、Token、Cookie 或供应商密钥。
