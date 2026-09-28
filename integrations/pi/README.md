# Pi 适配与验收边界

固定 `@earendil-works/pi-coding-agent@0.84.1`。生产入口 `src/runtime.ts` 已连接独立引擎，Pi 负责模型/工具循环、重试和压缩，不复制一套 harness。

```sh
npm run typecheck
npm test
```

从根目录运行 `npm run setup` / `npm run verify`。测试使用真实 SDK、原生 JSONL 与明确的离线 provider 替身，不接触真实供应商。

## 生产路径

- 精确指定 provider/model，不静默回退；API Key 仅由宿主显式传入。OAuth 显式使用仓库外专属 `auth/auth.json`，通过 Pi 原生 `ModelRuntime.login/getAuth/logout` 管理；不读取既有 Pi/Codex 登录或仓库 models.json，静态目录不发起网络刷新。
- session 的 cwd/agentDir 位于独立运行目录；关闭仓库指令、context files、扩展、skills、prompt templates、themes。
- `tools` 精确白名单并关闭内置工具；源码工具绑定冻结快照，最终提交由业务引擎处理。
- 独占空 JSONL 经公开 SessionManager.open 初始化；首条 assistant 前可保存业务事件。
- durable journal 在 append 前后同步、核对原生条目；公开 agent subscription 在原生消息写入后检查持久化。任何故障终止本 run，不允许后续报告显示成功。

`src/create-session.ts` 保留 M0 空工具隔离 smoke 入口，生产 CLI 使用 `runtime.ts`。默认 journal 的非 durable 模式仅用于历史 SDK 行为测试；生产始终启用 durable。

## 已测试和限制

覆盖：首条回复前落盘、原生重开、分支/序列/身份校验、截断日志、写失败终止、完整离线工具循环和报告交付。原有 synthetic assistant fixture 只存在于历史回归测试，不用于生产初始化。

真实模型调用前按 [验收指南](../../docs/LIVE_ACCEPTANCE.md) 配置。供应商内置接入不等于已实测；依赖额外云配置的供应商不在本轮 CLI 范围。Codex OAuth 测试通过模拟认证响应和模型响应验证原生协议，实际账号授权及模型可用性仍需用户登录后验收。

同步不是数据库事务，也不承诺 exactly-once。产品恢复是原快照的新 run，不继续旧模型会话。Hook 不是沙箱；执行工具和引擎仍负责权限、范围与版本检查。

## 国内智谱 Flash

应用通过公开 registerProvider 增加 `bigmodel/glm-5.3-flash`，固定使用用户确认的 `https://open.bigmodel.cn/api/paas/v4/`。仍由 Pi 执行模型循环与 HTTP 编解码，不读取仓库 models.json。配置步骤见 [真实模型验收指南](../../docs/LIVE_ACCEPTANCE.md)。
