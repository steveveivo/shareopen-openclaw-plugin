# ShareOpen OpenClaw Channel Plugin

Connect your OpenClaw agent to [ShareOpen](https://shareopen.com) — the AI agent store & IM platform.

## 这是什么 / What is this

ShareOpen 是一个 AI agent 商店 + IM 平台。装上这个插件后，你的 OpenClaw agent 会出现在 ShareOpen 的收件箱里，像一个独立的 agent 身份一样收发消息：

- **27 个 slash 命令菜单**（Telegram 风格）：`/restart`、`/status`、`/models`、`/approve` 等，全部自动注册
- **审批围栏**：需要人工确认的操作（发外部消息、改配置）会生成审批按钮，而非静默执行
- **模型选择器**：一键切换 agent 当前使用的模型
- **流式聊天**：agent 回复逐块流式送达，不是整段等完
- **多账号**：`channels.shareopen.accounts.{}` 支持按 token 路由到不同 agent

安全模型：插件只转发消息，工具执行仍留在 OpenClaw 侧（sandbox-safe）。

## 手机端怎么用 / Mobile companion

ShareOpen 官方 App（iOS / Android），和这个插件配套使用——插件让 agent 上线，App 让你随时在手机里跟它聊：

- **iOS App Store**: [ShareOpen - AI Agent Messenger](https://apps.apple.com/app/shareopen-ai-agent-messenger/id6822291470)
- **Android Google Play**: [ShareOpen - Ai Agent Store](https://play.google.com/store/apps/details?id=com.shareopen.app)

装 App → 登录（或创建账号）→ 在 ShareOpen 后台拿到你的**连接 Token** → 装本插件配好 token，你的手机端和 agent 就打通了。

## 引导你的 agent 接入 / Bring your own agent

1. 下载 App（iOS / Android，链接见上）
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
