// ShareOpen Channel Plugin — Correct OpenClaw Plugin Structure
// Uses defineChannelPluginEntry from openclaw/plugin-sdk/channel-core

import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  defineChannelPluginEntry,
  createChatChannelPlugin,
  createChannelPluginBase,
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
} from 'openclaw/plugin-sdk/channel-core';

const CHANNEL_ID = 'shareopen';

// Kernel command-turn context for text slash commands (Telegram-style
// text-slash turns). Plain messages -> undefined (normal turn).
function chatTypeSlash(body) {
  const b = typeof body === 'string' ? body.trim() : '';
  if (!b.startsWith('/')) return undefined;
  const name = b.slice(1).split(/\s+/, 1)[0]?.split('@', 1)[0] || '';
  // Menu IS the allowlist: only registered commands reach the kernel's
  // slash-command pipeline. Unregistered names (/bash, /config, ...)
  // fall through as ordinary chat text and can never hit exec surfaces.
  if (!name || !SHARE_COMMANDS.some((c) => c.name === name.toLowerCase())) return undefined;
  return { kind: 'text-slash', source: 'text', authorized: true, commandName: name || undefined, body: b };
}

// Default slash commands exposed to ShareOpen (Telegram-style menu).
// Owner-only operational commands can be added here as the catalog grows;
// permission_level is enforced server-side (user|admin).
// Curated OpenClaw built-in command set (docs/tools/slash-commands.md).
// The registered menu IS the allowlist: host-level commands (/bash, /exec,
// /config, /debug, /restart, /plugins, /mcp, /send, /phone, /pair, /login)
// are intentionally NOT registered so they never surface in ShareOpen.
const SHARE_COMMANDS = [
  { name: 'help', description: 'List available commands', category: 'general' },
  { name: 'commands', description: 'Show generated command catalog', category: 'general' },
  { name: 'status', description: 'Agent runtime, uptime & usage status', category: 'general' },
  { name: 'tools', description: 'Show tools available right now', category: 'general' },
  { name: 'context', description: 'Explain how context is assembled', category: 'general' },
  { name: 'usage', description: 'Usage footer: off|tokens|full|reset|cost', category: 'general' },
  { name: 'whoami', description: 'Show your sender id', category: 'general' },
  { name: 'new', description: 'Archive session, start fresh', category: 'session' },
  { name: 'reset', description: 'Reset current session in place', category: 'session' },
  { name: 'name', description: 'Name or rename the session', category: 'session' },
  { name: 'compact', description: 'Compact the session context', category: 'session' },
  { name: 'stop', description: 'Abort the current run', category: 'session' },
  { name: 'tasks', description: 'List background tasks', category: 'session' },
  { name: 'subagents', description: 'Inspect sub-agent runs', category: 'session' },
  { name: 'model', description: 'Show or set the model', category: 'model' },
  { name: 'models', description: 'List providers and models', category: 'model' },
  { name: 'think', description: 'Set thinking level (alias /t)', category: 'model' },
  { name: 'verbose', description: 'Verbose output: on|off|full', category: 'model' },
  { name: 'trace', description: 'Plugin trace output: on|off', category: 'model' },
  { name: 'fast', description: 'Fast mode: status|auto|on|off|default', category: 'model' },
  { name: 'reasoning', description: 'Reasoning visibility: on|off|stream', category: 'model' },
  { name: 'elevated', description: 'Elevated mode: on|off|ask|full', category: 'model' },
  { name: 'queue', description: 'Manage run queue behavior', category: 'control' },
  { name: 'steer', description: 'Inject guidance into active run', category: 'control' },
  { name: 'skill', description: 'Run a skill by name', category: 'control' },
  { name: 'approve', description: 'Resolve an approval prompt', category: 'control' },
  { name: 'tts', description: 'Control text-to-speech', category: 'control' },
];

// [FIX 2026-09-27 v4] Module-level inbound handler registry. Root cause of
// the "inbound queued (handler pending)" deadlock: getStreamManager keyed by
// `${wsUrl}:${token}:${agentId}` produced TWO managers — startAccount wired
// the handler on the instance built from ctx.cfg, while outbound.sendMedia
// called getStreamManager(resolveAccount(params.config,...)) and the
// kernel-passed cfg resolved to a DIFFERENT key -> a fresh handler-less
// manager whose WS registered LATER, hijacking agentConnections on the
// backend. Inbound frames then hit the handler-less instance forever.
// Any manager created after startAccount now inherits the handler
// immediately, and every key logs its birth for forensics.
// [FIX 2026-09-27 v5] PROOF the module is double-loaded: gateway start
// logged `NEW StreamManager key=agent:green` at startAccount, then the SAME
// key logged again minutes later — impossible with one module instance
// (the Map would hit). openclaw loads the plugin through two entry paths
// (gateway lifecycle vs channel-runtime dispatch), each with its own module
// registry, so module-level state does NOT bridge them. All cross-path
// state now lives on globalThis.process-wide registry.
const _soRegistry = (globalThis.__shareopenChannelRegistry =
  globalThis.__shareopenChannelRegistry || { managers: new Map(), inboundHandler: null });
const streamManagers = _soRegistry.managers;
let _cfg = null;
let _channelRuntime = null;
let _inboundHandler = null;  // shadow ref; live reads go through _soRegistry
function getInboundHandler() { return _soRegistry.inboundHandler || _inboundHandler; }
function setInboundHandler(fn) { _soRegistry.inboundHandler = fn; _inboundHandler = fn; }

function loadDiskConfig() {
  // Best-effort read of ~/.openclaw/openclaw.json so cron/announce paths
  // can resolve token/wsUrl even when the in-memory _cfg is not cached yet
  // (gateway restart, isolated cron worker, pre-startAccount timer fire).
  try {
    const p = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && j.channels ? j : null;
  } catch {
    return null;
  }
}

function resolveAccount(cfg, accountId) {
  // Cron/fallback announce paths call without a full config; fall back to the
  // config cached at startAccount time so token/wsUrl still resolve.
  // If _cfg is also missing (isolated cron worker / pre-startAccount fire),
  // fall back to reading the on-disk openclaw.json directly — last resort
  // so the cron delivery can still find its token.
  const src = (cfg && cfg.channels && cfg.channels[CHANNEL_ID])
    || (_cfg && _cfg.channels && _cfg.channels[CHANNEL_ID])
    || (() => {
        const disk = loadDiskConfig();
        return disk ? disk.channels[CHANNEL_ID] : null;
      })()
    || {};
  const section = src;
  const token = section.token;
  if (!token) {
    const disk = loadDiskConfig();
    const diskToken = disk && disk.channels && disk.channels[CHANNEL_ID] && disk.channels[CHANNEL_ID].token;
    if (diskToken) {
      console.warn('[ShareOpen] resolveAccount: in-memory config had no token; using on-disk fallback');
      section.token = diskToken;
      section.wsUrl = section.wsUrl || (disk.channels[CHANNEL_ID].wsUrl);
      section.agentId = section.agentId || (disk.channels[CHANNEL_ID].agentId);
    } else {
      throw new Error('shareopen: token is required');
    }
  }
  
  // Build WebSocket URL with token parameter
  let wsUrl = section.wsUrl || 'wss://shareopen.com/ws/agent';
  if (!wsUrl.includes('token=')) {
    wsUrl = wsUrl.replace(/\/$/, '') + `?token=${encodeURIComponent(token)}`;
  }
  
  return {
    accountId: accountId || section.accountId || null,
    wsUrl,
    token,
    agentId: section.agentId || 'green',
    soAgentId: section.soAgentId,
  };
}

function getStreamManager(account) {
  // [FIX 2026-09-27 v4] Key by agentId ONLY. The previous key
  // (wsUrl:token:agentId) split into TWO managers when different call
  // paths (startAccount ctx.cfg vs sendMedia params.config) produced even
  // slightly different resolved values: the handler lived on one instance
  // while the OTHER one's WS connection registered later on the backend and
  // hijacked the agent slot — inbound frames then queued forever on the
  // handler-less instance ("green not replying"). One agent = one socket,
  // period; this channel config is single-account anyway.
  const accountKey = `agent:${account.agentId}`;
  let streamManager = streamManagers.get(accountKey);
  
  if (!streamManager) {
    streamManager = new ShareOpenStreamManager(
      account.wsUrl,
      account.token,
      account.agentId
    );
    console.log('[ShareOpen] NEW StreamManager key=' + accountKey + ' wsUrl=' + account.wsUrl);
    // [FIX 2026-09-27 v5] Inherit the handler from the global registry (may
    // have been registered by a different module copy's startAccount).
    if (getInboundHandler()) streamManager.onInbound = getInboundHandler();
    streamManagers.set(accountKey, streamManager);
  }
  
  return streamManager;
}

// [FIX 2026-09-26] Short-extension → canonical MIME map for outbound frames.
// The ShareOpen backend (lib/agent-attachments.js classify()) expects a full
// MIME type ('image/jpeg'), not a short extension ('jpg'). openclaw kernel
// derives mime from the file extension regex, so normalize it here before
// building the WS attachment frame. Unknown exts are passed through as-is.
const EXT_TO_MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', zip: 'application/zip',
};

// Sync-read fallback for local media files (used by outbound.sendMedia when
// the kernel's async mediaReadFile has not produced bytes yet).
//
// [FIX 2026-09-28] fetchInboundMedia downloads a user-uploaded attachment
// (served by the ShareOpen backend at /api/media/download/<id>) into a
// stable cache dir so the agent can actually open the bytes. Dedup by
// sha1(url)+ext; cap 25MB; returns local path or null.
const INBOUND_MEDIA_DIR = path.join(os.tmpdir(), 'shareopen_inbound_media');
const INBOUND_MEDIA_MAX = 25 * 1024 * 1024;
function fetchInboundMedia(url, fileName) {
  // Node >=18 global fetch: proven reliable in this env; bare http.get
  // callbacks dropped responses here (2026-09-28 incident).
  const run = async () => {
    try {
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const u = new URL(url);
      const digest = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
      const ext = path.extname(fileName || '') || path.extname(u.pathname) || '.bin';
      fs.mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });
      const dest = path.join(INBOUND_MEDIA_DIR, `so_${digest}${ext}`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      try {
        const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'ShareOpenOpenClawPlugin/1.0' } });
        if (!res.ok) { console.warn(`[ShareOpen] inbound media HTTP ${res.status}: ${url}`); return null; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > INBOUND_MEDIA_MAX) {
          console.warn(`[ShareOpen] inbound media bad size ${buf.length}: ${url}`);
          return null;
        }
        const tmp = dest + '.part';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
        return dest;
      } finally { clearTimeout(timer); }
    } catch (e) {
      console.warn(`[ShareOpen] inbound media fetch error: ${e?.message} url=${url}`);
      return null;
    }
  };
  return run();
}

function resolveLocalMediaBytes(mediaUrl) {
  try {
    if (!mediaUrl || typeof mediaUrl !== 'string') return null;
    let p = mediaUrl;
    if (p.startsWith('~')) p = p.replace(/^~(?=[/\\]|$)/, process.env.HOME || '');
    if (!path.isAbsolute(p)) return null;
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    const s = fs.statSync(p);
    if (s.size > 25 * 1024 * 1024) return null;
    return fs.readFileSync(p);
  } catch { return null; }
}

class ShareOpenStreamManager {
  constructor(wsUrl, token, agentId) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.agentId = agentId;
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    // [FIX 2026-09-26] nginx 空闲超时会静默 RST 掉 WS 连接。上限从 10
    // 提到 15，让指数退避能撑过更多 30s 空闲窗口而不彻底放弃。
    this.maxReconnectAttempts = 15;
    this.heartbeatTimer = null;
    // [FIX 2026-09-27 v3] Inbound frames that arrive before startAccount()
    // wires onInbound are queued here and flushed the instant onInbound is
    // assigned (setter below). Never rely on a drain call site: openclaw's
    // gateway lifecycle can order WS connect BEFORE startAccount, so any
    // drain scheduled at a fixed point races and loses frames (observed:
    // queue depth climbed to 2 with no drain, green silent).
    this._inboundQueue = [];
    this._onInbound = null;
  }

  // onInbound as an accessor: assigning it flushes anything queued while
  // no handler existed. Writing `manager.onInbound = <closure>` is the only
  // place the handler ever becomes available, so this is the correct sync
  // point.
  set onInbound(fn) {
    this._onInbound = fn;
    if (typeof fn === 'function') this._flushInbound();
  }
  get onInbound() {
    return this._onInbound;
  }

  _flushInbound() {
    if (!this._inboundQueue || !this._inboundQueue.length) return;
    const queued = this._inboundQueue.splice(0, this._inboundQueue.length);
    console.log('[ShareOpen] flushing ' + queued.length + ' queued inbound frame(s) to handler');
    for (const q of queued) {
      try {
        Promise.resolve(this._onInbound(q)).catch((err) =>
          console.error('[ShareOpen] queued inbound error:', err.message));
      } catch (err) {
        console.error('[ShareOpen] queued inbound error:', err.message);
      }
    }
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;
        
        ws.on('open', () => {
          console.log(`[ShareOpen] Connected to ${this.wsUrl}`);
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          this.registerCommands();

          // Handler defense: on every (re)connect, re-bind all handlers if
          // they went null, then re-fire the backend catchup so queued
          // inbound messages get redelivered.
          // [FIX 2026-09-27] Always rebind when _rebindInbound is available.
          // The previous `!this.onInbound` guard was the bug: onInbound was
          // set in startAccount() BEFORE the first connect() finished, so the
          // guard saw a truthy value and skipped the rebind on reconnects.
          // Worse, a gateway restart builds a FRESH ShareOpenStreamManager
          // (getStreamManager map is module-scoped, re-inited), whose
          // _rebindInbound is not yet wired — inbound frames during that
          // window hit handleMessage's "no handler wired" branch and were
          // silently dropped (the 14:35 "inbound message dropped" incident).
          // Now: rebind every connect if _rebindInbound exists; if not, queue
          // inbound frames until startAccount() installs the handler.
          if (typeof this._rebindInbound === 'function') this._rebindInbound();
          // Tell the backend to re-send queued/catchup frames for this agent.
          // It is idempotent and safe to call on every reconnect.
          try { this.ws.send(JSON.stringify({ type: 'request_catchup' })); } catch {}

          resolve();
        });
        
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.handleMessage(msg);
          } catch (err) {
            console.error('[ShareOpen] Failed to parse message:', err.message);
          }
        });
        
        ws.on('error', (err) => {
          console.error('[ShareOpen] WebSocket error:', err.message);
        });
        
        ws.on('close', (code, reason) => {
          // [FIX 2026-09-26] 之前 close 不记原因，nginx 空闲超时静默 RST
          // 和主动断开在日志里分不出来。带上 code/reason，4xxx 段是
          // 自定义原因码；1006 = 异常断开（网络 RST/超时最典型）。
          console.log('[ShareOpen] Connection closed: code=' + (code ?? 'n/a') +
            ' reason=' + String(reason || '').slice(0, 120) +
            ' reconnectAttempts=' + this.reconnectAttempts);
          this.ws = null;
          this.scheduleReconnect();
        });
      } catch (err) {
        reject(err);
      }
    });
  }
  
  // Publish our slash-command menu to the ShareOpen commands table.
  // Idempotent across reconnects: an 'already exists' ack is expected & ignored.
  registerCommands() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const cmd of SHARE_COMMANDS) {
      try {
        this.ws.send(JSON.stringify({ type: 'command_register', command: cmd }));
      } catch (err) {
        console.error('[ShareOpen] command_register send failed:', err.message);
      }
    }
  }

  sendCommandResponse(invocationId, patch) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[ShareOpen] Cannot send command_response: WS not open');
      return false;
    }
    this.ws.send(JSON.stringify({
      type: 'command_response',
      invocation_id: invocationId,
      response: patch,
    }));
    return true;
  }

  startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    // [FIX 2026-09-26] ping 间隔从 30s 压到 20s。nginx proxy_read_timeout
    // 通常是 60s，30s 的 ping 在 agent 长回复期间仍可能让 TCP 半开连接
    // 被中间层判死。20s 给足余量，保持连接存活。
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch {}
      }
    }, 20000);
  }
  
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[ShareOpen] Max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[ShareOpen] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }
  
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  
  handleMessage(msg) {
    const { type, conversationId, content, status, message } = msg;

    if (type === 'command_invocation') {
      if (this.onCommand) {
        this.onCommand(msg).catch((err) =>
          console.error('[ShareOpen] command handler error:', err.message));
      } else {
        this.sendCommandResponse(msg.invocation_id, { status: 'failed', error: 'Commands not supported by this connector' });
      }
    } else if (type === 'component_callback') {
      // P2 Feature C: {component_id, value, user_id, conversation_id} —
      // replay value as a user-typed slash command through the kernel.
      if (this.onComponentCallback) {
        this.onComponentCallback(msg).catch((err) =>
          console.error('[ShareOpen] component_callback handler error:', err.message));
      } else {
        console.warn('[ShareOpen] component_callback dropped (no handler wired)');
      }
    } else if (type === 'progress_update') {
      console.log('[ShareOpen] Progress:', status, message || '');
    } else if (type === 'stream_chunk') {
      console.log('[ShareOpen] Stream chunk:', content?.substring(0, 50));
    } else if (type === 'reaction_added' || type === 'reaction_removed') {
      // v1.3.0: user reactions to agent messages (like/dislike feedback).
      // Payload: {message_id, conversation_id, emoji, reacter_id, reacter_name, text_preview, timestamp, catchup?}
      // Injected into the current session so the agent can perceive feedback
      // on its own replies — mirrors internal-agent prompt injection.
      const emoji = msg.emoji || '';
      const actor = msg.reacter_name || msg.reacter_id || 'a user';
      const note = type === 'reaction_added'
        ? `${actor} reacted ${emoji} to your reply${msg.text_preview ? ` ("${msg.text_preview.slice(0, 60)}…")` : ''}${msg.catchup ? ' [received while offline]' : ''}`
        : `${actor} removed their ${emoji} reaction to your reply${msg.catchup ? ' [received while offline]' : ''}`;
      console.log(`[ShareOpen] feedback: ${note}`);
      if (this.onInbound) {
        this.onInbound({
          conversation_id: msg.conversation_id,
          message: `[user feedback] ${note}`,
          user_id: msg.reacter_id,
          message_id: msg.message_id,
          is_reaction_note: true,
        }).catch((err) =>
          console.error('[ShareOpen] reaction note handler error:', err.message));
      }
    } else if ((type === 'message' && (msg.data?.message || msg.data?.media)) || (type === 'text_message' && (msg.content || msg.media))) {
      // Inbound user message from ShareOpen backend — route to the OpenClaw agent.
      // Real-time shape: {type:'message', data:{conversation_id, message, media?, user_id, message_id}}
      // Queued-replay shape: {type:'text_message', conversation_id, content, media?, user_id, message_id}
      // [FIX 2026-09-28] `|| msg.data?.media` — media-only messages have an
      // EMPTY text; requiring truthy .message silently dropped every lone
      // image/audio the user sent (2026-09-28 "green 无反应" incident).
      const data = type === 'message' ? msg.data : {
        conversation_id: msg.conversation_id, message: msg.content,
        media: msg.media || undefined,
        user_id: msg.user_id, message_id: msg.message_id,
      };
      if (this.onInbound) {
        this.onInbound(data).catch((err) =>
          console.error('[ShareOpen] inbound handler error:', err.message));
      } else {
        // [FIX 2026-09-27] Don't drop — queue until startAccount() installs
        // onInbound (or until this manager instance is replaced). A gateway
        // restart builds a fresh manager; frames that arrive before its
        // startAccount() finish would otherwise vanish silently (the 14:35
        // "inbound message dropped" incident).
        if (!this._inboundQueue) this._inboundQueue = [];
        this._inboundQueue.push(data);
        console.log('[ShareOpen] inbound queued (handler pending):', data.conversation_id,
          'queue depth=' + this._inboundQueue.length);
      }
      // [FIX 2026-09-27] Back-fill _convByUser IMMEDIATELY, inside
      // handleMessage (synchronous on the inbound frame). This guarantees
      // that when the openclaw kernel fires sendMedia during the agent turn
      // (tool call), the live conversation is already in the map. Without
      // this, sendMedia only saw _convByUser populated AFTER inbound.run's
      // dispatch completed — and sendMedia can fire before that.
      if (data.user_id && data.conversation_id) {
        if (!this._convByUser) this._convByUser = new Map();
        this._convByUser.set(data.user_id, data.conversation_id);
      }
    }
  }

  // Send the agent's reply back to the ShareOpen backend.
  // Field names MUST be snake_case (conversation_id/content) — backend
  // handleHermesStreamingMessage reads msg.conversation_id / msg.content.
  sendAgentMessage(conversationId, text, attachments) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Diagnostic: WS is not open at send time. Log why (state + reconnect attempts).
      const state = this.ws ? this.ws.readyState : 'no-socket';
      console.error('[ShareOpen] Cannot deliver reply: WS not open (state=' + state + ', reconnectAttempts=' + this.reconnectAttempts + ')');
      return false;
    }
    const atts = Array.isArray(attachments) ? attachments : [];
    // [FIX 2026-09-26] Send as agent_message (matches the Hermes official
    // plugin's frame type, which is verified to land in media_files on
    // production). Both agent_message and text_message route to
    // handleHermesStreamingMessage in ws-server.js:221, so this is a
    // safe change that aligns with the known-good Tom baseline.
    const frame = {
      type: 'agent_message',
      conversation_id: conversationId,
      content: String(text || ''),
      ...(atts.length ? { attachments: atts } : {}),
    };
    // OBSERVE-ONLY: dump the exact outbound frame so we can diff agent-side
    // frame shape vs what the server's handleHermesStreamingMessage expects.
    // No behavior change — same frame as before, just logged.
    const safeAtts = atts.map(a => {
      const c = { ...a };
      if (c.data_b64) c.data_b64 = c.data_b64.slice(0, 40) + '…(len=' + c.data_b64.length + ')';
      return c;
    });
    console.log('[ShareOpen][FRAME-DUMP] ' + JSON.stringify({ ...frame, attachments: safeAtts }));
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  async sendText(to, text, context = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    
    // Prefer the ShareOpen conversation id; snake_case fields to match backend.
    const convId = context.conversationId || context.conversation_id || to;
    const message = {
      type: 'text_message',
      conversation_id: convId,
      content: text,
      recipientId: to,
      timestamp: new Date().toISOString()
    };
    
    try {
      this.ws.send(JSON.stringify(message));
      return { messageId: Date.now().toString(), status: 'delivered' };
    } catch (err) {
      console.error('[ShareOpen] Failed to send:', err.message);
      throw err;
    }
  }
  
  async sendStreaming(to, text, context = {}) {
    return this.sendText(to, text, context);
  }

  // P2 Feature A: additive component_message primitive — same WS as replies.
  // Frame shape: {type:'component_message', conversation_id, text,
  //   component_id, component_type, config}. The plain text_message reply is
  //   ALWAYS still sent; this only attaches renderable UI (buttons/select).
  sendComponentMessage({ conversation_id, text, component_id, component_type, config }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[ShareOpen] Cannot send component_message: WS not open');
      return false;
    }
    try {
      this.ws.send(JSON.stringify({
        type: 'component_message',
        conversation_id,
        text: String(text || ''),
        component_id,
        component_type,
        config,
      }));
      return true;
    } catch (err) {
      console.error('[ShareOpen] Failed to send component_message:', err.message);
      return false;
    }
  }
}

// ========== P2 Feature B: reply post-processing parsers ==========
// Text-parse -> component_message (NOT native kernel presentation; the kernel
// payload probe showed presentation/interactive are null for this channel).
// Both parsers are strictly ADDITIVE: called after the text_message reply has
// been delivered; any parse/send failure is logged, never blocks the reply.

// Approval-fence detector: exec-approval replies contain one or more
// '/approve <id> allow-once|allow-always|deny' lines plus a ⚠️/… marker.
// Emits ONE button component wired to replay the exact slash command.
// ========== Attachment extraction (outbound MEDIA: protocol) ==========
// Agent replies containing a MEDIA:/abs/path or MEDIA:url tag get the
// attachment stripped from the text and delivered as a structured
// attachment so the ShareOpen backend can render a file bubble.
const ALLOWED_EXT_OUT = new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','md','json','zip','tar','png','jpg','jpeg','gif','webp','bmp','mp3','wav','ogg','m4a','mp4','webm','mov','sqlite','db']);
const MIME_MAP_OUT = { pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls:'application/vnd.ms-excel', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt:'application/vnd.ms-powerpoint', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation', csv:'text/csv', txt:'text/plain', md:'text/markdown', json:'application/json', zip:'application/zip', tar:'application/x-tar', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4', mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', sqlite:'application/x-sqlite3', db:'application/x-sqlite3' };
const MEDIA_RE_GLOBAL = /(?:MEDIA:|MEDIA)\s+(\S+)/g;

function extractReplyAttachments(text, { maxFiles = 5, maxBytes = 25 * 1024 * 1024 } = {}) {
  const clean = String(text ?? '');
  const matches = [...clean.matchAll(MEDIA_RE_GLOBAL)];
  if (!matches.length) return { cleanText: clean, attachments: [] };
  const attachments = [];
  const seen = new Set();
  let idx = 0;
  for (const m of matches) {
    if (attachments.length >= maxFiles) break;
    const raw = (m[1] || '').trim();
    const localFile = raw.startsWith('MEDIA:') ? raw.slice(6).trim() : raw;
    if (!localFile || seen.has(localFile)) continue;
    seen.add(localFile);
    if (/^https?:\/\//.test(localFile)) {
      const ext = localFile.split('.').pop().toLowerCase() || '';
      attachments.push({ source: 'url', file_id: `url_${idx++}`, media_type: MIME_MAP_OUT[ext] || 'application/octet-stream', media_url: localFile, file_name: localFile.split('/').pop() || 'attachment', file_size: null, data_b64: null, encoding: null, caption: null });
      continue;
    }
    let absPath = localFile;
    if (absPath.startsWith('~')) absPath = absPath.replace(/^~(?=$|\/|\\)/, process.env.HOME || '');
    if (!path.isAbsolute(absPath)) absPath = path.resolve(absPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) { console.warn(`[ShareOpen] attachment missing: ${absPath}`); continue; }
    const stat = fs.statSync(absPath);
    if (stat.size > maxBytes) { console.warn(`[ShareOpen] attachment too large: ${absPath} (${stat.size}B)`); continue; }
    const ext = path.extname(absPath).slice(1).toLowerCase();
    if (ext && !ALLOWED_EXT_OUT.has(ext)) { console.warn(`[ShareOpen] attachment type not allowed: .${ext}`); continue; }
    const b64 = Buffer.from(fs.readFileSync(absPath)).toString('base64');
    attachments.push({ source: 'file', file_id: `b64_${idx++}`, media_type: MIME_MAP_OUT[ext] || 'application/octet-stream', media_url: null, file_name: path.basename(absPath), file_size: stat.size, data_b64: b64, encoding: 'base64', caption: null });
  }
  const cleanText = clean.replace(MEDIA_RE_GLOBAL, '').replace(/MEDIA:/g, '').trim();
  return { cleanText, attachments };
}

function parseApprovalButtons(text) {
  try {
    const src = String(text || '');
    if (!/\/approve\s+/.test(src)) return null;
    if (!/⚠️|approval|exec/i.test(src)) return null; // avoid false positives
    const re = /\/approve\s+([A-Za-z0-9_-]{4,})\s+(allow-once|allow-always|deny)/g;
    const ids = [];
    for (let m; (m = re.exec(src)); ) {
      if (!ids.includes(m[1])) ids.push(m[1]);
    }
    if (!ids.length) return null;
    const id = ids[0];
    // Prompt = the short human line before the first /approve fence
    // (e.g. the ⚠️ header); fall back to a generic Chinese prompt.
    let prompt = 'Choose approval action';
    const firstIdx = src.search(/\/approve\s+[A-Za-z0-9_-]{4,}\s+(allow-once|allow-always|deny)/);
    if (firstIdx > 0) {
      const header = src.slice(0, firstIdx).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (header) prompt = header;
    }
    return {
      component_type: 'button',
      component_id: `appr_${id}_${Date.now()}`,
      config: {
        prompt,
        buttons: [
          { label: '✅ allow-once', value: `/approve ${id} allow-once` },
          { label: '🟦 allow-always', value: `/approve ${id} allow-always` },
          { label: '🗑 deny', value: `/approve ${id} deny` },
        ],
      },
    };
  } catch (err) {
    console.error('[ShareOpen] parseApprovalButtons error:', err.message);
    return null;
  }
}

// Model-picker parser for /model|/models text replies. Entries are lines
// like '- provider/model-id (Context: …)'. Current model from 'Current:'
// or the '→' arrow marker. Caps at 25 entries (/model can list 200+).
function parseModelPicker(text) {
  try {
    const src = String(text || '');
    if (!/^\s*-\s+\S+\/\S+/m.test(src)) return null;
    const currentMatch = src.match(/^Current:\s*(\S+)/m) || src.match(/→\s*(\S+)/m);
    const current = currentMatch ? currentMatch[1].replace(/[✓]\s*$/, '') : '';
    const models = [];
    for (const line of src.split('\n')) {
      const m = line.match(/^\s*-\s+(\S+\/\S+)/);
      if (!m) continue;
      const id = m[1];
      if (/^(Default|Current):/i.test(id)) continue;
      if (!models.includes(id)) models.push(id);
      if (models.length >= 25) break;
    }
    if (!models.length) return null;
    // Truncation flag: more '- provider/model' lines exist after the 25th pick.
    let truncated = false;
    {
      const lastIdx = src.lastIndexOf(models[models.length - 1]);
      const tailRe = /^\s*-\s+\S+\/\S+/m;
      for (const line of (lastIdx >= 0 ? src.slice(lastIdx + models[models.length - 1].length) : '').split('\n')) {
        if (tailRe.test(line)) { truncated = true; break; }
      }
    }
    if (models.length <= 8) {
      return {
        component_type: 'button',
        component_id: `mdl_${Date.now()}`,
        config: {
          prompt: current ? `Current: ${current}` : 'Select a model',
          buttons: models.map((mo) => ({
            label: (mo === current ? '✓ ' : '') + mo,
            value: `/model ${mo}`,
          })),
        },
      };
    }
    return {
      component_type: 'select',
      component_id: `mdl_${Date.now()}`,
      config: {
        prompt: (current ? `Current: ${current}` : 'Select a model') + (truncated ? ' …(first 25)' : ''),
        options: models.map((mo) => ({ value: `/model ${mo}`, label: mo + (mo === current ? ' ✓' : '') })),
        buttons: [{ label: 'Submit', value: '__submit__' }],
      },
    };
  } catch (err) {
    console.error('[ShareOpen] parseModelPicker error:', err.message);
    return null;
  }
}

// Config-driven model picker (P2 hotfix): this OpenClaw build's bare /model
// emits help text, not a "- provider/model" list — the interactive picker is
// kernel-native only on Telegram/Discord. Build it from the SAME source the
// native picker uses: agents.defaults.models (+ primary/fallbacks markers).
function buildModelPickerFromConfig(replyText) {
  try {
    const raw = Object.keys(_cfg?.agents?.defaults?.models || {}).filter((m) => m.includes('/'));
    // Non-chat models (image/video/tts) are not selectable as the session LLM.
    const models = raw.filter((m) => !/image|video|wan|tts|embed/i.test(m.split('/').pop() || '')).sort();
    if (!models.length) return null;
    let current = '';
    const cm = String(replyText || '').match(/^Current:\s*(\S+)/m);
    if (cm) current = cm[1];
    const primary = _cfg?.agents?.defaults?.model?.primary || '';
    const options = models.map((mo) => {
      let label = mo;
      if (mo === current) label += ' ✓ current';
      else if (mo === primary) label += ' (default)';
      return { value: `/model ${mo}`, label };
    });
    const prompt = current ? `Current: ${current} — ${models.length} available` : `Select a model — ${models.length} available`;
    return {
      component_type: 'select',
      component_id: `mdl_${Date.now()}`,
      config: { prompt, options, buttons: [{ label: 'Submit', value: '__submit__' }] },
    };
  } catch (err) {
    console.error('[ShareOpen] buildModelPickerFromConfig error:', err.message);
    return null;
  }
}

// Channel plugin definition — using correct structure from VAP plugin
const shareopenPlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: CHANNEL_ID,
      meta: { label: 'ShareOpen', blurb: 'ShareOpen channel with WebSocket streaming', systemImage: 'bot' },
      config: {
        listAccountIds(cfg) {
          const s = cfg.channels && cfg.channels[CHANNEL_ID];
          return (s && s.token) ? [s.accountId || 'default'] : [];
        },
        resolveAccount,
        isEnabled: (a) => Boolean(a?.token),
        isConfigured: (a) => Boolean(a?.token),
      },
      setup: {
        resolveAccount,
        applyAccountConfig(p) {
          const n = JSON.parse(JSON.stringify(p.cfg));
          if (!n.channels) n.channels = {};
          if (!n.channels[CHANNEL_ID]) n.channels[CHANNEL_ID] = {};
          const s = n.channels[CHANNEL_ID];
          if (p.input.wsUrl) s.wsUrl = p.input.wsUrl;
          if (p.input.token) s.token = p.input.token;
          if (p.input.agentId) s.agentId = p.input.agentId;
          s.dmPolicy = 'open';
          return n;
        },
      },
    }),
    // messaging must be spread into the base object literal (NOT passed through
    // createChannelPluginBase, which does not forward unknown keys). The kernel
    // reads plugin.messaging.targetResolver / .resolveOutboundSessionRoute to
    // resolve outbound targets for the message tool.
    messaging: {
      targetResolver: {
        // Tell openclaw core that ShareOpen targets look like user/conv/agent ids.
        looksLikeId: (raw) => {
          const v = String(raw ?? '').trim().replace(/^(shareopen:|user:|channel:)/i, '');
          return /^conv_[a-z0-9]+/i.test(v) || /^u_[a-z0-9]+/i.test(v) || /^hermes_[a-z0-9]+/i.test(v) ? v : undefined;
        },
        // Resolve a ShareOpen target to its canonical id. ShareOpen user ids
        // (u_xxx), conversation ids (conv_xxx), and agent ids (hermes_xxx)
        // are directly addressable — no directory lookup needed.
        resolveTarget: async ({ input }) => {
          const raw = String(input ?? '').trim().replace(/^(shareopen:|user:|channel:)/i, '');
          if (!raw || raw === 'shareopen') return undefined;
          return { to: raw, kind: 'user', display: raw, source: 'plugin' };
        },
        hint: '<shareopen-user-or-conv-id, e.g. u_demo or conv_xxx>',
      },
      // Outbound session route: the kernel uses this to route outbound
      // messages/attachments to the ShareOpen target for the current session.
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const peer = String(target ?? '').trim().replace(/^(shareopen:|user:|channel:)/i, '');
        if (!peer) return null;
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          recipientSessionExact: true,
          peer: { kind: 'direct', id: peer },
          chatType: 'direct',
          from: `${CHANNEL_ID}:${accountId ?? 'default'}`,
          to: peer,
        });
      },
    },
  },
  security: { dm: { channelKey: CHANNEL_ID, resolvePolicy: (a) => 'open', resolveAllowFrom: () => ['*'], defaultPolicy: 'open' } },
  threading: { topLevelReplyToMode: 'reply' },
  outbound: {
    attachedResults: {
      async sendText(params) {
        // DIAGNOSTIC — outbound text delivery is the fallback path that eats
        // every Green image. Log each call so we can see exactly what text
        // (including raw MEDIA: tags, if any) reaches the backend.
        const _diagText = (params.text || params.content || '');
        console.log('[ShareOpen] sendText CALLED to=' + (params.to || params.sessionKey || '?') + ' len=' + String(_diagText).length + ' text=' + String(_diagText).slice(0, 150).replace(/\n/g, ' | '));
        const uid = (params.to || '').replace(/^shareopen:/, '');
        if (!uid) throw new Error('ShareOpen outbound: no target user');
        const acct = params.accountId || 'default';
        const cfg = params.config || {};
        const account = resolveAccount(cfg, acct);
        const manager = getStreamManager(account);
        const text = params.text || params.content || '';
        // P1 outbound MEDIA: extraction — the kernel's managed-media path
        // silently drops local media for non-webchat channels (ShareOpen is
        // one), leaving the MEDIA: tag inside the text. Re-parse it here so
        // images/files/voice actually reach the backend as attachments.
        const { cleanText, attachments: extraAtts } = extractReplyAttachments(text);
        const payloadText = cleanText || text;
        // If the reply carried attachments and we are in the streaming reply
        // path, deliver them with the message so they are not lost.
        if (extraAtts.length && manager.ws && manager.ws.readyState === WebSocket.OPEN) {
          manager.sendAgentMessage(params.sessionKey || uid, payloadText, extraAtts);
          return { messageId: `so_out_${Date.now()}`, status: 'delivered', attachments: extraAtts.length };
        }
        return manager.sendText(uid, payloadText, {
          conversationId: params.sessionKey || uid,
          ...params
        });
      },
      async sendStreaming(params) {
        const uid = (params.to || '').replace(/^shareopen:/, '');
        if (!uid) throw new Error('ShareOpen outbound: no target user');
        const acct = params.accountId || 'default';
        const cfg = params.config || {};
        const account = resolveAccount(cfg, acct);
        const manager = getStreamManager(account);
        const text = params.text || params.content || '';
        return manager.sendStreaming(uid, text, {
          conversationId: params.sessionKey || uid,
          ...params
        });
      },
      // Outbound media: the kernel routes image/file deliveries through this
      // adapter when outbound.sendMedia exists (deliver-prepare: sendMedia or
      // sendFormattedMedia). ctx shape: { to, text(caption), mediaUrl, mediaAccess,
      // mediaReadFile, mediaLocalRoots, cfg, accountId }. We base64-inline the
      // media so the ShareOpen backend stores it (storeAgentAttachment accepts
      // {name, mime, data_b64} or {url}) — no extra upload endpoint needed.
      async sendMedia(params) {
        // DIAGNOSTIC: log the exact shape the kernel passes us so we can see
        // which field actually carries the media. This answers "did sendMedia
        // even get called? with what keys?"
        console.log('[ShareOpen] sendMedia CALLED, keys=' + JSON.stringify(Object.keys(params || {})) + ', mediaUrl=' + (params?.mediaUrl || params?.mediaUrls?.[0] || 'NONE') + ', mediaUrls=' + JSON.stringify(params?.mediaUrls || null).slice(0,200) + ', mediaAccess=' + (params?.mediaAccess ? Object.keys(params.mediaAccess) : 'NONE') + ', to=' + params?.to + ', sessionKey=' + (params?.sessionKey || '').slice(0,60));
        const uid = (params.to || '').replace(/^shareopen:/, '');
        if (!uid) throw new Error('ShareOpen outbound: no target user');
        const acct = params.accountId || 'default';
        const cfg = params.config || {};
        const account = resolveAccount(cfg, acct);
        const manager = getStreamManager(account);
        // [FIX] Prefer the LIVE conversation this user is chatting in right
        // now (tracked per-user from inbound frames). params.sessionKey is a
        // kernel session id that can be stale (survives backend switches /
        // conversation resets) and pointed media deliveries at dead conv ids
        // — images vanished with ok=true while the conv no longer existed.
        const liveConv = manager._convByUser && manager._convByUser.get(uid);
        // [FIX #1 2026-09-27 v2] The kernel can fire sendMedia BEFORE the
        // inbound handler has back-filled _convByUser (tool call in the agent
        // turn races the inbound.run dispatch). In that window liveConv is
        // undefined and the frame fell back to `uid` (a USER id like u_demo),
        // which 3021 cannot resolve to a conversation and silently drops.
        //
        // Two-step recovery:
        //   Step A — if the live WS is open, probe 3021 for the user's most
        //             recent agent conversation (resolve_conversation_request,
        //             handler exists since 2026-09-26, multi-tenant safe).
        //   Step B — if the WS is NOT open (first connect after a restart),
        //             the sendMedia retry loop below re-opens it; on the
        //             FIRST successful attempt after WS open, re-check
        //             _convByUser (handleMessage's synchronous back-fill may
        //             have populated it by then) and, if still empty, probe.
        //             This avoids the "probe over a dead socket" no-op that
        //             silently falls back to uid on the very first attempt.
        let convId = liveConv || params.sessionKey || uid;
        async function probeConvId() {
          if (manager._convByUser && manager._convByUser.get(uid)) {
            return manager._convByUser.get(uid);
          }
          if (!manager.ws || manager.ws.readyState !== WebSocket.OPEN) return null;
          try {
            manager.ws.send(JSON.stringify({ type: 'resolve_conversation_request', user_id: uid }));
            return await new Promise((resolve) => {
              let settled = false;
              const onMsg = (data) => {
                try {
                  const m = JSON.parse(String(data));
                  if (m && m.type === 'conversation_resolved' && m.user_id === uid) {
                    settled = true;
                    if (m.conversation_id && manager._convByUser) manager._convByUser.set(uid, m.conversation_id);
                    resolve(m.conversation_id || null);
                    cleanup();
                  }
                } catch (e) {}
              };
              const cleanup = () => { try { manager.ws.removeListener('message', onMsg); } catch (e) {} };
              manager.ws.on('message', onMsg);
              setTimeout(() => { if (!settled) { cleanup(); resolve(null); } }, 800);
            });
          } catch (e) {
            console.warn('[ShareOpen] convId probe failed: ' + e.message);
            return null;
          }
        }
        const probeResult = await probeConvId();
        if (probeResult) {
          convId = probeResult;
          console.log('[ShareOpen] sendMedia convId probe → ' + convId);
        }
        const caption = params.text || params.content || '';

        // Resolve the media bytes from whatever form the kernel passes us.
        let dataB64 = null;
        let mediaUrl = params.mediaUrl || null;
        let fileName = '';
        let mime = '';
        try {
          // Kernel may pass a data: URL (base64-inlined media) directly.
          if (mediaUrl && /^data:([\w/+-]+);base64,/.test(mediaUrl)) {
            const m = mediaUrl.match(/^data:([\w/+-]+);base64,(.*)$/s);
            mime = m[1] || '';
            dataB64 = m[2];
            fileName = mediaUrl.split('/').pop() || 'attachment';
          } else if (mediaUrl && /^https?:\/\//.test(mediaUrl)) {
            fileName = mediaUrl.split('/').pop() || 'attachment';
            mime = mediaUrl.match(/\.(\w+)$/)?.[1] || '';
          } else if (mediaUrl && params.mediaAccess?.readFile) {
            // mediaAccess.readFile is async in the kernel (returns Promise<Buffer>).
            let buf;
            try {
              buf = await Promise.resolve(params.mediaAccess.readFile(mediaUrl));
            } catch (readErr) {
              console.warn('[ShareOpen] sendMedia: mediaAccess.readFile failed (' + readErr.message + '), falling back to sync local read');
            }
            if (buf && buf.length !== undefined && !Buffer.isBuffer(buf) && buf.constructor?.name === 'ArrayBuffer') {
              buf = Buffer.from(buf);
            }
            if (Buffer.isBuffer(buf)) {
              dataB64 = buf.toString('base64');
              fileName = mediaUrl.split('/').pop() || 'attachment';
              mime = mediaUrl.match(/\.(\w+)$/)?.[1] || '';
            } else if (typeof buf === 'string') {
              // Some kernel builds return a base64 string, not a Buffer.
              dataB64 = buf;
              fileName = mediaUrl.split('/').pop() || 'attachment';
              mime = mediaUrl.match(/\.(\w+)$/)?.[1] || '';
            }
            // If nothing readable from the kernel reader, fall through to the
            // sync local read below (deterministic).
          }
          // Deterministic last-resort: sync-read the local file ourselves.
          // This guarantees bytes even if the kernel's async reader returns
          // something unexpected (Promise we couldn't await, non-Buffer value,
          // or throws).
          if (!dataB64 && mediaUrl && !/^https?:/.test(mediaUrl) && !/^data:/.test(mediaUrl)) {
            const fb = resolveLocalMediaBytes(mediaUrl);
            if (fb) {
              dataB64 = fb.toString('base64');
              fileName = mediaUrl.split('/').pop() || 'attachment';
              mime = mediaUrl.match(/\.(\w+)$/)?.[1] || '';
              console.log('[ShareOpen] sendMedia: local sync-read OK (' + fb.length + 'B) for ' + mediaUrl);
            }
          }
          if (!dataB64 && !mediaUrl) throw new Error('no media source');
          } catch (err) {
          console.warn('[ShareOpen] sendMedia: failed to read media bytes:', err.message, '| mediaUrl was:', mediaUrl && mediaUrl.slice(0,80));
          }
          // Guarantee bytes for local files regardless of any error above.
          if (!dataB64 && mediaUrl && !/^https?:/.test(mediaUrl) && !/^data:/.test(mediaUrl)) {
          const fb = resolveLocalMediaBytes(mediaUrl);
          if (fb) {
            dataB64 = fb.toString('base64');
            fileName = mediaUrl.split('/').pop() || 'attachment';
            mime = mediaUrl.match(/\.(\w+)$/)?.[1] || '';
            console.log('[ShareOpen] sendMedia: post-catch local sync-read OK (' + fb.length + 'B)');
          }
          }

        const attachment = {
          source: dataB64 ? 'file' : 'url',
          name: fileName || 'attachment',
          // [FIX 2026-09-26] The backend's agent-attachments.js classify()
          // expects a full MIME type ('image/jpeg'), not a short extension
          // ('jpg'). 'jpg' does not match any MIME_TO_DIR key ('image/'/'audio/']/video/'),
          // so classify() falls back to dir='files' and the media_type is wrong.
          // Normalize via a short map; unknown exts keep the raw value.
          mime: (mime && EXT_TO_MIME_MAP[mime.toLowerCase()]) || mime || undefined,
          ...(dataB64 ? { data_b64: dataB64 } : { url: mediaUrl }),
          caption,
        };

        // WS may be in a reconnect window when the kernel dispatches media.
        // Wait for a live socket instead of silently falling back to text-only.
        // Retry every 2s, up to ~30s.
        // [FIX 2026-09-27 v2] If convId was computed while the WS was closed
        // (probe no-op → fell back to uid), re-resolve it on the FIRST
        // iteration where the socket is open. The sendMedia retry loop is
        // the natural re-resolution point: by the time the socket is open
        // again, handleMessage's synchronous back-fill has usually populated
        // _convByUser, and if not, probe again over the live socket.
        let convIdResolved = false;
        const deliverWithRetry = async (retries = 15) => {
          for (let i = 0; i <= retries; i++) {
            if (manager.ws && manager.ws.readyState === WebSocket.OPEN) {
              if (!convIdResolved) {
                const reconv = await probeConvId();
                if (reconv && reconv !== convId) {
                  convId = reconv;
                  console.log('[ShareOpen] sendMedia re-resolved convId → ' + convId + ' (was ' + uid + ')');
                }
                convIdResolved = true;
              }
              const ok = manager.sendAgentMessage(convId, caption, [attachment]);
              console.log('[ShareOpen] sendMedia attempt ' + i + ': ok=' + ok + ', convId=' + convId + ', attachments=' + (attachment ? 1 : 0) + ', dataB64Len=' + (dataB64 ? dataB64.length : 0));
              if (ok) return true;
            } else {
              // [FIX] manager.ws is null (silent nginx RST or between reconnects).
              // The old code just polled this.ws and gave up after 30s. Now:
              // explicitly trigger manager.connect() so a fresh socket is created
              // even when scheduleReconnect's backoff would not have fired yet,
              // and stretch the window to cover the exponential reconnect backoff.
              console.log('[ShareOpen] sendMedia attempt ' + i + ': WS not open (state=null), triggering connect + waiting 2s');
              try { manager.connect().catch(() => {}); } catch {}
            }
            if (i < retries) {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
          console.warn('[ShareOpen] sendMedia: all retries exhausted, attachment LOST');
          return false;
        };
        // [FIX] 15x2s=30s was too short to cover reconnect backoff
        // (scheduleReconnect caps at 30s delay alone). Stretch to 90s total.
        const ok = await deliverWithRetry(45);
        if (!ok) {
          // WS down — queue text fallback so the caption is not lost.
          // The attachment bytes are already in dataB64; if WS is still open
          // we could retry once, but the kernel's delivery queue already
          // retried — just report fallback status.
          manager.sendText(uid, caption || '[attachment]', { conversationId: convId });
        }
        return { messageId: `so_media_${Date.now()}`, status: ok ? 'delivered' : 'fallback' };
      },
    },
    capabilities: {
      draftPreview: true,
      progressUpdates: true,
      interactive: { buttons: false, selects: false },
      commands: false,
    },
  },
  commands: {
    list: () => [],
  },
});

// Add lifecycle methods directly to plugin object
shareopenPlugin.gateway = {
  async startAccount(ctx) {
    const account = resolveAccount(ctx.cfg, ctx.accountId);
    const acctId = ctx.accountId || 'default';
    console.log(`[ShareOpen] Starting account ${acctId}`);
    
    _cfg = ctx.cfg;
    _channelRuntime = ctx.channelRuntime;
    
    const manager = getStreamManager(account);

    // ========== Inbound: ShareOpen user message -> OpenClaw agent =========
    // Shared dispatch core: run one inbound text through the OpenClaw
    // agent pipeline (reply flows back via manager.sendAgentMessage).
    async function runInboundText(data) {
      const convId = data.conversation_id;
      let text = String(data.message || '').trim();
      let media = data.media || null;
      const fromUserId = data.user_id;
      if (!convId || (!text && !media) || fromUserId === account.agentId) return;
      // [FIX] Track the live conversation per user so outbound sendMedia
      // (whose kernel sessionKey can be stale) targets the CURRENT conv.
      // Per-user map = multi-tenant safe (rented agents, many users).
      if (!manager._convByUser) manager._convByUser = new Map();
      manager._convByUser.set(fromUserId, convId);

      // [FIX 2026-09-28] Inbound media must become REAL bytes the agent can
      // open. The kernel consumes ctx media facts (MediaPath/MediaUrls) — a
      // URL pasted into the prompt text is not visible/usable to the model,
      // which is why Green "couldn't perceive" attachments. Steps:
      //   1. download media.url to a stable cache dir (dedup by sha1+ext)
      //   2. pass structured media facts through buildContext
      //   3. keep the short text label so the agent knows what it is
      let mediaFacts = null;
      if (media?.url) {
        const localPath = await fetchInboundMedia(media.url, media.file_name);
        const mLabel = media.type || 'file';
        const mDesc = media.file_name || media.url.split('/').pop() || 'file';
        const mCaption = media.caption ? ` (caption: "${media.caption}")` : '';
        if (localPath) {
          const ext = path.extname(localPath).toLowerCase().replace('.', '');
          // Kernel media fact = LOCAL path only. Providing a url makes the
          // runtime run its url-download/normalization pass (crashes here on
          // a null field); the bytes are already on disk, so path alone is
          // the correct, complete fact.
          mediaFacts = {
            path: localPath,
            contentType: MIME_MAP_OUT[ext] || 'application/octet-stream',
            fileName: mDesc,
            kind: mLabel === 'images' ? 'image' : mLabel === 'voice' || mLabel === 'audio' ? 'audio' : mLabel === 'video' ? 'video' : 'document',
          };
          text = (text ? text + '\n' : '') + `[user sent ${mLabel} file "${mDesc}"${mCaption} — saved locally at ${localPath}]`;
          console.log(`[ShareOpen] inbound ${mLabel} attachment saved: ${mDesc} -> ${localPath}`);
        } else {
          text = (text ? text + '\n' : '') + `[user sent ${mLabel} file "${mDesc}"${mCaption} BUT DOWNLOAD FAILED - ask the user to resend]\nmedia_url: ${media.url}`;
          console.warn(`[ShareOpen] inbound ${mLabel} download FAILED: ${media.url}`);
        }
      }
      console.log(`[ShareOpen] inbound from ${fromUserId} in ${convId}: ${text.slice(0, 120)}`);

      const cr = _channelRuntime;
      const inbound = cr?.inbound;
      const session = cr?.session;
      const reply = cr?.reply;
      const routing = cr?.routing;
      if (!inbound?.run) {
        console.error('[ShareOpen] inbound.run unavailable — cannot dispatch');
        return;
      }

      // Map ShareOpen channel agentId -> OpenClaw agent (config agentId 'green'
      // matches agents.entries key 'green'; fall back to 'main').
      let agentId = account.agentId || 'main';
      const known = Object.keys(_cfg?.agents?.entries || {});
      if (!known.includes(agentId)) agentId = 'main';

      const route = routing?.resolveAgentRoute?.({ cfg: _cfg, agentId, channel: CHANNEL_ID, accountId: acctId }) || {};
      const sessionKey = route.routeSessionKey || `agent:${account.agentId}:${CHANNEL_ID}:${convId}`;
      // Kernel requires a concrete session store path; our channel config
      // has no session.store, so mirror OpenClaw's default layout
      // (~/.openclaw/agents/<agentId>/sessions/sessions.json).
      let storePath = _cfg?.session?.store || '';
      if (!storePath) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        storePath = path.join(home, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
      }

      try {
        const result = await inbound.run({
          channel: CHANNEL_ID, accountId: acctId, raw: text,
          log: (evt) => { if (evt.stage === 'dispatch' && evt.event === 'error') { console.error(`[ShareOpen:inbound] dispatch error: ${evt.detail || ''}`); } },
          adapter: {
            ingest: (raw) => ({
              id: data.message_id || `so_${Date.now()}`,
              timestamp: Date.now(),
              rawText: raw,
              textForAgent: text,
              textForCommands: text,
              raw,
            }),
            resolveTurn: async (input) => {
              const msgCtx = inbound.buildContext({
                channel: CHANNEL_ID,
                accountId: acctId,
                timestamp: input.timestamp,
                from: `${CHANNEL_ID}:${fromUserId}`,
                sender: { id: fromUserId },
                conversation: { kind: 'direct', id: convId, label: convId },
                route: { agentId, accountId: acctId, routeSessionKey: sessionKey, dispatchSessionKey: sessionKey },
                reply: { to: `${CHANNEL_ID}:${fromUserId}` },
                message: { rawBody: input.rawText, commandBody: input.textForCommands, bodyForAgent: input.textForAgent },
                // [FIX 2026-09-28] Structured inbound media. Kernel projects
                // `media` facts into MediaPath/MediaUrls ctx fields; `extra`
                // is ALSO spread verbatim into ctxPayload as belt-and-braces
                // (whichever path the installed runtime honors, the agent
                // sees the file). Source-of-truth shape = ChannelInboundMediaInput.
                ...(mediaFacts ? { media: [mediaFacts] } : {}),
                extra: {
                  ChatType: 'direct', Provider: CHANNEL_ID, Surface: CHANNEL_ID, OriginatingChannel: CHANNEL_ID,
                  ...(mediaFacts ? {
                    MediaPath: mediaFacts.path,
                    MediaPaths: [mediaFacts.path],
                    MediaUrl: mediaFacts.url || mediaFacts.path,
                    MediaUrls: [mediaFacts.url || mediaFacts.path],
                    MediaType: mediaFacts.contentType,
                    MediaTypes: [mediaFacts.contentType],
                    SourceModality: 'media',
                  } : {}),
                },
                // Telegram-style: single-owner channel -> text slash commands
                // are authorized for the person chatting with this agent.
                access: { commands: { authorized: true } },
                commandTurn: chatTypeSlash(input.textForCommands),
              });
              const resolvedStorePath = reply.resolveStorePath?.(storePath, { agentId }) || storePath;
              return {
                cfg: _cfg,
                channel: CHANNEL_ID,
                accountId: acctId,
                agentId,
                routeSessionKey: sessionKey,
                storePath: resolvedStorePath,
                ctxPayload: msgCtx,
                recordInboundSession: session?.recordInboundSession?.bind(session),
                dispatchReplyWithBufferedBlockDispatcher: reply?.dispatchReplyWithBufferedBlockDispatcher?.bind(reply),
                delivery: {
                  deliver: async (payload) => {
                    const replyText = payload?.text || payload?.body || payload?.fullText || String(payload ?? '');
                    const isFinal = !payload?.stream || payload?.done;
                    if (isFinal) {
                      console.log(`[ShareOpen] delivering reply to ${convId}: ${replyText.slice(0, 80)}`);
                      // P2 recon: capture the portable presentation shape this channel receives
                      try {
                        console.log(`[ShareOpen] PAYLOAD-SHAPE ${JSON.stringify({
                          keys: Object.keys(payload ?? {}),
                          mediaUrls: payload?.mediaUrls ?? null,
                          mediaUrl: payload?.mediaUrl ?? null,
                          presentation: payload?.presentation ?? null,
                          interactive: payload?.interactive ?? null,
                          isApproval: /approval/i.test(Object.keys(payload ?? {}).join(',')),
                        }).slice(0, 1800)}`);
                      } catch (e) { console.log(`[ShareOpen] PAYLOAD-SHAPE err ${e.message}`); }
                    }
                    // P1 fix: the kernel routes local media through outbound.sendMedia
                    // (verified: "sendMedia CALLED"), which already delivers the
                    // attachment with its own WS-retry loop. The reply text must
                    // NOT re-attach the same file — otherwise demo receives it
                    // twice and sendText fallbacks lose the attachment entirely.
                    let { cleanText, attachments } = extractReplyAttachments(replyText);
                    if (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length) {
                      attachments = [];
                      cleanText = replyText.replace(MEDIA_RE_GLOBAL, '').replace(/MEDIA:/g, '').trim();
                      console.log(`[ShareOpen] reply carries ${payload.mediaUrls.length} media URL(s) routed via sendMedia — skipping duplicate attachment in reply path`);
                    }
                    if (manager.ws && manager.ws.readyState === WebSocket.OPEN) {
                      const ok = manager.sendAgentMessage(convId, cleanText, attachments.length ? attachments : undefined);
                      if (!ok && attachments.length) {
                        // WS dropped mid-send: resend the attachment so it is
                        // not lost while the text caption may already have
                        // arrived via the kernel's own retry.
                        await new Promise((r) => setTimeout(r, 3000));
                        const ok2 = manager.sendAgentMessage(convId, cleanText, attachments);
                        if (!ok2) console.warn(`[ShareOpen] reply attachments not delivered (WS closed twice): ${attachments.length} attachment(s) lost`);
                      }
                    } else if (attachments.length) {
                      console.warn(`[ShareOpen] reply attachments SKIPPED — WS not open: ${attachments.length} file(s)`);
                    }
                    // P2 Feature B: additive component_message after the text reply.
                    // Text reply above already happened — parser failures can never
                    // block it. Zero component frames for ordinary replies.
                    if (isFinal) {
                      try {
                        const approval = parseApprovalButtons(replyText);
                        if (approval) {
                          manager.sendComponentMessage({
                            conversation_id: convId, text: replyText,
                            component_id: approval.component_id,
                            component_type: approval.component_type,
                            config: approval.config,
                          });
                        }
                        // Model picker only for /model|/models turns (commandName
                        // captured from this turn's text via chatTypeSlash above).
                        const slashTurn = chatTypeSlash(text);
                        if ((slashTurn?.commandName === 'model' || slashTurn?.commandName === 'models') && slashTurn?.authorized) {
                          const picker = parseModelPicker(replyText) || buildModelPickerFromConfig(replyText);
                          if (picker) {
                            manager.sendComponentMessage({
                              conversation_id: convId, text: replyText,
                              component_id: picker.component_id,
                              component_type: picker.component_type,
                              config: picker.config,
                            });
                          }
                        }
                      } catch (e) { console.error('[ShareOpen] component post-process error:', e.message); }
                    }
                    return { messageId: `so_${Date.now()}`, status: payload?.done === false && payload?.stream ? 'partial' : 'delivered' };
                  },
                  onError: (err) => console.error(`[ShareOpen] delivery error: ${err.message}`),
                },
                dispatcherOptions: { onReplyStart: () => console.log('[ShareOpen] agent reply started') },
                record: { onRecordError: (err) => console.log('[ShareOpen] session meta update failed', err) },
              };
            },
          },
        });
        console.log(`[ShareOpen] inbound.run result: ${JSON.stringify(result)?.slice(0, 200)}`);
      } catch (err) {
        console.error(`[ShareOpen] dispatch error: ${err.message}`);
        manager.sendAgentMessage(convId, `[Error: ${err.message}]`, undefined);
      }
    };

    manager.onInbound = runInboundText;
    // [FIX 2026-09-27 v5] Register in the process-global registry so StreamManagers
    // created by a DIFFERENT module copy (openclaw double-loads the plugin)
    // inherit the handler instead of living handler-less.
    setInboundHandler(runInboundText);

    // [FIX 2026-09-27 v3] No explicit drain here: `manager.onInbound = fn`
    // goes through the setter defined on ShareOpenStreamManager, which flushes
    // any frames queued while the handler was unset. This is order-independent
    // — startAccount may run before or after the WS connect, and frames are
    // never lost either way. (v2's fixed drain call sites raced the lifecycle:
    // observed queue depth climbing to 2 with green silent.)

    // Handler defense: register a rebind closure on the manager so that
    // connect() (incl. every WS reconnect) can re-wire onInbound if it was
    // ever lost. runInboundText is a startAccount-scoped closure, so it must
    // be rebindable — the singleton manager outlives any single startAccount
    // call, and a reconnect with a null handler silently drops all inbound
    // user messages (the 20:08 "inbound message dropped" incident).
    manager._rebindInbound = () => {
      manager.onInbound = runInboundText;
      manager.onCommand = manager._onCommandHandler;
      manager.onComponentCallback = manager._onComponentCallbackHandler;
      console.log('[ShareOpen] all handlers re-wired after (re)connect');
    };

    // Slash-command invocation from ShareOpen (Telegram-style menu).
    // /help is answered locally (deterministic, zero token cost); every
    // other command is forwarded through the same agent pipeline as a
    // normal '/'-prefixed message — OpenClaw's native command runtime
    // consumes textForCommands, so /status /new /model … behave exactly
    // like typing them in a chat.
    manager.onCommand = async (msg) => {
      const name = String(msg.command_name || '').replace(/^\//, '');
      const args = msg.arguments || {};
      const convId = msg.conversation_id;
      const argText = Object.values(args).filter((v) => v !== '' && v != null).join(' ');
      console.log(`[ShareOpen] command /${name} ${argText} in ${convId} (inv ${msg.invocation_id})`);

      if (name === 'help') {
        manager.sendCommandResponse(msg.invocation_id, {
          status: 'completed',
          result: ['Available commands:',
            ...SHARE_COMMANDS.map((c) => `/${c.name} — ${c.description}`)].join('\n'),
        });
        return;
      }

      try {
        await runInboundText({
          conversation_id: convId,
          message: '/' + name + (argText ? ' ' + argText : ''),
          user_id: msg.user_id,
          message_id: 'cmd_' + msg.invocation_id,
        });
        // Reply arrives as a normal chat message; just complete the UI card.
        manager.sendCommandResponse(msg.invocation_id, { status: 'completed' });
      } catch (err) {
        manager.sendCommandResponse(msg.invocation_id, { status: 'failed', error: err.message });
      }
    };

    // ========== P2 Feature C: component_callback inbound ==========
    // Frame {component_id, value, user_id, conversation_id}. A button/select
    // click replays its embedded slash command ('/approve <id> allow-once',
    // '/model provider/model') through the exact same kernel path a user-typed
    // slash command uses (authorized text-slash turn via chatTypeSlash). The
    // reply flows back through deliver -> text_message (+ P2 parsers).
    manager.onComponentCallback = async (msg) => {
      let value = typeof msg.value === 'string' ? msg.value.trim() : '';
      if (value.endsWith('__submit__')) value = value.slice(0, -'__submit__'.length).trim();
      if (!value.startsWith('/')) {
        console.warn(`[ShareOpen] component_callback ignored (value not a slash command): ${JSON.stringify(msg.value ?? '').slice(0, 80)}`);
        return;
      }
      const convId = msg.conversation_id;
      if (!convId) {
        console.warn('[ShareOpen] component_callback ignored (no conversation_id)');
        return;
      }
      console.log(`[ShareOpen] component_callback -> ${value}`);
      await runInboundText({
        conversation_id: convId,
        message: value,
        user_id: msg.user_id,
        message_id: 'cmp_' + (msg.component_id || Date.now()),
      });
    };
    manager._onCommandHandler = manager.onCommand;
    manager._onComponentCallbackHandler = manager.onComponentCallback;
    manager._rebindInbound();

    await manager.connect();
    console.log(`[ShareOpen] Account ${acctId} connected`);
    
    return new Promise((resolve) => {
      const onAbort = () => {
        console.log(`[ShareOpen] Stopping account ${acctId}`);
        manager.disconnect();
        resolve();
      };
      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) onAbort();
        else ctx.abortSignal.addEventListener('abort', onAbort);
      }
    });
  },
  
  async stopAccount(ctx) {
    const manager = ctx._manager;
    if (manager) {
      manager.disconnect();
    }
  },
};

// Plugin entry point
export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: 'ShareOpen',
  description: 'ShareOpen channel plugin with WebSocket streaming support',
  plugin: shareopenPlugin,
  configSchema: buildChannelConfigSchema({
    wsUrl: { type: 'string', description: 'WebSocket URL' },
    token: { type: 'string', description: 'Agent token' },
    agentId: { type: 'string', description: 'Agent ID' },
  }),
});
