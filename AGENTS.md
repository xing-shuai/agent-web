# Devin Web

Web UI for Devin CLI. A Node.js backend bridges `devin acp` (JSON-RPC over
stdio, ACP protocol) to browser WebSocket clients; a React (Vite) frontend
provides workspace selection, session management, and a chat transcript.

## Layout

- `server/src/acp-client.js` — spawns `devin acp`, NDJSON JSON-RPC client
- `server/src/sessions.js` — SessionHub: attach/detach (`session/load`),
  buffered `session/update` replay, permission routing, state persistence
- `server/src/index.js` — Express REST + `ws` WebSocket server (port 8787)
- `server/src/terminals.js` — workspace PTYs, bounded output replay, terminal access checks
- `server/src/remote-hosts.js` — encrypted SSH profiles, pinned SSH transports and lifecycle
- `server/src/remote-worker.js` — source bundle, remote inspection, confirmed user-directory install/start
- `server/src/remote-routes.js` — protected management API and SSH-tunneled REST/WebSocket proxies
- `web/src/components/RemoteHosts.jsx` — compact environment selector and host/deployment dialogs
- `web/src/components/TerminalPanel.jsx` — lazy-loaded xterm.js desktop dropdown/mobile overlay terminal
- `web/src/splitLayout.js`, `web/src/components/SplitWorkspace.jsx` — recursive layout model and flat, stable-keyed pane views
- `web/src/environmentContext.js` — per-pane host environment provider (REST/WS/storage scope)
- `web/src/sessionReducer.js` — folds `session/update` events into items
- `web/src/App.jsx` — root state + WS message routing
- `server/data/state.json` — persisted workspace list + session metadata

## Commands

- `npm install` — install all workspaces
- `npm run build` — build frontend to `web/dist`
- `npm start` / `npm run server` — serve UI + API on http://127.0.0.1:8787
- `npm test` — node:test suite (reducer/UI tests, local PTY/WebSocket tests,
  and in-process pi SDK integration tests; SDK tests need ~/.pi/agent configured
  but no external network)
- `npm run dev -w web` — Vite dev server on :5173 (proxies /api and /ws)
- Env: `PORT`, `HOST`, `DEVIN_BIN`, `DEVIN_WEB_DATA`, `DEVIN_WEB_TOKEN` (optional bearer token for /api+/ws; share URL as `?token=`), `DEVIN_WEB_ORIGINS` (extra allowed WS origins), `MAX_ATTACHED_SESSIONS` (per-hub attach cap, default 10 — coldest idle attach is evicted), `IDLE_DETACH_MS`, `TURN_STALL_MS`

## Chat layout

- Desktop sidebar smoothly collapses to an icon rail; mobile keeps the existing drawer.
  Reduced-motion preferences disable the transitions.
- User-message actions float beside their bubble without reserving a row;
  insufficient side space/touch uses a compact menu. Hover changes paint only.
- Sent user-message text defaults to a ten-visual-line preview with explicit
  expand/collapse; attachments and delivery receipts stay outside the clamp.
  The full original text stays in the DOM and backs copy/edit/resend/export.
  An active transcript-search hit opens the full message immediately, then
  restores manual expansion state; wrapped lines follow pane width/font changes.
- Thought/tool/group disclosures share a reversible 360ms reveal. Closing bodies
  are inert, keep their last committed children through the exit, then release
  them; closed tool bodies remain lazy. Search-forced opening/closing and reduced
  motion are immediate. Manual disclosure reading pauses the live inner follow;
  the main transcript anchors the clicked header without rewriting unchanged
  pane/composer layout variables each animation frame. Todo is unaffected.
- Pane/session actions and sidebar marker identities stay stable through token
  updates; unrelated panes and cached historical Markdown must not re-render.
  Tool-run projection builds private arrays linearly and reuses unchanged groups.
  Pane geometry variables are non-inherited; composer geometry lives on `.dock`,
  not the transcript ancestor. Split resizing batches ratios per frame and uses
  a local hit-test shield instead of restyling every history token.
- Markdown/code text is complete before history becomes ready. Code coloring
  starts near the visible viewport (200px margins where supported), on one
  lazy browser Worker. Offscreen spans are released; leaving view, unmounting,
  searching or newer text cancels stale delivery. Only
  one job is posted at once; results use a 32-entry/8-MiB bounded cache. Unsupported
  or failed workers and oversized code (>200,000 characters or >4,000 syntax
  nodes) retain full plain text, never truncated content. Search temporarily uses
  plain code so asynchronous spans cannot invalidate its DOM Ranges. Copy always
  uses the full original text. No model call or backend worker is involved.
- A streaming agent message renders memoized committed Markdown blocks plus one
  reparsed tail (`markdownBlocks.js` splits only at safe blank-line boundaries;
  link-reference/footnote definitions fall back to whole-doc parsing). Tail code
  is not highlighted until its block commits. Completed Markdown reuses a
  256-entry/1M-char element LRU keyed by source text. History fold is linear —
  a fold-owned items array plus a toolCallId index; live `applyUpdate` stays
  immutable.
- The bottom workspace toolbar splits the focused pane left/right or top/bottom and
  closes views without cancelling tasks. New panes start empty. Opening an
  already displayed session focuses its existing pane, never duplicates drafts.
- Recursive layout, ratios and focus persist in environment-scoped sessionStorage
  per tab. Mobile displays only the focused pane and has no bottom window toolbar,
  labels, add or close buttons, even with multiple panes; existing panes and tasks
  remain intact. Desktop keeps the existing selector and split/close controls. Open panes
  retain subscriptions; all session mutations bind explicit session IDs, not the
  global focus. Splitting/closing neighbors must not remount existing composers. Initial
  history readiness comes from a complete snapshot, not attachment/receipts/live
  deltas; recovery rows wait for it. Offline subscription intent replays once on
  connect instead of also using the wire queue.

## File/report previews

- Model Markdown file links open a host-and-session-bound read-only preview;
  mobile uses the full screen. HTML, Markdown, images, PDF, JSON and text/code
  keep their original source, with formatted display and an optional source view.
  Closing does not remount chat/composers or stop agent/terminal tasks. Opening
  pauses transcript follow to preserve the reading position during live updates.
- `server/src/file-preview.js` issues 15-minute session-scoped read tickets through
  `/api/sessions/:id/preview`, then serves bounded reads from that report directory.
  Tickets are not authentication: ordinary API/token checks still apply. Relative
  resources cannot escape via traversal/symlinks or read hidden files. Old workers
  show an update-required error; neither routes nor previews load an agent.
- HTML runs in an opaque, sandboxed Blob iframe with restrictive CSP and a
  credential-free, bounded directory-resource broker. Local scripts, styles,
  images and JSON can interact; external networks, forms, workers, popups and
  parent-app access are blocked. PDF.js/its local assets load only when needed.
- APK 0.4.0 replaces all-frame JavaScript interfaces with a private WebMessagePort
  transferred only to the configured origin's top-level app page. Reports never
  receive notification/download/system-bar capabilities. Older APKs retain static
  HTML previews until upgraded; building frontend assets does not upgrade the APK.
- New backend routes require an explicitly authorized coordinator restart; remote
  workers require an explicitly authorized update. Neither happens during a build.

## Workspace terminal

- Open from the chat header, welcome page, command palette, or `Ctrl+Backquote`.
  Each pane owns a terminal flag in the persisted layout: a pane's header and
  welcome toggles flip its own flag, the palette and Ctrl+Backquote act on the
  focused pane, and a split does not inherit the flag. The legacy global
  `dw.terminalOpen` migrates once onto the focused pane. Desktop renders one
  height-resizable dropdown per open pane, clipped below its own title bar and
  never over neighboring panes; several panes may show local and remote shells
  side by side. Mobile renders only the focused pane's terminal. Open/close
  transitions are reversible; closing is inert and cancels pending connections
  without ending shells. Pinning keeps it
  floating when clicking/focusing outside; unpinned it auto-hides. It follows its
  own pane's workspace without stealing chat focus or terminating old shells.
  Closing a pane detaches only its terminal client; shells keep running. Two
  panes into the same workspace share one server PTY: output is identical,
  resize is last-writer-wins, and the narrower view may wrap differently. The terminal
  header's transparency control fades the entire panel on desktop and mobile
  (0–80% transparent, default opaque), persists as a browser UI preference, and
  never reconnects or restarts the shell. Its adjustment popover stays opaque.
- One shared shell per canonical workspace (including the default home directory).
  Hiding the panel, switching chats/workspaces, and refreshing only detach the
  browser. Reopening replays a bounded output tail; shell state stays in memory
  until exit, explicit termination, or server shutdown. No restart persistence.
- `GET /api/terminal?cwd=...` checks access/status without spawning a process;
  `/ws/terminal` carries input, resize, output, exit and restart messages.
- Terminal access without `DEVIN_WEB_TOKEN` requires an actual loopback peer,
  a loopback Host/Origin, and no proxy headers. Remote/reverse-proxy access must
  configure the token and open the app with `?token=...`; origin checks still apply.
  Reverse proxies must pass the public Host/forwarding headers, not disguise
  remote traffic as direct localhost access. Use HTTPS/WSS for remote access.
- This is the server account's real shell, **not a sandbox**. All authorized
  clients share a workspace's terminal. `MAX_TERMINALS` caps live shells (default
  8); the server refuses additional shells rather than evicting background jobs.
- `node-pty` is a native dependency; platforms without a matching prebuild need
  the usual native compiler/Python toolchain during `npm install`.

## SSH remote environments

- Sidebar **本机环境 / 主机名** opens host management. First version supports
  Linux, password-only SSH authentication, Pi and Devin. Bastions, MFA and
  SSH-key login are not implemented. The remote user needs bash and SFTP;
  Devin must be installed/logged in remotely, and Pi needs remote model credentials.
  Node >=22.19 and npm are required, but detection can run without them and offer
  a confirmed component-private Node install. System dependencies are never
  installed or upgraded with sudo.
- Configure `DEVIN_WEB_TOKEN` **and** `DEVIN_WEB_SSH_MASTER_KEY` on the coordinator.
  The master key is exactly 32 random bytes encoded as standard Base64. Generate
  it **once**, for example `openssl rand -base64 32`, then store it in a separate
  secret manager/protected service environment and inject the **same key** on
  every restart. Do not put it in source control, `DEVIN_WEB_DATA`, or the same
  backup as the credential file. Losing/changing it locks existing credentials;
  the server does not silently replace them. It is never shipped to workers.
- `remote-hosts.json` in `DEVIN_WEB_DATA` has mode 0600. Passwords use AES-256-GCM
  with the immutable host/user/port identity as authenticated data; API responses
  never return passwords/ciphertext. Protection is at rest, **not a sandbox**:
  the server account and its local agents have real account privileges. The
  coordinator captures the key in memory and removes it from the child-process
  environment to reduce accidental disclosure by tool commands.
- Host APIs require the token even on localhost. Password/control-plane access
  also requires HTTPS, except verified direct loopback without proxy headers.
  For TLS termination, set `DEVIN_WEB_TRUST_PROXY=loopback` only if the actual
  reverse proxy connects from loopback, or use a comma-separated list of exact
  trusted peer IPs. The proxy must **overwrite** `X-Forwarded-Proto`, not trust
  the browser's supplied header, and preserve the public Host. Merely supplying
  forwarded headers cannot enable credential access. Origin checks still apply.
- A deliberately insecure, **default-off** exception is available only for an
  explicitly accepted LAN/SSH-forwarding setup:
  `DEVIN_WEB_INSECURE_REMOTE_HTTP_HOSTS=192.168.200.112:8788` on the coordinator.
  It accepts exact RFC1918 IPv4 Host/port entries (comma-separated), requires
  the token and a matching HTTP Origin, an actual loopback transport peer and
  no proxy headers. It does not loosen other hosts, terminal authentication,
  or trusted-proxy/TLS rules. Unknown/public/wildcard entries fail closed.
  SSH only encrypts the hop after the LAN gateway: phone-to-gateway passwords,
  tokens and traffic remain plaintext and can be intercepted/altered. The
  backend sees the tunnel's loopback peer, **not the phone's IP**; the allowlist
  is not proof of LAN membership. Keep the gateway listener/firewall LAN-only;
  never expose/forward it publicly. HTTPS remains preferred. Configure this in
  the existing protected service environment, preserving token/master key;
  enabling it requires an explicitly authorized backend restart.
- First detection obtains the SSH host-key fingerprint **before authentication**;
  a separate explicit confirmation pins it. Verify independently with the host
  administrator. Changed keys block authentication/reconnect; delete/re-add a
  profile only after independently verifying the change. Password-auth failures
  pause automatic connection attempts to avoid repeated login failures.
- Detection returns a short-lived installation plan. Only explicit confirmation
  uploads allowlisted application sources and exact direct dependency versions
  under `~/.local/share/agent-web-remote/releases/<version>`, then runs remote
  `npm install --omit=dev` and native dependency validation. npm lifecycle scripts
  execute with that SSH account's permissions; registry/network/compiler failures
  leave a private `install.log`. No local model credentials, project files or
  node_modules are uploaded. Existing Pi ask_user compatibility patching may
  update the remote pi-ask extension, as disclosed in the confirmation.
- If Node is missing, too old, broken, or npm is absent, detection offers an
  explicit **install private Node and continue** plan. The coordinator fetches
  Node 22's official `SHASUMS256.txt`; only confirmation downloads the exact
  selected Linux x64/arm64 archive over HTTPS, verifies SHA256, and uploads it.
  Remote verification/extraction and executable/npm checks run before publishing
  the `.node-runtime` pointer under the component directory. Versions live under
  `runtimes/node-v<version>-linux-<arch>/`; no system/default Node, shell profile,
  or project file is replaced. Only the worker and its children (including its
  terminal/agent commands) inherit the private Node PATH. Other SSH logins keep
  their original Node. A running component is never stopped for runtime repair.
  Automatic bootstrap requires glibc >=2.28, tar, gzip and sha256sum; unsupported
  platforms/system libraries produce an explicit blocker, not a sudo upgrade.
  Downloads need coordinator access to nodejs.org, not remote curl/wget. The
  confirmed archive download has a 15-minute total budget and a 60-second idle
  timeout, with at most three transport attempts, HTTP Range resumption and
  SHA256 verification before upload. Partial/verified public archives share a
  bounded 128-MiB, 30-minute in-memory cache across hosts; active transfers are
  separately size-limited. Restart clears this cache. No third-party mirror or
  plaintext download fallback is used. The UI polls download/upload byte counts
  and dependency-install phases. Only transport downloads retry automatically,
  never remote installation/start commands; a dependency-install retry reuses
  the already validated private Node rather than reinstalling it. Failed
  uploads may leave private `.node-stage-*` directories for manual inspection;
  stale `.node-install-lock` requires manual inspection, never blind removal.
- The worker reuses this backend with both agents, a random private token and a
  loopback-only ephemeral port. `config.json` contains its private token;
  `runtime.json` contains PID/port/version; `state/` contains remote workspace
  metadata. These and `worker.log` live below the remote component directory,
  separate from release code. Remote endpoints and sockets travel only over SSH
  channels; no coordinator TCP tunnel listener or public worker port is opened.
- User systemd service `agent-web-remote` is preferred when available, otherwise
  a detached user process is used. PATH is passed for remote CLI discovery;
  model credentials should be configured in the remote agents' own files rather
  than only interactive-shell environment variables. systemd output may be in
  the user journal (`journalctl --user -u agent-web-remote`) rather than worker.log.
  Without a user manager/linger, logout policy may kill background processes.
  No promise is made to restore active turns or shells after worker/host restart.
- **Disconnect** closes all this coordinator's browser/SSH connections to the
  host but does not stop the worker. **Stop component** explicitly confirms and
  terminates its agent tasks and all shells. **Delete configuration** removes
  saved credentials but does not uninstall the worker or delete remote projects.
  Version changes never implicitly stop/overwrite a live component: explicitly
  stop, detect, confirm installation, then connect. Stale installation/start
  locks require manual inspection, not automatic deletion.
- Session deletion returns `202 {status: "deleting"}` on acceptance, **not**
  success. Read-only `POST /api/sessions/delete-status` checks bounded in-memory
  receipts (`deleting/deleted/failed/unknown`); only completed agent deletion
  removes rows. Frontend request/verification deadlines prevent indefinite
  confirmations and never resend destructive requests automatically. Lost
  receipts after a worker restart or old workers without verification remain
  unknown, not fabricated success; updating an old worker requires explicit
  stop/install permission. Pi uses known session paths/header-only lookup,
  waits for in-flight loads, cancels/disposes only the target before unlinking,
  and reports file-system errors without hiding the row. Proxy connection
  deadlines include SSH channel establishment; timed-out or closed requests
  never forward mutations after a delayed reconnect. HTTP requests use fresh
  channels over the existing authenticated SSH transport, not an idle HTTP
  keep-alive pool: OpenSSH may leave a channel half-open after the worker's TCP
  idle timeout, and reusing it can lose the first request (including DELETE).
  Replacing an HTTP channel does not reconnect SSH or retry a mutation.
- Each split pane carries its own host (`""` = local, else a remote host id);
  REST, both sockets, image URLs, workspace selection, drafts/history and
  pending-send receipts are scoped per pane host, and session identity is the
  `(host, sessionId)` pair — the same id may be open once per host. The
  sidebar, terminal and command palette follow the focused pane's host. A pane
  switches host only while empty (Welcome selector) or via the host dialog's
  enter action on the focused pane; `?remote=<id>` is a deep link for the
  focused pane kept in sync via `history.replaceState`, never a navigation. A
  socket is opened per in-use host and released when unused.
  Unknown/disconnected hosts fail closed, never fall back to local execution.
  Terminal-open and sidebar-collapse preferences are browser-global. Worker
  hello preserves the worker instance id for send deduplication but advertises
  the coordinator's frontend build. User actions (cancel, dequeue, config,
  permission/elicitation answers, re-attach) are never queued offline: a closed
  socket fails the send in place with a warn notice instead of replaying later.
- Session transcripts cache is bounded: entries leave sessionData five idle
  minutes after their last pane closes unless a delivery or permission/elicitation
  is still pending; an unread badge survives eviction, and reopening goes
  through the normal subscribe → history path. Session lists poll every 60s
  (plus visibility/open/change triggers); the host dialog polls every 4s while
  open or while any host is busy, else every 20s when a remote pane is in use.
- Notices render as one stack in the main view: errors pin until dismissed,
  warn/ok/info auto-dismiss after 4s, identical host+kind+text repeats bump a
  counter, `conn:<host>` ids swap the disconnect warning for a transient
  recovery, and at most four items show with the oldest non-sticky dropped.
- The remembered workspace list is MRU (most-recent first, capped at 50,
  persisted only on change), so new empty panes start in the last-used
  workspace. Dropping files onto a chat pane feeds the composer's attachment
  path (images or ≤200KB text); directories are rejected, and Files drops
  outside a pane are suppressed so they cannot navigate the page.
- `npm test` includes a real local SSH/SFTP fixture with a temporary remote home,
  fake npm/Devin and real worker/SDK/PTYS: no external server, package download or
  model call. Existing backend restarts and real-host deployments still require
  explicit operator authorization.

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
- Pi transcript replay uses the active branch's raw persisted message entries
  (`PiSdkProcess.getHistoryMessages()`), not `session.messages` (compacted model
  context). Keep these separate: compaction/context edits must not erase UI
  history, and restoring history must not expand the model context or mix branches.
- Pi's bounded delivery cache is not transcript storage: token deltas and
  cumulative tool updates coalesce, and cache eviction is tracked. Reconnect,
  consolidated history and history export recover the raw active branch plus
  the unfinished live tail using persisted-message fences, without calling
  `session/load`, aborting a turn, changing model context or rewriting JSONL.
  Never fix missing history by merely raising the 8,000-event/32-MB limits.
  In-flight parallel tool output and request-ID receipts must survive recovery;
  stale fences must not graft abandoned branches into the active transcript.
- History delivery negotiates `strings-v1` per browser socket (`server/src/history-wire.js`). It losslessly interns repeated long strings only on the wire; original events, raw tool fields, branch/compaction order, exports and model context stay untouched. Legacy clients/workers retain the original protocol. Chat WebSockets negotiate bounded, no-context-takeover compression on local and SSH-proxied hops; PTY compression is unchanged. Remote chat output applies upstream backpressure while one large frame drains, with a 2-MiB additional queue scoped to that connection, never mutation replay.
- History subscriptions offer `historyEncodings: ["strings-v2", "strings-v1"]`
  with the single `historyEncoding` kept at v1 for older workers. V2 retains one
  immutable folded baseline per existing in-memory UI session cache; reconnect
  can append only when hub epoch, session, generation and every prior event's
  SHA256 fingerprint agree. Server checkpoints contain fingerprints only
  (32 entries / 8 MiB, 10-minute validity); any mismatch/eviction/branch edit
  returns the complete snapshot. Previously delivered live tails are replaced
  from the baseline, never appended twice. State/config/usage/process/queue and
  pending-question identities remain fresh outside the body validator.
- V2 moves recognized tool-image binary fields (at least 1 KiB base64, reliable
  geometry) into immutable session-scoped image assets; unknown/EXIF images and
  all text/raw non-image fields stay intact. Explicit wire paths and a private
  browser WeakMap avoid interpreting tool-owned markers. Closed raw bodies do
  not fetch image data; visible images use native lazy loading. Raw viewing and
  export hydrate exact original base64 (including whitespace), with at most four
  requests, cancellation/timeouts and explicit failure instead of partial JSON.
  Original-image JSON can use gzip; SSH HTTP proxies preserve encoding headers.
  These changes still require an authorized backend restart / worker update.
- Supported historical user-image headers become immutable session-scoped `/img/pi-<sha256>/0` assets with reserved thumbnail geometry, native lazy loading and private browser caching. A 256-entry/32-MiB server reference cache can recover bytes from existing read-only history; unknown image headers stay inline. Snapshot validators bind a random hub epoch, history generation and SHA256 of the entire lossless wire projection. A retained in-memory UI cache may accept an unchanged-body receipt, but must still apply state/config/usage/process/permission metadata and tree/history fences; a missing cache forces a complete snapshot. Live deltas invalidate the validator; nothing persists full transcripts in browser storage. Backend activation and remote-worker updates still require explicit operator authorization.
- Pi SDK JSON events omit partial assistant messages; the bridge preserves only
  the current tool-call block to restore command/argument updates without copying
  the growing transcript. Shell output is a cumulative content snapshot; legacy
  `terminal_output` metadata remains a delta. Never concatenate those snapshots.
- Native `compaction_start/end` (manual/automatic) become
  `_meta.piAcp.compaction` updates, rendered as one expandable transcript boundary.
  Cold replay inserts persisted compaction entries in branch order; it does not
  fabricate unavailable historical token-after counts. Recorded, non-redacted
  thinking blocks are replayed in their original assistant-block order.
- Sessions carry an `agent` tag; the server routes by id (UUID → pi).
  `GET /api/agents` advertises `{id, name, caps}`; `caps.fork` hides the
  per-message fork button.

## Pi background processes

- Non-Windows Pi sessions load upstream `@aliou/pi-processes@0.13.6` through the
  SDK; Web adapters live in `server/src/pi-sdk/processes{,-extension}.js`. Do not
  patch the dependency. CLI can install the same pinned package globally with
  `pi install npm:@aliou/pi-processes@0.13.6`. Web filters that npm package's
  extension entries through a session-local settings view, preserving the real
  global/project settings and skills. It always loads its own pinned wrapper,
  not the CLI's TUI dock/log extensions. Unexpected duplicate engines still fail
  closed; the project dependency remains required for reproducible workers.
- CLI shell-background interception is configured independently in
  `~/.pi/agent/extensions/processes.json` with
  `"interception": { "blockBackgroundCommands": true }`. Enabling it directs
  model bash calls to managed tasks; it does not adopt existing detached jobs.
- Launch managed jobs through the `process` tool, not `nohup`, `setsid`, `disown`
  or shell `&`. The Web wrapper reuses upstream shell detection and adds model
  guidance without changing personal Pi configuration. This is lifecycle
  management, not an OS sandbox or a way to adopt existing detached jobs.
- Success/failure completion can resume the owning session automatically. Native
  autonomous runs publish busy state and settle on `agent_settled`; queued user
  prompts wait behind them. Jobs and pending completion delivery protect their
  session from idle/capacity eviction. If all attachment slots are protected,
  new admission is rejected rather than killing tasks or exceeding the cap.
- `MAX_BACKGROUND_PROCESSES_PER_SESSION` is a positive integer (default 8), set
  on the backend running the jobs. Parallel starts reserve quota; excess starts
  fail. No native runtime deadline is added: use an explicit shell timeout when
  needed. Job state is session-runtime-local, not durable across shutdown.
- Chat **More → Background tasks** offers a host/session-scoped list, recent
  plain-text output (200 lines / 64 KiB) and individual stop. Stop generation
  does **not** stop jobs or suppress their later continuation. Explicit task
  stop is context-only and does not independently wake the model. Successful
  completion notices share a lazy expandable summary across a thought/tool run;
  prose, user messages and exceptional notifications delimit these summaries.
  Failures/readiness/other notifications stay inline. Search reveals matching
  summary details without changing manual expansion, and raw history/export and
  model wakeups are unchanged. Stop requests are never retried automatically;
  uncertain results require read-only checking.
- Running jobs, starts and completion delivery block branch navigation, reload
  and ordinary unload. Explicit session deletion/server shutdown still clean up
  owned jobs. APIs are `GET /api/sessions/:id/processes`,
  `GET /api/sessions/:id/processes/:processId/output`, and
  `POST /api/sessions/:id/processes/:processId/stop`; reads never load cold SDK
  sessions. Existing authorization and SSH host scoping apply.
- Activation requires an authorized backend restart. Remote workers need an
  explicitly authorized stop/update; installing the local dependency or building
  the frontend does neither.

## Pi visual session tree

- Pi chat **More → Session tree** or `/tree` opens a compact scrollable branch
  list with previews, showing **user messages only by default**. A filter can
  reveal other messages/summaries or all nodes. Only forks add indentation;
  linear conversations stay flat. Arrows select messages/parents/children,
  and the current-branch button reveals the nearest visible active ancestor.
  `/tree` is a local UI command, never a model prompt or delivery receipt.
- Tree/preview GETs inspect only the already-loaded SDK manager, including all
  branches, without loading, rewriting files or changing model context. Preview
  text is bounded; images, redacted thinking and provider signatures are omitted.
- Explicit navigation uses SDK `navigateTree` in the same session. Running,
  compacting, pending-question/queued sessions cannot switch; a session-local
  mutation guard and snapshot-version CAS reject concurrent/stale actions.
  Prior branches remain intact; files and terminal state are never rolled back.
- Existing drafts require replacement confirmation. User/extension-message
  selections restore text only (images must be reattached), never auto-send.
  Optional old-branch summarization defaults off and explicitly uses the model.
  Extension questions remain answerable inside the tree dialog.
- An append-only non-context `devin-web.tree-cursor` entry persists the selected
  position, including a pre-first-message root. A new history generation uses the
  raw active branch and an entry-ID fence, not compacted model messages or stale
  delivery tails. The HTTP result fences readiness on its history generation;
  stale WS snapshots cannot re-enable sending, and fresh connections/workers
  clear the fence after a complete authoritative snapshot. Replies/drafts stay bound to the originating host+session even
  if the dialog/pane closes; transport uncertainty never retries the mutation.
- New tree routes/capabilities need an authorized backend restart; old remote
  workers need an explicitly authorized component update. Frontend builds do
  neither automatically.

## ACP notes

- One `devin acp` process multiplexes all web sessions by `sessionId`.
- Methods used: `initialize`, `session/new`, `session/load`, `session/list`,
  `session/delete`, `session/prompt`, `session/cancel`,
  `session/set_config_option` (mode + model pickers arrive as `configOptions`).
- Agent→client `session/request_permission` is routed to the session's
  subscribers; the first response wins.
- `session/list` `_meta` fields: `cognition.ai/isLocked`,
  `lockHolderPid`, `hasUserMessages`, `createdAt`.

## Transcript search

- `GET /api/sessions/search?q=` runs on a `worker_threads` worker (`server/src/transcript-search*.js`) — the devin sqlite is hundreds of MiB and `node:sqlite` is synchronous, so main-thread scans would freeze WS streams. Scans sessions most-recent-first with a time budget (default 8s) and posts hits incrementally; termination still returns what was found. At most 2 concurrent searches (429 otherwise). Old workers lack the route → 404 → the UI says the remote component is too old.
- Devin: `chat_message LIKE ? ESCAPE '\'` prefilter on `session_id` (JSON-escaped query matches the stored escaping; `%`/`_`/`\\` escaped), then JSON.verify — user/assistant text only (never tool outputs/images), deduped by `message_id`. Pi: streams `*_<id>.jsonl` with a line prefilter then JSON verify — scans **all** branches (including abandoned) at session level only.
- Sidebar: instant title filter plus a debounced `内容匹配` section (focused host, `{ signal }` aborts superseded fetches). Clicking a hit opens the session and hands the pane a `searchRequest` so its Ctrl+F `.ts-search` opens prefilled.
- Backend restart (and remote worker reinstall) required for the route to exist.

## i18n

- `web/src/i18n.js` `t(source, vars)` — the zh source string is the key; the `en` dictionary lives in `web/src/locales/en.js` (empty values fall back to zh). `{name}` placeholders interpolate. `lang` is a `dw.lang` UI pref (`zh`/`en`); `setLang` saves and reloads the page — drafts/layout are already persisted. Server-provided text (API errors, session titles, paths) is never wrapped.
- `server/test/i18n.test.mjs` — unit + a static coverage scan asserting every `t("…")`/`t(\`…\`)`/`t('…')` literal in web/src has an `en` entry, plus a CJK-leak scan for unwrapped strings in JSX-text/attribute positions (comments stripped; allowlist below).

## Quick chat

- Local-host-only (phase 1). Each quick chat gets a fresh scratch working
  directory: `<root>/<YYYYMMDD-HHmmss>-<6hex>` under
  `DEVIN_WEB_SCRATCH_DIR` or `~/.local/share/devin-web/scratch` (mode 0700).
  `server/src/scratch.js` owns creation, the direct-child `isScratchDir`
  guard (realpath-checked, lexical fallback for missing dirs), bounded
  `scratchInfo` walks (10k entries, never follows symlinks) and removal.
- Sessions carry `scratch: true` in metadata and list rows; scratch cwds are
  never added to the workspace MRU. The sidebar groups them into one
  collapsed-by-default "临时对话" group (key `__scratch__`, always last).
- `POST /api/sessions {scratch:true}` ignores `cwd`; `GET /api/sessions/:id/scratch`
  reports dir contents; `POST .../scratch/finish {files:"keep"|"delete"}`
  returns 409 while the session is running, has background jobs, queued
  prompts, or pending permissions/elicitations — then releases the session,
  optionally removes the dir, and archives the session (history survives;
  reopening recreates the empty dir if deleted). Nothing retries itself.
- `GET /api/state` advertises `scratch: true`; the frontend warns instead of
  sending `scratch` to an old backend.
- The panel is a pseudo-pane (`quick.sessionId` persists in sessionStorage
  `dw.quick`): it joins the subscription set, host wiring and cache-eviction
  keys, so it keeps streaming while hidden. `dw.quickKey` (default
  `Ctrl+Shift+Space`, capture-phase, customizable in settings) and
  `dw.quickAgent` (default Pi) are UI prefs.
- It renders as a centered `role="dialog"` modal over a `modal-back`
  backdrop and stays mounted (inert + hidden, not unmounted) when closed.
  Desktop corner-resizes via `DialogResize`, persisted in `dw.quick.size`;
  `DialogMaximize` persists `dw.dialogMax.quick`; mobile is full screen.
  The old `dw.quick.width`/grip model is gone. Pinning (`dw.quick.pinned`)
  only keeps backdrop clicks from hiding it. Escape and browser back hide
  it; while open its layer blocks the main pane's chat shortcuts via
  `layerBlocks` (the chat inside the dialog keeps working).
- New routes require an explicitly authorized coordinator restart.
