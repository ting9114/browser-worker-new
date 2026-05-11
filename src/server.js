import express from 'express';
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolveAdPatterns } from './ad-patterns.js';

const app = express();
app.use(express.json());

// session id -> { sessionId, browser, context, page, ttl, timer, forceHttpHosts: Set<string>, blockAds, forceHttp }
const sessions = new Map();

/**
 * Resets the session expiration timer.
 */
function resetTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    console.log(`[session:${sessionId}] TTL expired (${session.ttl}ms)`);
    closeSession(sessionId);
  }, session.ttl);
}

/**
 * Closes the browser session and removes it from the sessions map.
 */
async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.closing) return;

  session.closing = true;

  clearTimeout(session.timer);

  try { await session.browser.close(); } catch {}

  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}

/**
 * Creates a new browser session with AdBlocking, CSS/JS injection, and Force HTTP.
 */
async function createSession(options = {}) {
  console.log('Creating new session with options:', options);
  const {
    ttl = 30000,
    stealth = true,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = '',
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    proxy = null,
    cookies: initialCookies = null,
    timezone = null,
  } = options;

  const sessionId = randomUUID();
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu-memory-buffer-video-frames',
    '--disable-gpu-memory-buffer-compositor-resources',
    '--mute-audio',
    // '--disable-background-networking' breaks proxy connections — omit when proxy is set
    ...(!proxy ? ['--disable-background-networking'] : []),
  ];

  if (disableSecurity) {
    args.push(
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--disable-features=SafeBrowsing,LocalNetworkAccessChecks',
      '--disable-hsts',
      '--disable-site-isolation-trials'
    );
  }

  // Normalise proxy: extract credentials embedded in server URL into separate fields.
  // Playwright requires { server, username?, password? } — credentials in the URL are ignored.
  let proxyConfig = null;
  if (proxy) {
    try {
      const raw = typeof proxy === 'string' ? proxy : proxy.server;
      const u = new URL(raw);
      proxyConfig = {
        server: `${u.protocol}//${u.host}`,
        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
        // allow explicit override fields from the caller
        ...(proxy.username ? { username: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      };
    } catch {
      proxyConfig = typeof proxy === 'string' ? { server: proxy } : proxy;
    }
    console.log(`[session:${sessionId}] proxy server: ${proxyConfig.server} user: ${proxyConfig.username ?? '(none)'}`);
  }

  console.log(`[session:${sessionId}] Launching Google Chrome...`);
  const browser = await chromium.launch({
    headless: true,
    args,
    // Set proxy at launch level — required for residential/authenticated proxies
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: disableSecurity,
    javaScriptEnabled: true,
    bypassCSP: disableSecurity,
    extraHTTPHeaders: { 'Upgrade-Insecure-Requests': '0' },
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
    ...(timezone ? { timezoneId: timezone } : {}),
  });

  // --- Initial Cookies ---
  // Inject cookies before the first page is created so they're available immediately on goto.
  if (Array.isArray(initialCookies) && initialCookies.length) {
    await context.addCookies(initialCookies);
    console.log(`[session:${sessionId}] injected ${initialCookies.length} initial cookie(s)`);
  }

  // --- CSS Injection ---
  if (addCSS) {
    await context.addInitScript(({ css }) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.documentElement.appendChild(style);
    }, { css: addCSS });
  }

  // --- JS Injection ---
  // Use { content } directly so the script runs in page context before any page scripts.
  // The script-element approach had timing issues with property overrides.
  if (addJS) {
    await context.addInitScript({ content: addJS });
  }

  // --- Stealth ---
  if (stealth) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
  }

  const page = await context.newPage();

  // Normalize forceHttp: true = all domains, array = only these domains
  const forceHttpHosts = Array.isArray(forceHttp) ? new Set(forceHttp) : new Set();

  const sessionObj = { sessionId, browser, context, page, ttl, blockAds, forceHttp, forceHttpHosts, proxy, userAgent };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created`);
  return sessionObj;
}

async function setupRoutes(session) {
  const { context, sessionId, forceHttp, forceHttpHosts, blockAds } = session;

  // Remove existing routes to prevent duplicates on session reuse
  await context.unroute('**/*');

  const patterns = resolveAdPatterns(blockAds);
  const adBlockingEnabled = patterns !== null;
  const forceHttpActive = forceHttp === true || forceHttpHosts.size > 0;

  if (!forceHttpActive && !adBlockingEnabled) {
    return;
  }

  await context.route('**/*', async (route) => {
    const urlStr = route.request().url();
    const urlLower = urlStr.toLowerCase();

    // AdBlock
    const isAd = adBlockingEnabled && patterns.some(p => urlLower.includes(p));
    if (isAd) {
      console.log(`[session:${sessionId}] AdBlock: ${urlStr}`);
      return route.abort();
    }
    let url = null;
    try { url = new URL(urlStr); } catch {}
    const hostname = url?.hostname?.toLowerCase();

    // ForceHTTP — check if this hostname should be forced
    const shouldForceHttp = forceHttp === true || (hostname && forceHttpHosts.has(hostname));
    if (shouldForceHttp && url.protocol === 'https:') {
      const httpUrl = urlStr.replace(/^https:/, 'http:');
      console.log(`[session:${sessionId}] ForceHTTP: ${urlStr} → ${httpUrl}`);
      try {
        const response = await route.fetch({ url: httpUrl });
        await route.fulfill({ response });
        return;
      } catch (e) {
        console.log(`[session:${sessionId}] ForceHTTP failed: ${e.message}`);
      }
    }

    route.continue();
  });

  const hostInfo = forceHttp === true ? 'all hosts' : `hosts: ${[...forceHttpHosts].join(', ') || 'none'}`;
  console.log(`[session:${sessionId}] Routes setup — forceHttp: ${hostInfo}, adBlock: ${adBlockingEnabled}`);
}

/**
 * Executes a single step in the browser.
 */
async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context } = session;

  switch (action) {
      case 'goto': {
        try {
          const targetUrl = new URL(params.url);
          // Auto-detect: if URL uses http://, add hostname to forceHttpHosts
          if (targetUrl.protocol === 'http:') {
            session.forceHttpHosts.add(targetUrl.hostname.toLowerCase());
          }
          await setupRoutes(session);
        } catch (e) {
          return { error: `Invalid URL: ${params.url}` };
        }
        await page.goto(params.url, { waitUntil: params.waitUntil ?? 'domcontentloaded', timeout: params.timeout ?? 3600000 });
        return { url: page.url() };
      }
      case 'reload':
        await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
        return { url: page.url() };
      case 'getUrl':
        return { url: page.url() };
      case 'getContent':
        return { html: await page.content() };
      case 'click':
        await page.click(params.selector, { timeout: params.timeout ?? 30000 });
        return { clicked: params.selector };
      case 'fill':
        await page.fill(params.selector, params.value);
        return { filled: params.selector };
      case 'type':
        await page.type(params.selector, params.text, { delay: params.delay ?? 30 });
        return { typed: params.selector };
      case 'select':
        await page.selectOption(params.selector, params.value);
        return { selected: params.value };
      case 'check':
        params.state === false ? await page.uncheck(params.selector) : await page.check(params.selector);
        return { checked: params.selector };
      case 'keyboard':
        await page.keyboard.press(params.key);
        return { pressed: params.key };
      case 'hover':
        await page.hover(params.selector);
        return { hovered: params.selector };
      case 'wait':
        await page.waitForTimeout(params.ms ?? 1000);
        return { waited: params.ms };
      case 'waitForSelector':
        await page.waitForSelector(params.selector, {
          state: params.state ?? 'visible',
          timeout: params.timeout ?? 30_000
        });
        return { found: params.selector };
      case 'waitForNavigation':
        await page.waitForLoadState(params.waitUntil ?? 'networkidle');
        return { url: page.url() };
      case 'evaluate':
        return { value: await page.evaluate(params.script) };
      case 'getText':
        return { text: await page.textContent(params.selector) };
      case 'getAttribute':
        return { value: await page.getAttribute(params.selector, params.attr) };
      case 'screenshot': {
        const opts = { type: 'png', fullPage: params.fullPage ?? false };
        const buf = params.selector
          ? await page.locator(params.selector).screenshot(opts)
          : await page.screenshot(opts);
        return { screenshot: buf.toString('base64') };
      }
      case 'uploadFile': {
        // Accepts a base64-encoded file and uploads it to a file input element.
        // params: { selector, filename, base64, force }
        // force: true bypasses Playwright visibility checks (needed for CSS-hidden inputs in custom widgets)
        const { selector, filename = 'upload.csv', base64: fileBase64, force = true } = params;
        if (!fileBase64) throw new Error('uploadFile: base64 param is required');
        const uploadDir = '/tmp/bw-uploads';
        mkdirSync(uploadDir, { recursive: true });
        const filePath = join(uploadDir, filename);
        writeFileSync(filePath, Buffer.from(fileBase64, 'base64'));
        await page.setInputFiles(selector, filePath, { force: true });
        try { await page.dispatchEvent(selector, 'change', {}, { force: true }); } catch {}
        try { unlinkSync(filePath); } catch {}
        return { uploaded: filename };
      }
      case 'getCookies':
        return { cookies: await context.cookies() };
      case 'setCookies':
        await context.addCookies(params.cookies);
        return { set: params.cookies.length };
      case 'getLocalStorage':
        return { value: await page.evaluate((k) => localStorage.getItem(k), params.key) };
      default:
        if (typeof page[action] === 'function') {
          const result = await page[action](params);
          return { result };
        }
        throw new Error(`Unknown action: "${action}"`);
    }
}

/**
 * Main execution endpoint.
 */
app.post('/execute', async (req, res) => {
  const {
    sessionId,
    ttl,
    stealth = true,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = '',
    userAgent,
    proxy,
    cookies,
    timezone,
    steps = [],
    stopOnError = true
  } = req.body;

  if (!steps.length) return res.status(400).json({ ok: false, error: 'steps required' });
  
  let session = sessionId ? sessions.get(sessionId) : null;
  if (sessionId && !session) return res.status(404).json({ ok: false, error: 'Session expired' });

  if (!session) {
    const sessionTtl = ttl || 30000;
    try {
      session = await createSession({ ttl: sessionTtl, stealth, blockAds, forceHttp, disableSecurity, addCSS, addJS, userAgent, proxy, cookies, timezone });
    } catch (err) {
      return res.status(503).json({ ok: false, error: err.message });
    }
  } else if (ttl) {
    session.ttl = ttl;
    console.log(`[session:${session.sessionId}] TTL updated to ${ttl}ms`);
  }

  const results = [];
  let error = null;
  for (const step of steps) {
    session.busy = true;
    try {
      console.log(`[session:${session.sessionId}] action: ${step.action}`, step.params);
      const result = await executeStep(session, step);
      console.log(`[session:${session.sessionId}] result: ${step.action}`, result);
      results.push({ action: step.action, ok: true, result });
    } catch (e) {
      results.push({ action: step.action, ok: false, error: e.message });
      error = e.message;
      if (stopOnError) break;
    } finally {
      session.busy = false;
    }
  }

  resetTimer(session.sessionId);

  let finalUrl = null;
  try {
    finalUrl = session?.page && !session.page.isClosed() ? session.page.url() : null;
  } catch {}

  res.json({ 
    ok: !error,
    sessionId: session.sessionId, 
    results, 
    finalUrl, 
    error: !!error ? error : undefined 
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo cookie-refresh endpoint
// POST /yahoo/cookies
//
// Body:
//   { "email": "...", "password": "..." }
//
// Works exactly like the Python yahoo_cookie_refresher.py:
//   - Each account gets its own persistent Chromium profile saved to disk at
//     /app/profiles/<email>/  — Yahoo sees a familiar "device" on every run.
//   - First run: full login with credentials.
//   - Subsequent runs: session is usually still alive, no login needed.
//   - If session expired: auto re-login.
//
// Response (success):
//   { "ok": true, "email": "...", "loginRequired": bool,
//     "finalUrl": "...", "cookies": {...}, "cookieString": "..." }
//
// Response (2FA required):
//   { "ok": false, "error": "2fa_required", "email": "...", "finalUrl": "..." }
// ─────────────────────────────────────────────────────────────────────────────

const YAHOO_DASHBOARD_URL = 'https://senders.yahooinc.com/feature-management/dashboard/';
const YAHOO_LOGIN_URL     = 'https://login.yahoo.com';
const YAHOO_DOMAINS       = ['yahoo.com', 'yahooinc.com'];
const PROFILES_DIR        = '/app/profiles';
const DEBUG_DIR           = '/app/debug';

try { mkdirSync(PROFILES_DIR, { recursive: true }); } catch {}
try { mkdirSync(DEBUG_DIR,    { recursive: true }); } catch {}

function profileDir(email) {
  const safe = createHash('md5').update(email.toLowerCase()).digest('hex');
  return join(PROFILES_DIR, safe);
}

function filterYahooCookies(rawCookies = []) {
  const result = {};
  for (const c of rawCookies) {
    if (YAHOO_DOMAINS.some(d => (c.domain || '').includes(d))) {
      result[c.name] = c.value;
    }
  }
  return result;
}

/** Take a screenshot and save it to /app/debug/<email>.png for debugging. */
async function debugScreenshot(page, email, label = '') {
  try {
    const safe = email.replace(/[^a-z0-9]/gi, '_');
    const path = join(DEBUG_DIR, `${safe}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`[yahoo:${email}] screenshot saved: ${path} (${label})`);
    return path;
  } catch (e) {
    console.log(`[yahoo:${email}] screenshot failed: ${e.message}`);
    return null;
  }
}

const onLoginPage = url => url.includes('login.yahoo.com') || url.includes('login.yahooinc.com');
const onDashboard = url => url.includes('senders.yahooinc.com');

/** GET /yahoo/debug/:email — returns the last debug screenshot as an image */
app.get('/yahoo/debug/:email', (req, res) => {
  const safe = req.params.email.replace(/[^a-z0-9]/gi, '_');
  const path = join(DEBUG_DIR, `${safe}.png`);
  res.sendFile(path, err => {
    if (err) res.status(404).json({ ok: false, error: 'No screenshot found. Run /yahoo/cookies first.' });
  });
});

app.post('/yahoo/cookies', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password are required' });
  }

  const dir = profileDir(email);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  console.log(`[yahoo:${email}] profile: ${dir}`);

  let context, page;
  let loginRequired = false;
  let step = 'launch';

  try {
    step = 'launch';
    // headless: false + Xvfb virtual display = same as running locally with a real browser.
    // Yahoo blocks headless mode — it refuses to accept input in the login form.
    context = await chromium.launchPersistentContext(dir, {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    page = context.pages()[0] || await context.newPage();

    // ── 1. Navigate to Sender Hub — Yahoo redirects to login with correct OAuth done= URL ──
    step = 'goto_dashboard';
    console.log(`[yahoo:${email}] navigating to Sender Hub...`);
    try {
      await page.goto(YAHOO_DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      // domcontentloaded may fire mid-redirect — fine, just read the url
    }
    await page.waitForTimeout(3000);
    let currentUrl = page.url();
    console.log(`[yahoo:${email}] landed: ${currentUrl}`);
    await debugScreenshot(page, email, 'after_dashboard_nav');

    // ── 2. Login if needed ────────────────────────────────────────────────────
    if (!onDashboard(currentUrl)) {
      loginRequired = true;
      console.log(`[yahoo:${email}] not on dashboard — logging in from redirected URL: ${currentUrl}`);

      // Stay on the redirected login page (has correct OAuth done= pointing back to Sender Hub)
      // Only navigate to login.yahoo.com if Yahoo didn't redirect us there automatically
      if (!onLoginPage(currentUrl)) {
        step = 'goto_login';
        await page.goto(YAHOO_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      await debugScreenshot(page, email, 'login_page');

      step = 'fill_username';
      await page.waitForSelector("input[name='username']", { timeout: 15_000 });
      await page.click("input[name='username']");
      await page.waitForTimeout(500);
      // Triple-click to select all existing text, then type — avoids leftover prefilled value
      await page.click("input[name='username']", { clickCount: 3 });
      await page.type("input[name='username']", email, { delay: 80 });
      await page.waitForTimeout(800);
      await page.keyboard.press('Enter');
      await debugScreenshot(page, email, 'after_username_enter');

      // Wait for password field
      step = 'fill_password';
      await page.waitForSelector("input[name='password']", { timeout: 15_000 });
      await debugScreenshot(page, email, 'password_page');
      await page.click("input[name='password']");
      await page.waitForTimeout(500);
      // Type character by character with realistic delays — avoids bot detection
      await page.type("input[name='password']", password, { delay: 80 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('Enter');
      await debugScreenshot(page, email, 'after_password_submit');

      // Wait for Yahoo to redirect away from login domain (back to Sender Hub via OAuth done=)
      step = 'wait_post_login';
      try {
        await page.waitForURL(url => !onLoginPage(url), { timeout: 60_000 });
      } catch {
        await debugScreenshot(page, email, 'post_login_timeout');
        const finalUrl = page.url();
        const is2FA = finalUrl.includes('challenge') && !finalUrl.includes('challenge/password');
        console.log(`[yahoo:${email}] did not leave login domain — url: ${finalUrl}, 2fa: ${is2FA}`);
        await context.close();
        return res.status(401).json({
          ok: false,
          error: is2FA ? '2fa_required' : 'login_failed',
          email,
          finalUrl,
          debug: `GET http://localhost:3001/yahoo/debug/${encodeURIComponent(email)} to see screenshot`,
        });
      }

      await page.waitForTimeout(3000);
      currentUrl = page.url();
      console.log(`[yahoo:${email}] post-login url: ${currentUrl}`);
      await debugScreenshot(page, email, 'post_login');

      // If OAuth redirected us somewhere other than Sender Hub, go there now
      if (!onDashboard(currentUrl)) {
        step = 'goto_dashboard_post_login';
        console.log(`[yahoo:${email}] navigating to Sender Hub from ${currentUrl}...`);
        try {
          await page.goto(YAHOO_DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {}
        await page.waitForTimeout(3000);
        currentUrl = page.url();
        console.log(`[yahoo:${email}] final url: ${currentUrl}`);
        await debugScreenshot(page, email, 'post_login_dashboard');
      }

      if (!onDashboard(currentUrl)) {
        await context.close();
        return res.status(401).json({
          ok: false,
          error: 'login_failed',
          email,
          finalUrl: currentUrl,
          debug: `GET http://localhost:3001/yahoo/debug/${encodeURIComponent(email)} to see screenshot`,
        });
      }
    }

    // ── 3. Extract cookies ────────────────────────────────────────────────────
    step = 'get_cookies';
    await page.waitForTimeout(2000);
    await debugScreenshot(page, email, 'final');

    const finalUrl     = page.url();
    const rawCookies   = await context.cookies();
    const cookies      = filterYahooCookies(rawCookies);
    const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    console.log(`[yahoo:${email}] done — ${Object.keys(cookies).length} cookies, loginRequired=${loginRequired}`);
    await context.close();

    return res.json({ ok: true, email, loginRequired, finalUrl, cookies, cookieString });

  } catch (err) {
    console.error(`[yahoo:${email}] error at step "${step}":`, err.message);
    if (page) await debugScreenshot(page, email, `error_${step}`);
    try { await context?.close(); } catch {}
    return res.status(500).json({
      ok: false,
      error: err.message,
      step,
      email,
      debug: `GET http://localhost:3001/yahoo/debug/${encodeURIComponent(email)} to see screenshot`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /yahoo/import
//
// Bootstrap a Docker profile from existing cookies (from cookies.json produced
// by the Python yahoo_cookie_refresher.py script).
//
// Body: { "email": "...", "cookies": { "A1": "...", "A3": "...", ... } }
//
// What it does:
//   1. Opens a browser with the account's persistent profile
//   2. Sets the provided cookies
//   3. Navigates to Sender Hub dashboard to verify the session is valid
//   4. Saves the profile to disk — future /yahoo/cookies calls reuse it
//   5. Returns fresh cookies
//
// After a successful import, /yahoo/cookies will work without needing to log in.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/yahoo/import', async (req, res) => {
  const { email, cookies: cookiesDict } = req.body;
  if (!email || !cookiesDict || typeof cookiesDict !== 'object') {
    return res.status(400).json({ ok: false, error: 'email and cookies (object) are required' });
  }

  const dir = profileDir(email);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  let context;
  try {
    context = await chromium.launchPersistentContext(dir, {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });

    // Set the provided cookies across all Yahoo domains
    const playwrightCookies = [];
    for (const [name, value] of Object.entries(cookiesDict)) {
      for (const domain of ['.yahoo.com', '.yahooinc.com', 'senders.yahooinc.com']) {
        playwrightCookies.push({ name, value, domain, path: '/' });
      }
    }
    await context.addCookies(playwrightCookies);

    // Navigate to Sender Hub to verify session is valid
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(YAHOO_DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {}
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    await debugScreenshot(page, email, 'import_result');

    if (!onDashboard(currentUrl)) {
      await context.close();
      return res.status(401).json({
        ok: false,
        error: 'session_expired',
        email,
        finalUrl: currentUrl,
        message: 'The provided cookies are expired. Run the Python script again to get fresh ones.',
      });
    }

    // Extract fresh cookies from the live dashboard session
    const rawCookies   = await context.cookies();
    const cookies      = filterYahooCookies(rawCookies);
    const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    await context.close();
    console.log(`[yahoo:${email}] import successful — ${Object.keys(cookies).length} cookies, profile saved`);

    return res.json({
      ok: true,
      email,
      message: 'Session imported. Future calls to /yahoo/cookies will reuse this profile.',
      cookies,
      cookieString,
    });

  } catch (err) {
    try { await context?.close(); } catch {}
    return res.status(500).json({ ok: false, error: err.message, email });
  }
});

/**
 * Health check endpoint.
 */
app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

/**
 * List all active sessions.
 */
app.get('/sessions', (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    ttl: s.ttl,
    url: s.page.url()
  }));
  res.json({ count: list.length, sessions: list });
});

/**
 * Get a specific session.
 */
app.get('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, sessionId: req.params.id, url: s.page.url(), ttl: s.ttl });
});

/**
 * Delete a specific session.
 */
app.delete('/sessions/:id', async (req, res) => {
  if (!sessions.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found' });
  await closeSession(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Worker ready on :${PORT}`));

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

process.on('beforeExit', (code) => {
  console.error(`[FATAL] process.beforeExit code=${code}`);
});

process.on('exit', (code) => {
  console.error(`[PROCESS] exit with code ${code}`);
});

process.on('SIGTERM', () => {
  console.error('[PROCESS] SIGTERM received');
});

process.on('SIGINT', () => {
  console.error('[PROCESS] SIGINT received');
});

setInterval(() => {
  console.log(`[PROCESS] alive sessions=${sessions.size} uptime=${Math.round(process.uptime())}s`);
}, 60000);
