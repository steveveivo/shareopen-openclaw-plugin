/**
 * ShareOpen Channel Plugin — Setup Entry
 * 
 * This file is loaded by OpenClaw before the plugin runtime starts,
 * for commands like `status`, `channels list`, `channels status`, and SecretRef scans.
 * Must NOT start clients, listeners, or transport runtimes.
 */

/**
 * Returns channel metadata and config adapter for setup surfaces.
 * @returns {object}
 */
export function getChannelMetadata() {
  return {
    id: "shareopen",
    name: "ShareOpen",
    description: "ShareOpen IM platform — local Agent IM via WebSocket gateway.",
    configPrefix: "channels.shareopen",
  };
}
