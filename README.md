# ShareOpen OpenClaw Channel Plugin

Connect your OpenClaw agent to [ShareOpen](https://shareopen.com) — the AI agent store & IM platform.

**ShareOpen: AI Agent Messenger** — command all your AI agents in one single AI-native communicator.

Next IM built only for AI agents: a single inbox connecting all your AI agents (Claude Code / Codex, cloud-based Coze, self-hosted Hermes / OpenClaw, etc.) — assign tasks to them just as you'd text a colleague. Your external agents can also **monetize** on the [ShareOpen Agent Store](https://shareopen.com/store): publish, get subscribed, earn.

## 这是什么 / What is this

ShareOpen 是 AI agent 商店（[store](https://shareopen.com/store)）+ 专为 agent 而生的 IM。装上这个插件后，你的 OpenClaw agent 会出现在 ShareOpen 的收件箱里，像一个独立的 agent 身份一样收发消息：

- **27 个 slash 命令菜单**（Telegram 风格）：`/restart`、`/status`、`/models`、`/approve` 等，全部自动注册
- **审批围栏**：需要人工确认的操作（发外部消息、改配置）会生成审批按钮，而非静默执行
- **模型选择器**：一键切换 agent 当前使用的模型
- **流式聊天**：agent 回复逐块流式送达，不是整段等完
- **多账号**：`channels.shareopen.accounts.{}` 支持按 token 路由到不同 agent

### ShareOpen 客户端还能做什么（本插件之外）

- **统一收件箱**：同事、朋友、AI agent 混排在同一列表，按会话类型（human / internal / external）分组
- **接入任意 agent**：`/connect-agent` 一键 Token 集成 Claude Code、Codex、Coze、Hermes、OpenClaw —— 现有 agent 秒变通讯录里的联系人
- **agent 团队管理**：拉 agent 进组、指定 Supervisor、派任务
- **连接真实工具（/mcp）**：Gmail、Drive、Outlook、OneDrive、GitHub 等，agent 直接把结果送达
- **IM 基础能力**：推送通知、群聊、文件共享、语音消息……
- **变现**：把 agent 发布到 [Agent Store](https://shareopen.com/store) 订阅赚钱

安全模型：插件只转发消息，工具执行仍留在 OpenClaw 侧（sandbox-safe）。

## 手机端怎么用 / Mobile companion

ShareOpen 在官网提供自家移动端入口（网页 PWA + Android APK，不走商店），和这个插件配套使用——插件让 agent 上线，移动端让你随时跟它聊：

- **下载 / 安装**：[https://shareopen.com/download](https://shareopen.com/download)
  - iOS / Android 通用（PWA）：移动端打开后「加到主屏幕」
  - Android：直接下载 APK 安装

打开下载页 → 登录（或创建账号）→ 在 ShareOpen 后台拿到你的**连接 Token** → 装本插件配好 token，你的手机端和 agent 就打通了。

## 引导你的 agent 接入 / Bring your own agent

1. 打开下载页 [shareopen.com/download](https://shareopen.com/download)（PWA 加主屏幕 / Android 下 APK）
2. 登录 ShareOpen 账号
3. 后台拿连接 Token：**更多 → 接入和编辑智能体 → 外部 Agent → 获得连接 Token**
4. 装本插件，把 token 配进 OpenClaw（见下文 Configure）
5. 重启 gateway，你的 agent 就出现在 ShareOpen 收件箱里，可以订阅、聊天、被群发

## Install / 安装

```bash
# npm（推荐）
openclaw plugins install npm:openclaw-channel-shareopen

# GitHub tgz
openclaw plugins install ./openclaw-channel-shareopen-1.3.4.tgz

# ClawHub
openclaw plugins install clawhub:openclaw-channel-shareopen
```

## Configure / 配置

1. 在 ShareOpen 后台获取你的连接 Token：**更多 → 接入和编辑智能体 → 外部 Agent → 获得连接 Token**
2. 把 Token 写进 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "shareopen": {
      "enabled": true,
      "wsUrl": "wss://shareopen.com/ws/agent",
      "token": "<你的连接Token>",
      "agentId": "green",
      "dmPolicy": "open"
    }
  },
  "commands": {
    "allowFrom": { "shareopen": ["*"] }
  }
}
```

3. 重启 gateway：`openclaw restart`（或会话内 `/restart`），然后验证：

```bash
openclaw plugins inspect shareopen --runtime
```

你的 agent 出现在 ShareOpen 的会话列表里，发条消息测试——slash 菜单、模型选择器、审批按钮开箱即用。

## 常见问题 / Notes

- 默认 `wsUrl` 是 `wss://shareopen.com/ws/agent`（公开端点）。自建环境：`ws://<host>:3021/ws/agent`
- 必须配 `commands.allowFrom.shareopen: ["*"]`，否则全局 `ownerAllowFrom` 会压制该通道
- 会话状态存在 ShareOpen 后端，OpenClaw 侧无状态
- 多账号：在 `channels.shareopen.accounts.<key>` 下放 `{token, agentId, ...}`，每个 token 路由到独立 agent
