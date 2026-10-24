/**
 * ShareOpen Channel Plugin — Plugin API
 * 
 * Implements the full ChannelPlugin capability contract.
 * Exported as `shareopenPlugin` for use by the entry point.
 */

import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";

const CHANNEL_ID = "shareopen";

/**
 * Resolve account config from OpenClaw channel config.
 */
function resolveAccount(config) {
  return {
    wsUrl: config?.wsUrl || process.env.SHAREOPEN_WS_URL,
    token: config?.token || process.env.SHAREOPEN_TOKEN,
    agentId: config?.agentId || process.env.SHAREOPEN_AGENT_ID || "green",
    dmPolicy: config?.dmPolicy || "open",
    allowFrom: config?.allowFrom || ["*"],
  };
}

/**
 * Build the full channel plugin using the official SDK.
 */
export const shareopenPlugin = createChatChannelPlugin({
  id: CHANNEL_ID,
  base: {
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

    /**
     * Setup — account resolution.
     */
    setup: {
      resolveAccount,
    },

    /**
     * Security — DM policy enforcement.
     */
    security: {
      dm: {
        channelKey: "shareopen",
        resolvePolicy: (account) => account?.dmPolicy || "open",
        resolveAllowFrom: (account) => account?.allowFrom || ["*"],
      },
    },

    /**
     * Outbound adapter — sends agent replies to ShareOpen.
     */
    outbound: (account, _config, _ctx) => {
      return {
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
      };
    },

    /**
     * Threading config — how sessions map to conversations.
     */
    threading: {
      sessionKeySeparator: ":",
      threadSeparator: "/",
      threadIdInSessionKey: true,
    },
  },
});

export default shareopenPlugin;
