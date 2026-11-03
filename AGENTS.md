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
- `npm run dev -w web` — Vite dev server on :5173 (proxies /api and /ws)
- Env: `PORT`, `HOST`, `DEVIN_BIN`, `DEVIN_WEB_DATA`, `DEVIN_WEB_TOKEN` (optional bearer token for /api+/ws; share URL as `?token=`), `DEVIN_WEB_ORIGINS` (extra allowed WS origins)

## ACP notes

- One `devin acp` process multiplexes all web sessions by `sessionId`.
- Methods used: `initialize`, `session/new`, `session/load`, `session/list`,
  `session/delete`, `session/prompt`, `session/cancel`,
  `session/set_config_option` (mode + model pickers arrive as `configOptions`).
- Agent→client `session/request_permission` is routed to the session's
  subscribers; the first response wins.
- `session/list` `_meta` fields: `cognition.ai/isLocked`,
  `lockHolderPid`, `hasUserMessages`, `createdAt`.
