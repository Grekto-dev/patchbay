"use strict";

/**
 * Google Antigravity (Cloud Code) backend.
 *
 * Talks to the same internal API the Antigravity IDE uses, authenticated with
 * a Google account over OAuth instead of an AI Studio key. That surface serves
 * both the Gemini line and the Claude models Google hosts, and its quota is
 * per account rather than per key - which is why accounts are kept in a list
 * and rotated when one hits its limit.
 *
 * The protocol here (client id, headers, the v1internal endpoints, the project
 * onboarding dance and the [ignore] system-prompt trick) is taken from
 * badrisnarayanan/antigravity-claude-proxy, which worked it out first.
 *
 * Nothing in this file knows about Anthropic's format: it speaks Google's
 * GenerateContent shape and leaves the translation to the caller.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");

const ROOT = process.env.PROXY_ROOT ? path.resolve(process.env.PROXY_ROOT) : path.join(__dirname, "..");
const ACCOUNTS_PATH = path.join(ROOT, "google-accounts.json");

// ── Protocol constants ───────────────────────────────────

// Google's OAuth client for the Antigravity IDE. It is an "installed
// application" client - Google's own documentation says the secret of such a
// client is not treated as confidential, and every open-source tool that signs
// into Google ships one - but it is not ours to publish, and GitHub's secret
// scanning refuses the push, so it lives in .env rather than in this file:
//
//   PATCHBAY_GOOGLE_CLIENT_ID=...
//   PATCHBAY_GOOGLE_CLIENT_SECRET=...
//
// The README says where to get the two values. Read lazily, so filling them in
// takes effect without restarting anything.
function envValue(name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      if (line.slice(0, i).trim() === name) return line.slice(i + 1).trim();
    }
  } catch {
    /* no .env */
  }
  return "";
}

const OAUTH = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
};

function clientId() {
  return envValue("PATCHBAY_GOOGLE_CLIENT_ID");
}

function clientSecret() {
  return envValue("PATCHBAY_GOOGLE_CLIENT_SECRET");
}

function clientConfigured() {
  return Boolean(clientId() && clientSecret());
}

const CLIENT_MISSING =
  "No Google OAuth client configured. Add PATCHBAY_GOOGLE_CLIENT_ID and " +
  "PATCHBAY_GOOGLE_CLIENT_SECRET to .env - see the Google Antigravity section of the README.";

// Windows reserves chunks of the ephemeral range for Hyper-V and WSL, so the
// callback port is configurable and a few fallbacks are tried.
const CALLBACK_PORTS = [Number(process.env.OAUTH_CALLBACK_PORT) || 51121, 51122, 51123, 51124, 51125];

const HOST_DAILY = "daily-cloudcode-pa.googleapis.com";
const HOST_PROD = "cloudcode-pa.googleapis.com";
// generateContent works better on daily; loadCodeAssist on prod for a fresh
// account. Both lists are fallbacks, not alternatives.
const CALL_HOSTS = [HOST_DAILY, HOST_PROD];
const LOAD_HOSTS = [HOST_PROD, HOST_DAILY];

const IDE_TYPE_ANTIGRAVITY = 9;
const PLUGIN_TYPE_GEMINI = 2;

function platformEnum() {
  const p = os.platform();
  const a = os.arch();
  if (p === "darwin") return a === "arm64" ? 2 : 1;
  if (p === "linux") return a === "arm64" ? 4 : 3;
  if (p === "win32") return 5;
  return 0;
}

const CLIENT_METADATA = {
  ideType: IDE_TYPE_ANTIGRAVITY,
  platform: platformEnum(),
  pluginType: PLUGIN_TYPE_GEMINI,
};

const CLIENT_VERSION = process.env.ANTIGRAVITY_CLIENT_VERSION || "1.110.0";
const IDE_VERSION = process.env.ANTIGRAVITY_IDE_VERSION || "2.0.3";
const USER_AGENT = `antigravity/${IDE_VERSION} ${os.platform() === "win32" ? "win32" : os.platform() === "darwin" ? "darwin" : "linux"}/${process.arch}`;

const API_HEADERS = {
  "User-Agent": USER_AGENT,
  "Content-Type": "application/json",
  "X-Client-Name": "antigravity",
  "X-Client-Version": CLIENT_VERSION,
  "x-goog-api-client": "gl-node/18.18.2 fire/0.8.6 grpc/1.10.x",
};

// The server refuses requests whose system prompt does not look like the IDE's.
// The second copy inside [ignore] tags is what stops the model from answering
// as "Antigravity" - both halves are needed.
const SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team " +
  "working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. " +
  "The task may require creating a new codebase, modifying or debugging an existing codebase, or simply " +
  "answering a question.**Absolute paths only****Proactiveness**";

// How long an account sits out after a quota error, when the server does not
// say. Escalates while the failures keep coming.
const COOLDOWN_TIERS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];
const TOKEN_SKEW_MS = 60 * 1000;

// ── Account storage ──────────────────────────────────────
// { accounts: [{ email, refreshToken, projectId, tier, addedAt }] }

let store = null;
let storeMtime = 0;

function readStore() {
  try {
    const stat = fs.statSync(ACCOUNTS_PATH);
    if (store && stat.mtimeMs === storeMtime) return store;
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
    store = parsed && Array.isArray(parsed.accounts) ? parsed : { accounts: [] };
    storeMtime = stat.mtimeMs;
  } catch {
    store = { accounts: [] };
    storeMtime = 0;
  }
  return store;
}

function writeStore(next) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  store = next;
  try {
    storeMtime = fs.statSync(ACCOUNTS_PATH).mtimeMs;
  } catch {
    storeMtime = 0;
  }
}

function accounts() {
  return readStore().accounts.slice();
}

function hasAccounts() {
  return accounts().length > 0;
}

function addAccount(record) {
  const next = readStore();
  const list = next.accounts.filter((a) => a.email !== record.email);
  list.push({
    email: record.email,
    refreshToken: record.refreshToken,
    projectId: record.projectId || null,
    tier: record.tier || null,
    addedAt: new Date().toISOString(),
  });
  writeStore({ accounts: list });
  runtime.delete(record.email);
  return list.length;
}

function removeAccount(email) {
  const next = readStore();
  const before = next.accounts.length;
  const list = next.accounts.filter((a) => a.email !== email);
  writeStore({ accounts: list });
  runtime.delete(email);
  return before !== list.length;
}

// ── Per-account runtime state (never written to disk) ────

const runtime = new Map(); // email → { token, expiresAt, cooldownUntil, failures, lastError, lastUsedAt, sessionId }

function stateOf(email) {
  if (!runtime.has(email)) {
    runtime.set(email, {
      token: null,
      expiresAt: 0,
      cooldownUntil: 0,
      failures: 0,
      lastError: null,
      lastUsedAt: 0,
      sessionId: crypto.randomUUID() + Date.now(),
    });
  }
  return runtime.get(email);
}

function markRateLimited(email, ms) {
  const st = stateOf(email);
  const tier = COOLDOWN_TIERS_MS[Math.min(st.failures, COOLDOWN_TIERS_MS.length - 1)];
  st.failures += 1;
  st.cooldownUntil = Date.now() + (ms && ms > 0 ? ms : tier);
}

function markOk(email) {
  const st = stateOf(email);
  st.failures = 0;
  st.cooldownUntil = 0;
  st.lastError = null;
  st.lastUsedAt = Date.now();
}

function markError(email, message) {
  stateOf(email).lastError = message ? String(message).slice(0, 300) : null;
}

/** Accounts that are not sitting out a cooldown, least recently used first. */
function usableAccounts() {
  const now = Date.now();
  return accounts()
    .filter((a) => a.refreshToken && stateOf(a.email).cooldownUntil <= now)
    .sort((a, b) => stateOf(a.email).lastUsedAt - stateOf(b.email).lastUsedAt);
}

/** What the panel and the /status endpoint show. */
function summary() {
  const now = Date.now();
  return accounts().map((a) => {
    const st = stateOf(a.email);
    return {
      email: a.email,
      projectId: a.projectId || null,
      tier: a.tier || null,
      addedAt: a.addedAt || null,
      cooldownMs: st.cooldownUntil > now ? st.cooldownUntil - now : 0,
      failures: st.failures,
      lastError: st.lastError,
      lastUsedAt: st.lastUsedAt || null,
    };
  });
}

// ── Small HTTPS helpers ──────────────────────────────────

function request(opts, body, cb) {
  const transport = opts.protocol === "http:" ? http : https;
  const req = transport.request(
    {
      hostname: opts.hostname,
      port: opts.port || (opts.protocol === "http:" ? 80 : 443),
      path: opts.path,
      method: opts.method || "GET",
      headers: opts.headers || {},
      timeout: opts.timeout || 30000,
    },
    (res) => cb(null, res)
  );
  req.on("error", (e) => cb(e));
  req.on("timeout", () => {
    req.destroy();
    cb(new Error("timeout"));
  });
  if (body) req.write(body);
  req.end();
}

function readAll(res, cb) {
  let d = "";
  res.setEncoding("utf8");
  res.on("data", (c) => (d += c));
  res.on("end", () => cb(d));
}

function jsonRequest(opts, bodyObj, cb) {
  const body = bodyObj === undefined || bodyObj === null ? null : JSON.stringify(bodyObj);
  const headers = { ...(opts.headers || {}) };
  if (body) headers["Content-Length"] = Buffer.byteLength(body);
  request({ ...opts, headers }, body, (err, res) => {
    if (err) return cb(err);
    readAll(res, (text) => {
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* keep the raw text for the error message */
      }
      cb(null, { status: res.statusCode, json, text, headers: res.headers });
    });
  });
}

function form(params) {
  return new URLSearchParams(params).toString();
}

// ── OAuth ────────────────────────────────────────────────

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationUrl(redirectUri) {
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { url: OAUTH.authUrl + "?" + params.toString(), verifier, state };
}

function exchangeCode(code, verifier, redirectUri, cb) {
  const body = form({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  request(
    {
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    },
    body,
    (err, res) => {
      if (err) return cb(err);
      readAll(res, (text) => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* handled below */
        }
        if (res.statusCode !== 200 || !json || !json.access_token) {
          return cb(new Error("token exchange failed: " + text.slice(0, 200)));
        }
        cb(null, { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in });
      });
    }
  );
}

function refreshToken(refresh, cb) {
  if (!clientConfigured()) return cb(new Error(CLIENT_MISSING));
  const body = form({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  request(
    {
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    },
    body,
    (err, res) => {
      if (err) return cb(err);
      readAll(res, (text) => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* handled below */
        }
        if (res.statusCode !== 200 || !json || !json.access_token) {
          return cb(new Error("token refresh failed: " + text.slice(0, 200)));
        }
        cb(null, { accessToken: json.access_token, expiresIn: json.expires_in || 3600 });
      });
    }
  );
}

function userEmail(accessToken, cb) {
  jsonRequest(
    {
      hostname: "www.googleapis.com",
      path: "/oauth2/v1/userinfo",
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
    },
    null,
    (err, r) => {
      if (err) return cb(err);
      if (r.status !== 200 || !r.json || !r.json.email) return cb(new Error("could not read the account email"));
      cb(null, r.json.email);
    }
  );
}

/**
 * The OAuth callback lands on a throwaway local server. Google's client is
 * registered for http://localhost:<port>/oauth-callback, so the port matters.
 */
function startCallbackServer(expectedState, onResult) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const ok = !error && code && state === expectedState;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>Patchbay</title>" +
          '<body style="font:15px system-ui;background:#0f1216;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0">' +
          "<div style=\"text-align:center\"><h2>" +
          (ok ? "Account connected" : "Authorization failed") +
          "</h2><p style=\"color:#98a2b3\">" +
          (ok ? "You can close this tab and go back to Patchbay." : String(error || "unexpected callback")) +
          "</p></div>"
      );
      server.close();
      if (ok) onResult(null, code);
      else onResult(new Error(error || "authorization was not completed"));
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && index + 1 < CALLBACK_PORTS.length) {
        index += 1;
        return server.listen(CALLBACK_PORTS[index], "127.0.0.1");
      }
      reject(err);
    });
    server.on("listening", () => resolve({ port: CALLBACK_PORTS[index], server }));
    server.listen(CALLBACK_PORTS[index], "127.0.0.1");
  });
}

function authorizationUrl(redirectUri, state) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { url: OAUTH.authUrl + "?" + params.toString(), verifier };
}

/**
 * The interactive flow, start to finish. `ready` gets the URL to open as soon
 * as the callback server is listening; `done` gets the account once Google
 * redirects back - or an error, including the five-minute timeout.
 */
function authorize(ready, done) {
  if (!clientConfigured()) return ready(new Error(CLIENT_MISSING));
  const state = crypto.randomBytes(16).toString("hex");
  let flow = null;
  let settled = false;
  const finish = (err, value) => {
    if (settled) return;
    settled = true;
    done(err, value);
  };

  startCallbackServer(state, (err, code) => {
    if (err) return finish(err);
    exchangeCode(code, flow.verifier, flow.redirectUri, (err2, tokens) => {
      if (err2) return finish(err2);
      if (!tokens.refreshToken) {
        return finish(
          new Error(
            "Google returned no refresh token. Remove Patchbay's access at myaccount.google.com/permissions and connect again."
          )
        );
      }
      userEmail(tokens.accessToken, (err3, email) => {
        if (err3) return finish(err3);
        // Project discovery can take a while on a fresh account (it provisions
        // one), but an account without it is still worth keeping: the next
        // request tries again.
        discoverProject(tokens.accessToken, (err4, info) => {
          const record = {
            email,
            refreshToken: tokens.refreshToken,
            projectId: (info && info.projectId) || null,
            tier: (info && info.tier) || null,
          };
          addAccount(record);
          finish(null, { ...record, warning: err4 ? err4.message : null });
        });
      });
    });
  })
    .then(({ port, server }) => {
      const redirectUri = `http://localhost:${port}/oauth-callback`;
      const built = authorizationUrl(redirectUri, state);
      flow = { verifier: built.verifier, redirectUri };
      ready(null, { url: built.url, port });
      // Nobody sits in front of a consent screen forever.
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          server.close();
        } catch {
          /* already closed */
        }
        finish(new Error("timed out waiting for the Google consent screen"));
      }, 5 * 60 * 1000);
      if (timer.unref) timer.unref();
    })
    .catch((err) => ready(err));
}

// ── Access tokens and projects ───────────────────────────

function tokenFor(account, cb) {
  const st = stateOf(account.email);
  if (st.token && st.expiresAt - TOKEN_SKEW_MS > Date.now()) return cb(null, st.token);
  refreshToken(account.refreshToken, (err, tokens) => {
    if (err) {
      markError(account.email, err.message);
      return cb(err);
    }
    st.token = tokens.accessToken;
    st.expiresAt = Date.now() + tokens.expiresIn * 1000;
    cb(null, st.token);
  });
}

function loadCodeAssist(token, cb) {
  let i = 0;
  const attempt = () => {
    if (i >= LOAD_HOSTS.length) return cb(new Error("loadCodeAssist failed on every endpoint"));
    const host = LOAD_HOSTS[i++];
    jsonRequest(
      {
        hostname: host,
        path: "/v1internal:loadCodeAssist",
        method: "POST",
        headers: { Authorization: "Bearer " + token, ...API_HEADERS },
      },
      { metadata: CLIENT_METADATA },
      (err, r) => {
        if (err || !r || r.status !== 200 || !r.json) {
          if (r && r.status === 403 && /violation of terms of service/i.test(r.text || "")) {
            return cb(new Error("ACCOUNT_BANNED: " + (r.text || "").slice(0, 200)));
          }
          return attempt();
        }
        cb(null, r.json);
      }
    );
  };
  attempt();
}

function onboardUser(token, tierId, cb, attempt = 0) {
  jsonRequest(
    {
      hostname: CALL_HOSTS[0],
      path: "/v1internal:onboardUser",
      method: "POST",
      headers: { Authorization: "Bearer " + token, ...API_HEADERS },
    },
    { tierId, metadata: CLIENT_METADATA },
    (err, r) => {
      if (err || !r || r.status !== 200 || !r.json) return cb(new Error("onboardUser failed"));
      const project = r.json.response && r.json.response.cloudaicompanionProject && r.json.response.cloudaicompanionProject.id;
      if (r.json.done && project) return cb(null, project);
      // Provisioning is asynchronous; it settles in a few seconds.
      if (attempt >= 8) return cb(new Error("onboardUser did not finish in time"));
      setTimeout(() => onboardUser(token, tierId, cb, attempt + 1), 3000);
    }
  );
}

function tierOf(data) {
  const tiers = (data && data.allowedTiers) || [];
  const found = tiers.find((t) => t && t.isDefault) || tiers[0];
  return (found && found.id) || "free-tier";
}

function discoverProject(token, cb) {
  loadCodeAssist(token, (err, data) => {
    if (err) return cb(err);
    const tier = tierOf(data);
    const direct =
      typeof data.cloudaicompanionProject === "string"
        ? data.cloudaicompanionProject
        : (data.cloudaicompanionProject && data.cloudaicompanionProject.id) || null;
    if (direct) return cb(null, { projectId: direct, tier });
    onboardUser(token, tier, (err2, project) => {
      if (err2) return cb(err2);
      cb(null, { projectId: project, tier });
    });
  });
}

function projectFor(account, token, cb) {
  if (account.projectId) return cb(null, account.projectId);
  discoverProject(token, (err, info) => {
    if (err) return cb(err);
    // Persist it: onboarding is slow and only has to happen once.
    const next = readStore();
    for (const a of next.accounts) {
      if (a.email === account.email) {
        a.projectId = info.projectId;
        a.tier = info.tier;
      }
    }
    writeStore(next);
    account.projectId = info.projectId;
    cb(null, info.projectId);
  });
}

// ── Model catalog ────────────────────────────────────────

function isSupportedModel(id) {
  const lower = String(id).toLowerCase();
  return lower.includes("claude") || lower.includes("gemini");
}

// Everything below Gemini 3.5 is a previous generation still advertised by the
// API; 'gemini-pro-agent' is an unversioned alias of the 3.1 pro model.
function isOldGemini(id) {
  if (id === "gemini-pro-agent") return true;
  const m = String(id).match(/^gemini-(\d+(?:\.\d+)?)/);
  return Boolean(m) && parseFloat(m[1]) < 3.5;
}

function fetchAvailableModels(token, project, cb) {
  let i = 0;
  const attempt = () => {
    if (i >= CALL_HOSTS.length) return cb(new Error("fetchAvailableModels failed on every endpoint"));
    const host = CALL_HOSTS[i++];
    jsonRequest(
      {
        hostname: host,
        path: "/v1internal:fetchAvailableModels",
        method: "POST",
        headers: { Authorization: "Bearer " + token, ...API_HEADERS },
      },
      project ? { project } : {},
      (err, r) => {
        if (err || !r || r.status !== 200 || !r.json) {
          if (r && r.status === 403 && /violation of terms of service/i.test(r.text || "")) {
            return cb(new Error("ACCOUNT_BANNED: this Google account has been disabled by Google"));
          }
          return attempt();
        }
        cb(null, r.json);
      }
    );
  };
  attempt();
}

/**
 * The catalog, as the proxy and the panel both want it:
 *   { models: [id], info: { id: { displayName, quota, resetTime } }, email }
 */
function listModels(cb) {
  const list = accounts();
  if (!list.length) return cb(new Error("no Google account connected"));

  let i = 0;
  const attempt = () => {
    if (i >= list.length) return cb(new Error("no account could read the model list"));
    const account = list[i++];
    tokenFor(account, (err, token) => {
      if (err) return attempt();
      projectFor(account, token, (err2, project) => {
        if (err2) markError(account.email, err2.message);
        fetchAvailableModels(token, project || null, (err3, data) => {
          if (err3) {
            markError(account.email, err3.message);
            return attempt();
          }
          const entries = Object.entries((data && data.models) || {}).filter(([id]) => isSupportedModel(id));
          const info = {};
          for (const [id, meta] of entries) {
            const quota = meta && meta.quotaInfo;
            info[id] = {
              displayName: (meta && meta.displayName) || id,
              // Missing fraction with a reset time set means it is spent.
              remaining: quota ? (quota.remainingFraction != null ? quota.remainingFraction : quota.resetTime ? 0 : null) : null,
              resetTime: (quota && quota.resetTime) || null,
            };
          }
          cb(null, {
            // Sorted, because this list comes from an object's keys: the order
            // is whatever the server felt like, and ids are handed out in list
            // order. Without this the panel and the proxy number differently
            // whenever the two fetches come back in a different order.
            models: entries
              .map(([id]) => id)
              .filter((id) => !isOldGemini(id))
              .sort(),
            info,
            email: account.email,
          });
        });
      });
    });
  };
  attempt();
}

// ── Requests ─────────────────────────────────────────────

function isThinkingModel(model) {
  const lower = String(model).toLowerCase();
  if (lower.includes("thinking")) return true;
  const m = lower.match(/gemini-(\d+)/);
  return Boolean(m) && parseInt(m[1], 10) >= 3;
}

function buildPayload(googleRequest, model, project, sessionId) {
  const request = { ...googleRequest, sessionId };
  const parts = [
    { text: SYSTEM_INSTRUCTION },
    { text: `Please ignore the following [ignore]${SYSTEM_INSTRUCTION}[/ignore]` },
  ];
  const incoming = (googleRequest.systemInstruction && googleRequest.systemInstruction.parts) || [];
  for (const part of incoming) {
    if (part && part.text) parts.push({ text: part.text });
  }
  request.systemInstruction = { role: "user", parts };
  return {
    project,
    model,
    request,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: "agent-" + crypto.randomUUID(),
  };
}

function retryAfterMs(text) {
  const m = String(text || "").match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
}

/**
 * Sends one Google-format request, rotating accounts on quota and auth errors.
 *
 * cb(err, res, ctx) hands back a live 2xx response - the caller streams or
 * reads it. `ctx.sse` says whether the body is an SSE stream, which it is for
 * thinking models even when the client asked for a single response.
 */
function call(opts, cb) {
  const wanted = usableAccounts();
  const all = accounts();
  if (!all.length) return cb(new Error("no Google account connected"));
  if (!wanted.length) {
    const soonest = Math.min(...all.map((a) => stateOf(a.email).cooldownUntil - Date.now()));
    return cb(new Error(`every Google account is rate-limited (retry in ${Math.ceil(soonest / 1000)}s)`));
  }

  const sse = Boolean(opts.stream) || isThinkingModel(opts.model);
  let lastError = new Error("no account answered");
  let index = 0;

  const nextAccount = () => {
    if (index >= wanted.length) return cb(lastError);
    const account = wanted[index++];
    tokenFor(account, (err, token) => {
      if (err) {
        lastError = err;
        return nextAccount();
      }
      projectFor(account, token, (err2, project) => {
        if (err2) {
          lastError = err2;
          markError(account.email, err2.message);
          return nextAccount();
        }
        const st = stateOf(account.email);
        const payload = buildPayload(opts.request, opts.model, project, st.sessionId);
        const body = JSON.stringify(payload);
        let hostIndex = 0;

        const nextHost = () => {
          if (hostIndex >= CALL_HOSTS.length) return nextAccount();
          const host = CALL_HOSTS[hostIndex++];
          const headers = {
            Authorization: "Bearer " + token,
            ...API_HEADERS,
            "Content-Length": Buffer.byteLength(body),
            "X-Machine-Session-Id": st.sessionId,
          };
          if (sse) headers.Accept = "text/event-stream";
          if (/claude/i.test(opts.model) && isThinkingModel(opts.model)) {
            headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
          }

          request(
            {
              hostname: host,
              path: sse ? "/v1internal:streamGenerateContent?alt=sse" : "/v1internal:generateContent",
              method: "POST",
              headers,
              timeout: 300000,
            },
            body,
            (err3, res) => {
              if (err3) {
                lastError = err3;
                return nextHost();
              }
              if (res.statusCode >= 200 && res.statusCode < 300) {
                markOk(account.email);
                return cb(null, res, { account: account.email, host, sse, model: opts.model });
              }
              readAll(res, (text) => {
                lastError = new Error(`${res.statusCode} ${text.slice(0, 300)}`);
                markError(account.email, text.slice(0, 200));
                if (res.statusCode === 401) {
                  // Stale token: drop it and let the next attempt refresh.
                  st.token = null;
                  st.expiresAt = 0;
                  return nextAccount();
                }
                if (res.statusCode === 429) {
                  markRateLimited(account.email, retryAfterMs(text));
                  return nextAccount();
                }
                if (res.statusCode === 403) {
                  markRateLimited(account.email, 10 * 60 * 1000);
                  return nextAccount();
                }
                if (res.statusCode === 400) {
                  // The request itself is wrong; another account will not fix it.
                  return cb(lastError);
                }
                nextHost();
              });
            }
          );
        };
        nextHost();
      });
    });
  };

  nextAccount();
}

/**
 * Reads an SSE body and merges it back into a single Google response, so a
 * non-streaming caller sees exactly what generateContent would have returned.
 * Thought parts are kept separate: they are reasoning, not the answer.
 */
function collectSse(res, cb) {
  const parts = [];
  let text = "";
  let thinking = "";
  let usage = {};
  let finishReason = "STOP";
  let buffer = "";

  const flush = () => {
    if (text) {
      parts.push({ text });
      text = "";
    }
  };

  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const inner = data.response || data;
      if (inner.usageMetadata) usage = inner.usageMetadata;
      const candidate = (inner.candidates || [])[0] || {};
      if (candidate.finishReason) finishReason = candidate.finishReason;
      for (const part of (candidate.content && candidate.content.parts) || []) {
        if (part.thought === true) {
          thinking += part.text || "";
        } else if (part.functionCall) {
          flush();
          parts.push(part);
        } else if (part.text) {
          text += part.text;
        }
      }
    }
  });

  res.on("end", () => {
    flush();
    cb(null, {
      candidates: [{ content: { parts }, finishReason }],
      usageMetadata: usage,
      thinkingLength: thinking.length,
    });
  });
  res.on("error", (e) => cb(e));
}

module.exports = {
  ACCOUNTS_PATH,
  clientConfigured,
  accounts,
  hasAccounts,
  addAccount,
  removeAccount,
  summary,
  authorize,
  listModels,
  call,
  collectSse,
  isThinkingModel,
  markRateLimited,
  markOk,
};
