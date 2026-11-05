# Devin Web

Web UI for Devin CLI. A Node.js backend bridges `devin acp` (JSON-RPC over
stdio, ACP protocol) to browser WebSocket clients; a React (Vite) frontend
provides workspace selection, session management, and a chat transcript.

## Layout

- `server/src/acp-client.js` — spawns `devin acp`, NDJSON JSON-RPC client
- `server/src/sessions.js` — SessionHub: attach/detach (`session/load`),
  buffered `session/update` replay, permission routing, state persistence
- `server/src/index.js` — Express REST + `ws` WebSocket server (port 8787)
- `web/src/sessionReducer.js` — folds `session/update` events into items
- `web/src/App.jsx` — root state + WS message routing
- `server/data/state.json` — persisted workspace list + session metadata

## Commands

- `npm install` — install all workspaces
- `npm run build` — build frontend to `web/dist`
- `npm start` / `npm run server` — serve UI + API on http://127.0.0.1:8787
- `npm test` — node:test suite (reducer unit tests + in-process pi SDK
  integration tests; the latter need ~/.pi/agent configured but no network)
- `npm run dev -w web` — Vite dev server on :5173 (proxies /api and /ws)
- Env: `PORT`, `HOST`, `DEVIN_BIN`, `DEVIN_WEB_DATA`, `DEVIN_WEB_TOKEN` (optional bearer token for /api+/ws; share URL as `?token=`), `DEVIN_WEB_ORIGINS` (extra allowed WS origins), `MAX_ATTACHED_SESSIONS` (per-hub attach cap, default 10 — coldest idle attach is evicted), `IDLE_DETACH_MS`, `TURN_STALL_MS`

## Multi-agent

- One `AcpClient` + `SessionHub` per agent (registry in `server/src/agents.js`);
  `DEVIN_WEB_AGENTS` selects/enables them (comma list, default `devin,pi`,
  first = primary, owns the shared workspace list in `state.json`).
- `pi` runs in-process via the `@earendil-works/pi-coding-agent` SDK
  (`server/src/pi-sdk/`: `PiSdkClient` — an `AcpClient` lookalike — drives a
  vendored pi-acp `PiAcpAgent` backed by SDK `AgentSession`s, so multiple pi
  sessions run concurrently) and gets `state.pi.json`; devin-only behaviour
  (sqlite mirror, locks, fork/revert, prompt_history) is gated on
  `devinExt`.
- Sessions carry an `agent` tag; the server routes by id (UUID → pi).
  `GET /api/agents` advertises `{id, name, caps}`; `caps.fork` hides the
  per-message fork button.

## ACP notes

- One `devin acp` process multiplexes all web sessions by `sessionId`.
- Methods used: `initialize`, `session/new`, `session/load`, `session/list`,
  `session/delete`, `session/prompt`, `session/cancel`,
  `session/set_config_option` (mode + model pickers arrive as `configOptions`).
- Agent→client `session/request_permission` is routed to the session's
  subscribers; the first response wins.
- `session/list` `_meta` fields: `cognition.ai/isLocked`,
  `lockHolderPid`, `hasUserMessages`, `createdAt`.
