# Changelog — ShareOpen OpenClaw Channel Plugin

## v1.3.2 — 2026-09-28 (local-production)

Synced from `~/.openclaw/extensions/shareopen/index.js` (Green ops agent production).
Default `wsUrl` updated to `wss://shareopen.com/ws/agent` for public deployments.
Full feature set: slash-command menu, approval fences, model picker, multi-account.

## v1.2.0 — 2026-09-14 (production-verified)

### Added
- **Slash command menu (Telegram-style)** — 27 curated commands, idempotent.
- **P2 interactive components (text round-trip)** — approval fences, model picker card.
- **Command-turn context injection** — kernel executes slash commands from ShareOpen.

### Fixed
- Sessions `storePath` empty → fallback `~/.openclaw/agents/<id>/sessions/sessions.json`.
- All user-facing strings in English.

## v1.0.0 — initial
- Basic message relay channel (text in/out, media passthrough).
