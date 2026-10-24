/**
 * ShareOpen Channel Plugin — Entry Point
 * 
 * Self-contained plugin using default export as register function.
 */

/**
 * ShareOpen channel plugin object implementing ChannelPlugin contract.
 */
const shareopenPlugin = {
  id: "shareopen",
  meta: {
    name: "ShareOpen",
    description: "ShareOpen IM platform — local Agent IM via WebSocket gateway.",
  },
  capabilities: {
    text: true,
    media: false,
    reactions: false,
    thread: true,
  },
  setup: {
    resolveAccount: (config) => ({
      wsUrl: config?.wsUrl || process.env.SHAREOPEN_WS_URL,
      token: config?.token || process.env.SHAREOPEN_TOKEN,
      agentId: config?.agentId || process.env.SHAREOPEN_AGENT_ID || "green",
      dmPolicy: config?.dmPolicy || "open",
      allowFrom: config?.allowFrom || ["*"],
    }),
  },
  security: {
    dm: {
      channelKey: "shareopen",
      resolvePolicy: (account) => account?.dmPolicy || "open",
      resolveAllowFrom: (account) => account?.allowFrom || ["*"],
    },
  },
  outbound: (account, _config, _ctx) => ({
    async sendText({ text, target }) {
      try {
        const httpUrl = account.wsUrl
          .replace("ws://", "http://")
          .replace("wss://", "https://")
          .replace("/ws/agent", "");

        const resp = await fetch(`${httpUrl}/api/messaging/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": account.token,
          },
          body: JSON.stringify({
            type: "text",
            payload: { text },
            conversation_id: target?.conversationId,
          }),
        });

        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${body}`);
        }

        const result = await resp.json();
        return { ok: true, messageId: result?.id || String(Date.now()) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  }),
  threading: {
    sessionKeySeparator: ":",
    threadSeparator: "/",
    threadIdInSessionKey: true,
  },
};

/**
 * Default export — the register function called by OpenClaw.
 * OpenClaw's unwrapDefaultModuleExport will unwrap this, then call it as register(api).
 */
export default function register(api) {
  if (api.registrationMode === "cli-metadata") {
    return { id: "shareopen", name: "ShareOpen", channelPlugin: true };
  }
  if (api.registrationMode === "tool-discovery") return;
  if (api.registrationMode === "discovery") return;
  if (api.registrationMode !== "full") return;

  api.registerChannel({ plugin: shareopenPlugin });
}

/**
 * Also export register as named export for compatibility.
 */
export { register };
