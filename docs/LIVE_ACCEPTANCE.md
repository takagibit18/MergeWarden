# 首次真实模型验收

当前状态：**2026-09-20 已完成 BigModel GLM-5.3-Flash 的真实 CLI smoke**：使用 v0.2 冻结案例验证审查、图工具、报告重开、证据和同快照重跑，结果见 [验证记录](VALIDATION.md)。本页下方的独立 v0.1 缺陷/修复 fixture 尚未真实运行，不能把其他 smoke 当作该用例的验收记录。离线替身不代表模型检出能力；未打版本标签。

已选择国内智谱 GLM-5.3-Flash：使用 `--provider bigmodel --model glm-5.3-flash`，按下文设置 API Key 并运行验收。

## 1. 选择并配置

在仓库根目录运行：

```powershell
npm run cli -- models
# 可按供应商缩小列表，例如：
npm run cli -- models --provider anthropic
```

列表来自固定 Pi 0.84.1 的内置目录及应用注册的智谱 Flash 配置，可能与供应商实时可用性不同，也不表示账号已有模型权限。选择支持 API Key 的供应商，或按下方使用 Pi 原生订阅登录；不会自动换模型。需要额外云账号、区域配置的供应商不在本轮 CLI 配置范围内。

### ChatGPT 订阅登录

在交互式 PowerShell 中运行，默认凭据位于 `%LOCALAPPDATA%/MergeWarden2/auth/auth.json`：

```powershell
npm run cli -- login --provider openai-codex
```

回车选择浏览器登录，再打开终端显示的授权链接；浏览器完成后会回到本地回调地址。如果回调未返回终端，可在终端粘贴最终跳转地址。也可在登录菜单选择设备码方式。授权地址或授权码只用于本地登录，不要发送到聊天。Ctrl+C 可取消。

如果浏览器显示成功但终端失败，先看错误分类：`token_http_403` 表示令牌交换被拒，`network_*` 表示终端网络问题，`credential_storage` 表示凭据保存失败。浏览器能联网不代表终端使用了相同代理。适配器会在 SDK 加载后，使用与 Pi CLI 相同的 HTTP 库初始化环境代理；同一窗口必须已有正确的 `HTTP_PROXY`/`HTTPS_PROXY`，不依赖 `NODE_USE_ENV_PROXY`，也不会自动读取代理软件的系统设置。`NO_PROXY` 应包含 `localhost,127.0.0.1,::1`，后续审查也应在相同代理环境中执行。不要关闭 TLS 校验，也不要复用失败登录的旧链接或授权码。

```powershell
npm run cli -- auth-status --provider openai-codex
npm run cli -- models --provider openai-codex
```

`configured: true` 仅表示凭据已保存，不表示订阅额度或模型权限已验证。`models` 为固定目录，不联网枚举账号权限。选择目录中且账号可用的模型后运行：

```powershell
$reviewRepo = '被审仓库的绝对路径'
$reviewBase = 'BASE_SHA'
$reviewHead = 'HEAD_SHA'
$reviewModel = '从 models 列表选择的准确 ID'
npm run cli -- review --repo $reviewRepo --base $reviewBase --head $reviewHead --provider openai-codex --model $reviewModel --auth oauth --thinking low --max-output-tokens 8192
```

如使用自定义 `--state PATH`，登录、状态查询、审查和退出都必须使用同一路径，且该目录必须位于被审仓库之外。订阅方式不填写 `--api-key-env`。Pi 负责刷新凭据；刷新失败会报错，不切换到付费 API。退出本应用登录：

```powershell
npm run cli -- logout --provider openai-codex
```

原生会话继续记录工具调用、结果和供应商返回的用量；运行清单记录认证类型，不写入凭据。首个真实样本应确认报告为 `completed`、工具轨迹和用量均有记录。旧 GLM 受控实验的锁、传输观测脚本和模型配置保持冻结，不能只改模型名称就当作新的可比实验。跨模型对照须另建实验配置与输出，使用相同 Git 提交重新冻结输入；`rerun` 要求原模型配置相同。

### API Key 登录

在**本机 PowerShell**设置环境变量，勿将密钥粘贴到聊天、仓库文件或命令参数：

```powershell
$secureKey = Read-Host 'API Key' -AsSecureString
$env:MERGEWARDEN_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
Remove-Variable secureKey
$reviewProvider = '填入供应商名'
$reviewModel = '填入准确模型 ID'
```

此设置仅对当前 PowerShell 及其启动的进程有效。在这个窗口运行审查命令；Codex 已在运行的进程不会自动获得新设置的环境变量。这里只需向协作者提供供应商、模型和变量名，不能提供密钥。

## 2. 固定用例

用例答案已冻结在 `fixtures/live-v01/fixture.json`。它包含原版、移除空输入保护的缺陷版、恢复保护的修复版；标注文件不放入被审查的小仓库。

从零准备（输出目录必须不存在）：

```powershell
node scripts/prepare-live-fixture.mjs ../mergewarden2-live-fixture
```

本次工作已在 `../mergewarden2-live-fixture` 准备好仓库，提交如下；不用再次生成：

| 版本 | 提交 |
|---|---|
| base | `51d95c6171faebcf63335d4e8746d796c5817343` |
| bug | `064f999bba8cfc05063ca5bdd1efaf4c312eaa22` |
| fixed | `eeafcb46c5f391eb59892c69c007da844da16c6b` |

在其他机器重新生成时，以脚本输出的提交为准。

## 3. 发起审查（这一步会调用并可能产生供应商费用）

```powershell
npm run cli -- review --repo ../mergewarden2-live-fixture --base 51d95c6171faebcf63335d4e8746d796c5817343 --head 064f999bba8cfc05063ca5bdd1efaf4c312eaa22 --provider $reviewProvider --model $reviewModel --api-key-env MERGEWARDEN_API_KEY

npm run cli -- review --repo ../mergewarden2-live-fixture --base 064f999bba8cfc05063ca5bdd1efaf4c312eaa22 --head eeafcb46c5f391eb59892c69c007da844da16c6b --provider $reviewProvider --model $reviewModel --api-key-env MERGEWARDEN_API_KEY
```

默认 10 分钟、100 次工具调用。输出含 run ID、JSON 和 Markdown 报告路径；失败或不完整返回非零退出码。保存运行清单中的 token 用量，不编造费用。Ctrl+C 取消并尽可能保存取消报告；关闭窗口等硬中断可能留下 `running` 清单，需要诊断。

## 4. 人工核验

- 缺陷版应发现 `summary([])` 经 `mean([])` 触发零除，证据指向冻结的 head `stats.py:2`。
- 修复版不得继续报告同一个已修复问题。其他发现逐条核对，不先假设是误报。
- 两次均须完整交付，证据 hash 可复核，报告重开后仍能读取。
- 将供应商、模型、预算、两个 run ID、预期是否命中、误报/漏报和判断理由记录到验收表。失败如实记录，不修改既有答案来迁就模型。

```powershell
npm run cli -- history
npm run cli -- show --run RUN_ID
npm run cli -- evidence --run RUN_ID --finding FINDING_ID
npm run cli -- doctor --repo ../mergewarden2-live-fixture
```

中断后重跑使用原快照及相同供应商/模型，创建新会话：

```powershell
npm run cli -- rerun --repo ../mergewarden2-live-fixture --run RUN_ID --provider $reviewProvider --model $reviewModel --api-key-env MERGEWARDEN_API_KEY
```

`doctor` 确认锁拥有者已退出后，可用 `unlock --repo ...` 清理遗留锁。不要手工改写已保存 JSONL、报告或快照来恢复“成功”状态。

本页通过仅满足初次模型审查门槛；v0.4 仍要求完整标注集、真实公开 Python 变更、Windows/WSL 和扩展验收。
