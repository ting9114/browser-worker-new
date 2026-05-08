# browser-worker

A REST API browser automation service built on Playwright + Chromium, designed to be called from **n8n**, scripts, or any HTTP client. Bundles a generic browser-automation engine with purpose-built endpoints for **Yahoo Sender Hub** session management.

Browser runs locally inside the same container — no external WebSocket, no Browserless dependency, no flaky timeouts.

## Architecture

```
┌─────────────┐   HTTP/JSON   ┌────────────────────┐   Playwright   ┌──────────────┐
│  n8n / app  │ ────────────► │   browser-worker   │ ─────────────► │   Chromium   │
│             │ ◄──────────── │   (Express API)    │ ◄───────────── │   (Xvfb)     │
└─────────────┘               └────────────────────┘                └──────────────┘
                                       │
                                       ├── Persistent profiles (per email)
                                       └── Debug screenshots
```

Two API surfaces in one service:

1. **Generic automation** — `/execute` runs arbitrary action steps (goto, click, fill, evaluate, screenshot, …) inside ephemeral or sticky sessions.
2. **Yahoo Sender Hub** — `/yahoo/cookies`, `/yahoo/import`, `/yahoo/debug/:email` handle the headful login dance + persistent profile reuse needed to pull spam-complaint data out of `senders.yahooinc.com`.

## Why this exists

Yahoo Sender Hub blocks headless browsers and won't accept input in the login form unless a real display is attached. This worker runs Chromium in `headless: false` mode behind **Xvfb** (virtual display) inside Docker, which makes Yahoo treat it like a normal desktop browser — while still being fully containerized and orchestratable from n8n on a VPS.

The generic `/execute` API is a bonus: same container, same browser pool, same TTL-based session lifecycle, available for any other scraping or automation job.

---

## Quick Start

```bash
# 1. Optional: configure port
cp .env.example .env

# 2. Build & run
docker compose up -d --build

# 3. Health check
curl http://localhost:3001/health
# => { "ok": true, "sessions": 0 }
```

The container exposes port `3001` (configurable via `PORT`). When deployed alongside n8n on the same Docker network, n8n reaches it as `http://browser-worker:3001`.

---

## Yahoo Sender Hub API

These endpoints are tailored for the Yahoo Sender Hub workflow: login → persistent profile → reuse for downstream data fetches.

### `POST /yahoo/cookies`

Logs into Yahoo Sender Hub with email + password using a headful browser (real display via Xvfb). On success, the browser profile is saved to disk and fresh session cookies are returned.

**Request:**
```json
{ "email": "you@yahoo.com", "password": "your-password" }
```

**Success response:**
```json
{
  "ok": true,
  "email": "you@yahoo.com",
  "loginRequired": true,
  "cookies": { "T": "...", "Y": "...", "F": "..." },
  "cookieString": "T=...; Y=...; F=..."
}
```

**Error response (e.g. 2FA prompt, captcha, wrong password):**
```json
{ "ok": false, "step": "fill_password", "error": "...", "email": "you@yahoo.com" }
```

The first call performs a full login. Subsequent calls reuse the persistent profile saved at `/app/profiles/<email>` and return without re-entering credentials, as long as the Yahoo session is still valid.

### `POST /yahoo/import`

Imports a session from cookies obtained out-of-band (e.g. from a separate Python/Selenium step) and verifies them against Sender Hub.

**Request:**
```json
{
  "email": "you@yahoo.com",
  "cookies": { "T": "...", "Y": "...", "F": "..." }
}
```

If valid → returns a fresh cookie set and saves the profile. If expired → returns `401 session_expired`.

### `GET /yahoo/debug/:email`

Returns the latest debug screenshot for a given email as a PNG. Useful for diagnosing failed logins (captcha shown, 2FA, unexpected redirect, etc.). Screenshots are saved at each major step of `/yahoo/cookies`.

Example:
```
GET http://localhost:3001/yahoo/debug/you%40yahoo.com
```

---

## Generic Automation API

### `POST /execute`

Executes one or more browser actions in a single request. Creates a new session if `sessionId` is omitted, or reuses (and extends the TTL of) an existing session.

**Request body:**

| Field | Default | Description |
|---|---|---|
| `sessionId` | — | UUID of an existing session. Omit to create a new one. |
| `ttl` | `30000` | Session lifetime in ms after the last request. |
| `stealth` | `true` | Anti-detection patches (`navigator.webdriver`, `window.chrome`, etc.). |
| `blockAds` | `false` | Block ads/trackers. `true`, an array of patterns, or `{ useDefaults?, custom? }`. |
| `disableSecurity` | `false` | Ignore SSL errors, bypass CSP, disable web security. |
| `forceHttp` | `false` | Downgrade HTTPS → HTTP. `true` (all) or array of hostnames. |
| `addCSS` | `''` | CSS injected into every page before load. |
| `addJS` | `''` | JS injected into every page before load. |
| `proxy` | `null` | Optional Playwright proxy config. |
| `steps` | `[]` | Array of `{ action, params }` to execute in order. |
| `stopOnError` | `true` | Halt on first failed step. |

**Example:**
```json
{
  "ttl": 600000,
  "blockAds": true,
  "disableSecurity": true,
  "steps": [
    { "action": "goto", "params": { "url": "https://example.com" } },
    { "action": "waitForSelector", "params": { "selector": "h1" } },
    { "action": "getContent" }
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "uuid-here",
  "created": true,
  "results": [
    { "action": "goto", "ok": true, "result": { "url": "https://example.com/" } },
    { "action": "waitForSelector", "ok": true, "result": { "found": true } },
    { "action": "getContent", "ok": true, "result": { "html": "<html>…</html>" } }
  ],
  "finalUrl": "https://example.com/"
}
```

### Available actions

| Action | Params | Returns |
|--------|--------|-------------------------------------------------|
| `goto` | `{ url, waitUntil?, timeout? }` | `{ url }` |
| `reload` | `{ waitUntil? }` | `{ url }` |
| `getUrl` | — | `{ url }` |
| `getContent` | — | `{ html }` |
| `click` | `{ selector, timeout? }` | `{ clicked }` |
| `fill` | `{ selector, value }` | `{ filled }` |
| `type` | `{ selector, text, delay? }` | `{ typed }` |
| `select` | `{ selector, value }` | `{ selected }` |
| `check` | `{ selector, state? }` | `{ checked }` |
| `keyboard` | `{ key }` | `{ pressed }` |
| `hover` | `{ selector }` | `{ hovered }` |
| `wait` | `{ ms }` | `{ waited }` |
| `waitForSelector` | `{ selector, state?, timeout? }` | `{ found }` |
| `waitForNavigation` | `{ waitUntil? }` | `{ url }` |
| `evaluate` | `{ script }` | `{ value }` |
| `getText` | `{ selector }` | `{ text }` |
| `getAttribute` | `{ selector, attr }` | `{ value }` |
| `screenshot` | `{ selector?, fullPage? }` | `{ screenshot: base64 }` |
| `uploadFile` | `{ selector, files }` | `{ uploaded }` |
| `getCookies` | — | `{ cookies }` |
| `setCookies` | `{ cookies }` | `{ set }` |
| `getLocalStorage` | `{ key }` | `{ value }` |

### `blockAds` shorthand

| Input | Effect |
|---|---|
| `true` | Default 50+ ad/tracker patterns |
| `["foo.com"]` | Defaults + custom patterns |
| `{ useDefaults: false, custom: [...] }` | Custom patterns only |
| `false` | Disabled |

Default patterns live in [`src/ad-patterns.js`](./src/ad-patterns.js) — edit there to extend the global list.

### `forceHttp` shorthand

| Input | Effect |
|---|---|
| `true` | All HTTPS → HTTP |
| `["legacy.local"]` | Only listed hostnames |
| Auto | Any `http://` URL passed to `goto` adds its host to the list |

---

## Session Management

### `GET /sessions`
List active sessions with current URL and TTL.

### `GET /sessions/:id`
Detailed state of one session.

### `DELETE /sessions/:id`
Close immediately and free the browser.

### `GET /health`
`{ ok: true, sessions: N }` — useful for Docker healthchecks and uptime monitoring.

### TTL behavior

- **Initial TTL**: set on session creation (default 30s). Pass `ttl` on the first `/execute` to override.
- **Extension**: every request to an existing `sessionId` resets the timer.
- **Update**: passing a new `ttl` on a follow-up request changes the active timer.
- **Cleanup**: when the timer expires, the worker calls `browser.close()` and deletes the session.

This makes it easy to keep a browser alive across a multi-step n8n workflow (`ttl: 600000` for 10 minutes) and let it die naturally afterward.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3001`  | HTTP server port |

---

## Deployment notes

### Docker volumes

`docker-compose.yml` defines two named volumes — keep them, they hold state:

- `browser_profiles` → `/app/profiles` — persistent Chromium profiles per Yahoo email. **Don't delete unless you want to re-login everywhere.**
- `browser_debug` → `/app/debug` — debug screenshots served by `/yahoo/debug/:email`.

### Running alongside n8n

To call this worker from n8n on the same VPS without exposing port 3001 publicly:

1. Bind the port to localhost only in `docker-compose.yml`:
   ```yaml
   ports:
     - "127.0.0.1:3001:3001"
   ```
2. Attach the worker to your shared Docker network (e.g. `shared_bridge`) so n8n can reach it as `http://browser-worker:3001`.

### Memory & shared memory

Chromium is hungry. The compose file ships with `shm_size: 2gb` and `mem_limit: 6g` — leave both in place. Lowering `shm_size` causes random tab crashes on heavy pages.

### `headless: false` + Xvfb

The Yahoo flow deliberately runs the browser non-headless inside the container. The Dockerfile installs `xvfb`, and `entrypoint.sh` starts a virtual display before launching Node. This is what lets Yahoo's login form actually accept keystrokes.

---

## Project structure

```
browser-worker/
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh        # starts Xvfb, then node
├── package.json
└── src/
    ├── server.js        # Express app, sessions, /execute, /yahoo/*
    ├── ad-patterns.js   # default ad/tracker block list
    └── ad-patterns.test.js
```

---

## License

MIT