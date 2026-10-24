/**
 * ShareOpen Channel Plugin — Setup Entry
 *
 * Implements the "bundled-channel-setup-entry" contract expected by
 * OpenClaw doctor's legacy-state-migration detector:
 *   - kind: "bundled-channel-setup-entry"
 *   - loadSetupPlugin(options) -> setup plugin module
 *
 * This plugin is STATELESS with respect to legacy channel state:
 * ShareOpen sessions are owned by the ShareOpen backend (SQLite + WS
 * server), not by OpenClaw's legacy JSON store. So we do NOT declare
 * features.legacyStateMigrations — doctor registers us as a
 * stateless plugin and clears any "retained state migration pending"
 * marker.
 *
 * The setup plugin object exposes a standard named-account `config`
 * surface (listAccountIds / resolveAccount / inspectAccount / ...)
 * so doctor's account-inspection maintenance path works.
 */

const CHANNEL = "shareopen";

function sectionKey() {
  return "channels." + CHANNEL;
}

function resolveAccountFromCfg(cfg, accountId) {
  const section = (cfg && cfg.channels && cfg.channels[CHANNEL]) || {};
  const accounts = section.accounts || {};
  if (accountId && accounts[accountId]) {
    return { ...section, ...accounts[accountId] };
  }
  return section;
}

function inspectAccountFromCfg(cfg, accountId) {
  const account = resolveAccountFromCfg(cfg, accountId);
  const configured = Boolean(account && (account.wsUrl || process.env.SHAREOPEN_WS_URL) && (account.token || process.env.SHAREOPEN_TOKEN));
  return {
    accountId: accountId || "default",
    configured,
    enabled: account ? account.enabled !== false : true,
    state: configured ? "connected" : "unconfigured",
  };
}

const setupPlugin = {
  id: CHANNEL,
  meta: {
    name: "ShareOpen",
    description: "ShareOpen IM platform — local Agent IM via WebSocket gateway.",
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
  // Standard named-account config surface (single "default" account
  // plus optional channels.shareopen.accounts.* entries).
  config: {
    listAccountIds(cfg) {
      const section = (cfg && cfg.channels && cfg.channels[CHANNEL]) || {};
      const ids = new Set(Object.keys(section.accounts || {}));
      if (section.wsUrl || section.token || process.env.SHAREOPEN_WS_URL || process.env.SHAREOPEN_TOKEN) {
        ids.add("default");
      }
      return [...ids];
    },
    defaultAccountId() {
      return "default";
    },
    resolveAccount(cfg, accountId) {
      return resolveAccountFromCfg(cfg, accountId);
    },
    inspectAccount(cfg, accountId) {
      return inspectAccountFromCfg(cfg, accountId);
    },
    setAccountEnabled(cfg, accountId, enabled) {
      // Read-only surface: account enablement is managed in config.
      return { enabled };
    },
  },
};

module.exports = {
  kind: "bundled-channel-setup-entry",
  // No legacy state migrations: ShareOpen keeps its own session state.
  loadSetupPlugin: () => setupPlugin,
};
