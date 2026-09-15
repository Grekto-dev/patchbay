#!/usr/bin/env node
"use strict";

// ─────────────────────────────────────────────────────────
//  Patchbay — control panel for the local model gateway
//  Local-only web UI: start/stop the proxy, manage API keys,
//  pin the text provider, edit model maps, watch live traffic,
//  and run the certificate / Claude Desktop diagnostics.
//
//  Zero dependencies. Binds to 127.0.0.1 only.
//    node ui/server.js   →   http://127.0.0.1:8878
// ─────────────────────────────────────────────────────────

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// The install being managed. Defaults to the repo this file lives in; point
// PROXY_ROOT at another checkout to drive that one instead.
const ROOT = process.env.PROXY_ROOT ? path.resolve(process.env.PROXY_ROOT) : path.join(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const ENV_PATH = path.join(ROOT, ".env");
const CONFIG_PATH = path.join(ROOT, "proxy-config.json");
const PROXY_ENTRY = path.join(ROOT, "proxy", "server.js");
const TEST_ENTRY = path.join(ROOT, "proxy", "test-proxy.js");
const CERT_DIR = path.join(ROOT, "certs");
const IS_WIN = process.platform === "win32";

const UI_PORT = Number(process.env.UI_PORT) > 0 ? Number(process.env.UI_PORT) : 8878;
const MAX_LOG_LINES = 800;

// Gemini is both the image backend and a text provider, so it belongs in the
// same list as the others - it is simply last in the proxy's priority order.
const BUILTIN_PROVIDERS = [
  { key: "opencode", label: "OpenCode Go", env: "OPENCODE_API_KEY", url: "https://opencode.ai" },
  { key: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys" },
  { key: "glm", label: "GLM (Z.ai)", env: "GLM_API_KEY", url: "https://z.ai" },
  { key: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com" },
  {
    key: "gemini",
    label: "Google AI Studio",
    env: "GEMINI_API_KEY",
    url: "https://aistudio.google.com/apikey",
    note: "also the image / OCR backend, whichever provider handles text",
  },
];

// Custom OpenAI-compatible providers (Ollama, LM Studio, vLLM, a company
// gateway). Declared in proxy-config.json; their key, when one is needed,
// lives in .env like every other secret.
function envKeyNameFor(key) {
  return "PATCHBAY_" + String(key).toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}

function customProviderEntries() {
  const list = readConfig().customProviders;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === "object" && /^[a-z0-9][a-z0-9-]*$/.test(String(p.key || "")))
    .filter((p) => !BUILTIN_PROVIDERS.some((b) => b.key === p.key))
    .map((p) => ({
      key: String(p.key),
      label: String(p.label || p.key),
      env: envKeyNameFor(p.key),
      url: String(p.baseUrl || ""),
      baseUrl: String(p.baseUrl || ""),
      custom: true,
      note: "OpenAI-compatible endpoint \u00b7 " + String(p.baseUrl || ""),
    }));
}

function providers() {
  return [...BUILTIN_PROVIDERS, ...customProviderEntries()];
}

// Last-resort maps, used only if proxy/server.js cannot be parsed.
const FALLBACK_MAPS = {
  deepseek: {
    "claude-sonnet-4-5": "deepseek-v4-flash",
    "claude-sonnet-4-6": "deepseek-v4-flash",
    "claude-opus-4-7": "deepseek-v4-pro",
    "claude-haiku-4-5-20251001": "deepseek-v4-flash",
  },
  opencode: {
    "claude-sonnet-4-5": "deepseek-v4-flash",
    "claude-sonnet-4-6": "deepseek-v4-flash",
    "claude-opus-4-7": "deepseek-v4-flash",
    "claude-haiku-4-5-20251001": "deepseek-v4-flash",
  },
  glm: {
    "claude-sonnet-4-5": "glm-5-turbo",
    "claude-sonnet-4-6": "glm-5-turbo",
    "claude-opus-4-7": "glm-5.2",
    "claude-haiku-4-5-20251001": "glm-4.5-air",
  },
  gemini: {
    "claude-sonnet-4-5": "gemini-3.6-flash",
    "claude-sonnet-4-6": "gemini-3.6-flash",
    "claude-opus-4-7": "gemini-3.8-flash",
    "claude-haiku-4-5-20251001": "gemini-3.1-flash-lite",
  },
};

// ── Runtime state ────────────────────────────────────────

let child = null; // the proxy process, when the panel owns it
let childStartedAt = 0;
let logs = [];
let logSeq = 0;
const sseClients = new Set();
let stats = emptyStats();

function emptyStats() {
  return {
    since: Date.now(),
    requests: 0,
    probes: 0,
    images: 0,
    errors: 0,
    byEndpoint: {},
    byModel: {},
    statuses: {},
    lastError: null,
    lastRequestAt: null,
  };
}

// ── .env handling ────────────────────────────────────────

function isPlaceholder(v) {
  return !v || v.trim() === "" || /^your_.*_here$/i.test(v.trim());
}

function readEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  const text = fs.readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function writeEnvFile(updates) {
  const eol = IS_WIN ? "\r\n" : "\n";
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  } else if (fs.existsSync(path.join(ROOT, ".env.example"))) {
    // Seed from the template, but drop the placeholder values.
    lines = fs
      .readFileSync(path.join(ROOT, ".env.example"), "utf8")
      .replace(/^﻿/, "")
      .split(/\r?\n/)
      .map((l) => {
        const i = l.indexOf("=");
        if (l.trim().startsWith("#") || i < 0) return l;
        return l.slice(0, i + 1);
      });
  }

  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => !l.trim().startsWith("#") && l.split("=")[0].trim() === key);
    const newLine = key + "=" + value;
    if (idx >= 0) lines[idx] = newLine;
    else lines.push(newLine);
  }

  fs.writeFileSync(ENV_PATH, lines.join(eol).replace(/(\r?\n)+$/, eol));
}

function maskKey(v) {
  if (isPlaceholder(v)) return "";
  const s = v.trim();
  if (s.length <= 10) return "•".repeat(s.length);
  return s.slice(0, 5) + "•".repeat(Math.min(14, s.length - 9)) + s.slice(-4);
}

// ── proxy-config.json ────────────────────────────────────

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const clean = {};
  if (Number(cfg.port) > 0) clean.port = Number(cfg.port);
  if (typeof cfg.provider === "string" && providers().some((p) => p.key === cfg.provider)) {
    clean.provider = cfg.provider;
  }
  if (Array.isArray(cfg.customProviders) && cfg.customProviders.length) {
    clean.customProviders = cfg.customProviders;
  }
  for (const field of ["discovery", "catalogEnabled", "catalogIds"]) {
    const value = cfg[field];
    if (value && typeof value === "object" && Object.keys(value).length) clean[field] = value;
  }
  if (cfg.models && typeof cfg.models === "object") {
    const models = {};
    for (const [ep, map] of Object.entries(cfg.models)) {
      if (!map || typeof map !== "object") continue;
      const inner = {};
      for (const [k, v] of Object.entries(map)) {
        if (typeof v === "string" && v.trim()) inner[k] = v.trim();
      }
      if (Object.keys(inner).length) models[ep] = inner;
    }
    if (Object.keys(models).length) clean.models = models;
  }
  if (Object.keys(clean).length === 0) {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2) + "\n");
  }
  return clean;
}

function proxyPort() {
  const p = Number(readConfig().port);
  return p > 0 ? p : 8877;
}

// Read the built-in model maps straight out of proxy/server.js so the panel
// never drifts from the proxy defaults.
function defaultModelMaps() {
  let src;
  try {
    src = fs.readFileSync(PROXY_ENTRY, "utf8");
  } catch {
    return FALLBACK_MAPS;
  }
  const out = {};
  for (const { key } of BUILTIN_PROVIDERS) {
    const start = src.indexOf("\n  " + key + ": {");
    if (start < 0) {
      out[key] = FALLBACK_MAPS[key];
      continue;
    }
    const blockEnd = src.indexOf("\n  },", start);
    const block = src.slice(start, blockEnd < 0 ? start + 2000 : blockEnd);
    const mStart = block.indexOf("modelMap: {");
    if (mStart < 0) {
      out[key] = FALLBACK_MAPS[key];
      continue;
    }
    const body = block.slice(mStart + "modelMap: {".length, block.indexOf("}", mStart));
    const map = {};
    const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(body))) map[m[1]] = m[2];
    out[key] = Object.keys(map).length ? map : FALLBACK_MAPS[key];
  }
  return out;
}

// ── Live provider catalogs ──────────────────────────
// Same endpoints the proxy uses, so the panel can list what each provider is
// serving right now and let the user pick which models to expose.
// `merge: true` queries every source and combines them (one OpenCode key
// serves two surfaces with different models - the free ones only exist on the
// non-Go one); otherwise the sources are fallbacks and the first that answers
// wins. Kept in step with the same table in proxy/server.js.
const CATALOG_SOURCES = {
  opencode: {
    merge: true,
    sources: [
      { host: "opencode.ai", path: "/zen/go/v1/models", surface: "go" },
      // Only the free models from this surface: paid ones are the Go plan's job.
      { host: "opencode.ai", path: "/zen/v1/models", surface: "zen", freeOnly: true },
    ],
  },
  deepseek: { sources: [{ host: "api.deepseek.com", path: "/models" }] },
  // OpenRouter reports pricing and modalities itself, so its catalog needs no
  // help from models.dev.
  openrouter: { sources: [{ host: "openrouter.ai", path: "/api/v1/models", parse: "openrouter" }] },
  gemini: {
    sources: [
      {
        host: "generativelanguage.googleapis.com",
        path: "/v1beta/models?pageSize=200",
        auth: "query",
        parse: "google",
      },
    ],
  },
  // Coding Plan keys and general keys live on different bases; try both.
  glm: {
    sources: [
      { host: "api.z.ai", path: "/api/coding/paas/v4/models" },
      { host: "api.z.ai", path: "/api/paas/v4/models" },
    ],
  },
};

const catalogCache = {};
function catalogState(key) {
  if (!catalogCache[key]) catalogCache[key] = { models: [], surfaces: {}, fetchedAt: 0, error: null };
  return catalogCache[key];
}
for (const key of Object.keys(CATALOG_SOURCES)) catalogState(key);

// Built-in providers have a fixed source table; a custom one derives its
// /models endpoint from the base URL it was configured with.
function catalogSourcesFor(key) {
  if (CATALOG_SOURCES[key]) return CATALOG_SOURCES[key];
  const entry = customProviderEntries().find((p) => p.key === key);
  if (!entry) return null;
  let url;
  try {
    url = new URL(entry.baseUrl);
  } catch {
    return null;
  }
  const base = url.pathname.replace(/\/+$/, "");
  return {
    sources: [
      {
        host: url.hostname,
        scheme: url.protocol === "http:" ? "http" : "https",
        port: url.port ? Number(url.port) : undefined,
        path: base + "/models",
      },
    ],
  };
}

// The provider APIs return ids and nothing else - no pricing, no "this one is
// free" flag. models.dev is OpenCode's own model database (the one the opencode
// CLI reads) and does carry cost per model, so the panel enriches the live list
// with it and labels the source. A model is free when input and output both
// cost 0.
const PRICING_SOURCES = {
  opencode: ["opencode-go", "opencode"],
  deepseek: ["deepseek"],
  glm: ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"],
  gemini: ["google"],
};
const PRICING_TTL_MS = 12 * 60 * 60 * 1000;
const pricingCache = { byProvider: {}, fetchedAt: 0, error: null, pending: null };

function parsePricing(db) {
  const out = {};
  for (const [provider, sources] of Object.entries(PRICING_SOURCES)) {
    const models = {};
    // Earlier sources win, so the provider's own catalog beats a generic one.
    for (const source of [...sources].reverse()) {
      const entry = db[source];
      if (!entry || !entry.models) continue;
      for (const [id, m] of Object.entries(entry.models)) {
        const cost = m.cost || {};
        const input = Number(cost.input);
        const output = Number(cost.output);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        models[id] = { free: input === 0 && output === 0, input, output, source };
      }
    }
    out[provider] = models;
  }
  return out;
}

function fetchPricing(cb) {
  if (pricingCache.fetchedAt && Date.now() - pricingCache.fetchedAt < PRICING_TTL_MS) return cb(pricingCache);
  if (pricingCache.pending) return pricingCache.pending.push(cb);
  pricingCache.pending = [cb];

  const finish = () => {
    const waiting = pricingCache.pending || [];
    pricingCache.pending = null;
    for (const fn of waiting) fn(pricingCache);
  };

  const req = https.request(
    { hostname: "models.dev", port: 443, path: "/api.json", method: "GET", timeout: 25000, headers: { "User-Agent": "claude-desktop-proxy-panel" } },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          pricingCache.byProvider = parsePricing(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          pricingCache.fetchedAt = Date.now();
          pricingCache.error = null;
        } catch (e) {
          pricingCache.error = "models.dev: " + e.message;
        }
        finish();
      });
    }
  );
  req.on("error", (e) => {
    pricingCache.error = "models.dev: " + e.message;
    finish();
  });
  req.on("timeout", () => {
    req.destroy();
    pricingCache.error = "models.dev: timeout";
    finish();
  });
  req.end();
}

// Google lists image, music, speech and agent-only models next to the chat
// ones, all of them under generateContent, with no modality field to tell them
// apart - so they are excluded by name. Several are not even usable this way:
// antigravity-* and deep-research-* answer "This model only supports
// Interactions API", and lyria/nano-banana return audio or images.
const NON_TEXT_MODEL = /(^|[-.])(image|images|tts|transcribe|robotics|omni|embedding|imagen|veo|aqa)([-.]|$)|nano-banana|lyria|computer-use|antigravity|deep-research/i;

// Retired by Google but still advertised by the API, with no deprecation flag
// to go by: the whole 2.5 family answers 404 "no longer available to new users".
const DEPRECATED_MODEL = /^gemini-2\.5-/i;

function isTextModel(id) {
  const s = String(id);
  return !NON_TEXT_MODEL.test(s) && !DEPRECATED_MODEL.test(s);
}

function claudeIdFor(upstreamModel) {
  return "claude-" + String(upstreamModel).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Claude Desktop only accepts ids starting with "claude-", so the prefix is
// enforced here no matter what the panel sends.
function sanitizeClaudeId(raw) {
  const suffix = String(raw)
    .toLowerCase()
    .replace(/^claude-/, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return suffix ? "claude-" + suffix : "";
}

function envKeyFor(provider) {
  const field = providers().find((p) => p.key === provider);
  return field ? readEnvFile()[field.env] : null;
}

// With models.dev unavailable, the naming convention is the best guess left.
function isFreeModel(provider, model) {
  const costs = pricingCache.byProvider[provider];
  if (costs && costs[model]) return costs[model].free;
  if (costs && Object.keys(costs).length) return /-free$/.test(model);
  return /-free$/.test(model);
}

function fetchProviderList(provider, key, index, cb) {
  const spec = catalogSourcesFor(provider) || { sources: [] };
  const sources = spec.sources;
  const source = sources[index];
  if (!source) return cb(new Error("no endpoint answered"), null);

  const useQueryAuth = source.auth === "query" && Boolean(key);
  const reqPath = useQueryAuth
    ? source.path + (source.path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key)
    : source.path;
  const transport = source.scheme === "http" ? http : https;

  const req = transport.request(
    {
      hostname: source.host,
      port: source.port || (source.scheme === "http" ? 80 : 443),
      path: reqPath,
      method: "GET",
      timeout: 15000,
      headers: useQueryAuth || !key
        ? { "User-Agent": "patchbay-panel" }
        : { Authorization: "Bearer " + key, "x-api-key": key, "User-Agent": "patchbay-panel" },
    },
    (res) => {
      let d = "";
      let sourcePricing = null;
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let models = null;
        try {
          const json = JSON.parse(d);
          if (source.parse === "openrouter") {
            // Pricing comes in the same payload, in dollars per token.
            sourcePricing = {};
            for (const m of json.data || []) {
              const inCost = Number(m.pricing && m.pricing.prompt) * 1e6;
              const outCost = Number(m.pricing && m.pricing.completion) * 1e6;
              if (!Number.isFinite(inCost) || !Number.isFinite(outCost)) continue;
              sourcePricing[m.id] = {
                free: inCost === 0 && outCost === 0,
                input: Number(inCost.toFixed(4)),
                output: Number(outCost.toFixed(4)),
                source: "openrouter",
              };
            }
          }
          models =
            source.parse === "openrouter"
              ? // Text-output models only; the rest also emit images or audio.
                (json.data || [])
                  .filter((m) => {
                    // Audio output means speech or music; image listed first
                    // means an image generator. Image as a secondary output is
                    // fine - that is what the openrouter/auto routers report.
                    const out = (m.architecture && m.architecture.output_modalities) || ["text"];
                    return out.includes("text") && !out.includes("audio") && out.indexOf("image") !== 0;
                  })
                  .map((m) => m.id)
                  .filter(Boolean)
              : source.parse === "google"
              ? // Google answers { models: [{ name: "models/x", supportedGenerationMethods }] }
                (json.models || [])
                  .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
                  .map((m) => String(m.name || "").replace(/^models\//, ""))
                  .filter((id) => id && isTextModel(id))
              : (json.data || []).map((m) => m.id).filter(Boolean);
        } catch {
          models = null;
        }
        if (models && models.length) {
          if (source.freeOnly) models = models.filter((m) => isFreeModel(provider, m));
          const surfaces = {};
          for (const m of models) surfaces[m] = source.surface || null;
          if (sourcePricing) surfaces.__pricing = sourcePricing;
          if (spec.merge && index + 1 < sources.length) {
            return fetchProviderList(provider, key, index + 1, (err2, more, moreSurfaces) => {
              if (err2 || !more || !more.length) return cb(null, models, surfaces);
              const seen = new Set(models);
              const all = [...models];
              for (const m of more) {
                if (seen.has(m)) continue;
                seen.add(m);
                all.push(m);
                surfaces[m] = (moreSurfaces && moreSurfaces[m]) || null;
              }
              cb(null, all, surfaces);
            });
          }
          return cb(null, models, surfaces);
        }
        // A free-only source can legitimately come back empty after filtering.
        if (source.freeOnly && models) return cb(null, [], {});
        if (index + 1 < sources.length) return fetchProviderList(provider, key, index + 1, cb);
        cb(new Error("HTTP " + res.statusCode + ": " + d.slice(0, 120)), null);
      });
    }
  );
  req.on("error", (e) => {
    if (index + 1 < sources.length) return fetchProviderList(provider, key, index + 1, cb);
    cb(e, null);
  });
  req.on("timeout", () => {
    req.destroy();
    if (index + 1 < sources.length) return fetchProviderList(provider, key, index + 1, cb);
    cb(new Error("timeout"), null);
  });
  req.end();
}

function fetchCatalog(provider, cb) {
  const state = catalogState(provider);
  const key = envKeyFor(provider);
  const entry = providers().find((p) => p.key === provider);
  const keyless = Boolean(entry && entry.custom);
  if (isPlaceholder(key) && !keyless) {
    state.error = "no API key configured";
    state.models = [];
    return cb(state);
  }
  fetchProviderList(provider, isPlaceholder(key) ? "" : key.trim(), 0, (err, models, surfaces) => {
    if (err) {
      state.error = err.message;
    } else {
      const meta = surfaces || {};
      state.pricing = meta.__pricing || null;
      delete meta.__pricing;
      state.models = models;
      state.surfaces = meta;
      state.fetchedAt = Date.now();
      state.error = null;
    }
    cb(state);
  });
}

// Every provider that has a key, refreshed in parallel.
function fetchAllCatalogs(force, cb) {
  // isFreeModel() reads pricingCache, so make sure it is warm first.
  if (!pricingCache.fetchedAt) return fetchPricing(() => fetchAllCatalogsNow(force, cb));
  return fetchAllCatalogsNow(force, cb);
}

function fetchAllCatalogsNow(force, cb) {
  const list = providers()
    .map((p) => p.key)
    .filter((key) => catalogSourcesFor(key));
  let pending = list.length;
  if (!pending) return cb();
  for (const provider of list) {
    const state = catalogState(provider);
    const entry = providers().find((p) => p.key === provider);
    const hasKey = Boolean(entry && entry.custom) || !isPlaceholder(envKeyFor(provider));
    const stale = Date.now() - state.fetchedAt > 5 * 60 * 1000;
    const shouldFetch = hasKey && (force || (!state.models.length && stale) || stale);
    if (!shouldFetch) {
      if (!hasKey) {
        state.models = [];
        state.error = "no API key configured";
      }
      if (--pending === 0) cb();
      continue;
    }
    fetchCatalog(provider, () => {
      if (--pending === 0) cb();
    });
  }
}

// ── Logging / stats ──────────────────────────────────────

// "← 200 (1234 bytes)" / "← ERR 401 (63 bytes)" — the upstream status code,
// ignoring the byte count that follows it.
const STATUS_RE = /←[^\n]*?\b([1-5]\d{2})\b/;

function classify(text) {
  const st = text.match(STATUS_RE);
  if (st) return Number(st[1]) >= 400 ? "error" : "info";
  if (/\bERR\b|error|falhou|failed|ECONN|refused/i.test(text)) return "error";
  if (/\[IMAGE\]/.test(text)) return "image";
  if (/PROBE/.test(text)) return "probe";
  if (/incoming:/.test(text)) return "request";
  return "info";
}

function pushLog(text, level) {
  const entry = { id: ++logSeq, t: Date.now(), text, level: level || classify(text) };
  logs.push(entry);
  if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
  updateStats(text);
  broadcast("log", entry);
  return entry;
}

function updateStats(text) {
  let touched = false;
  const inc = text.match(/incoming: model=(\S+?), max_tokens=(\S+?), stream=(\w+), endpoint=(\w+)/);
  if (inc) {
    stats.requests++;
    stats.lastRequestAt = Date.now();
    stats.byModel[inc[1]] = (stats.byModel[inc[1]] || 0) + 1;
    stats.byEndpoint[inc[4]] = (stats.byEndpoint[inc[4]] || 0) + 1;
    touched = true;
  }
  if (/← PROBE response/.test(text)) {
    stats.probes++;
    touched = true;
  }
  if (/\[IMAGE\] image detected/.test(text)) {
    stats.images++;
    touched = true;
  }
  const st = text.match(STATUS_RE);
  if (st) {
    stats.statuses[st[1]] = (stats.statuses[st[1]] || 0) + 1;
    if (Number(st[1]) >= 400) {
      stats.errors++;
      stats.lastError = { t: Date.now(), text };
    }
    touched = true;
  }
  if (/upstream error|gemini error|^Error:|Uncaught/i.test(text)) {
    stats.errors++;
    stats.lastError = { t: Date.now(), text };
    touched = true;
  }
  if (touched) broadcast("stats", stats);
}

function broadcast(event, data) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      /* client already gone */
    }
  }
}

// ── Proxy process control ────────────────────────────────

function startProxy(cb) {
  if (child) return cb({ ok: false, error: "The proxy is already running (started by this panel)." });
  if (!fs.existsSync(path.join(CERT_DIR, "server-cert.pem"))) {
    return cb({ ok: false, error: "TLS certificates are missing — generate them on the Diagnostics tab first." });
  }
  probeProxy((alive) => {
    if (alive) {
      return cb({ ok: false, error: "Something is already listening on port " + proxyPort() + ". Stop that process first." });
    }

    stats = emptyStats();
    logs = [];
    broadcast("clear", {});

    const proc = spawn(process.execPath, [PROXY_ENTRY], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
      windowsHide: true,
    });
    child = proc;
    childStartedAt = Date.now();

    const wire = (stream, level) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buf += chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const line of parts) if (line.trim()) pushLog(line, level);
      });
    };
    wire(proc.stdout, null);
    wire(proc.stderr, "error");

    proc.on("exit", (code, signal) => {
      pushLog("[panel] proxy exited (code=" + code + (signal ? ", signal=" + signal : "") + ")", code ? "error" : "info");
      if (child === proc) child = null;
      broadcast("state", { proxyRunning: false });
    });
    proc.on("error", (err) => {
      pushLog("[panel] failed to start: " + err.message, "error");
      if (child === proc) child = null;
    });

    pushLog("[panel] starting proxy (pid " + proc.pid + ") on port " + proxyPort(), "info");
    setTimeout(() => cb({ ok: true, pid: proc.pid }), 700);
  });
}

function findPidsOnPort(port, cb) {
  const cmd = IS_WIN ? "netstat" : "lsof";
  const args = IS_WIN ? ["-ano", "-p", "TCP"] : ["-ti", "tcp:" + port, "-sTCP:LISTEN"];
  let out = "";
  let proc;
  try {
    proc = spawn(cmd, args, { windowsHide: true });
  } catch {
    return cb([]);
  }
  proc.stdout.on("data", (c) => (out += c));
  proc.on("error", () => cb([]));
  proc.on("close", () => {
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (IS_WIN) {
        if (!/LISTENING/.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        if (!(cols[1] || "").endsWith(":" + port)) continue;
        const pid = Number(cols[cols.length - 1]);
        if (pid > 0) pids.add(pid);
      } else {
        const pid = Number(line.trim());
        if (pid > 0) pids.add(pid);
      }
    }
    cb([...pids]);
  });
}

function stopProxy(cb) {
  if (child) {
    const proc = child;
    pushLog("[panel] stopping proxy (pid " + proc.pid + ")", "info");
    if (IS_WIN) spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    else proc.kill("SIGTERM");
    setTimeout(() => {
      if (child === proc) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        child = null;
      }
      cb({ ok: true });
    }, 800);
    return;
  }

  const port = proxyPort();
  findPidsOnPort(port, (pids) => {
    if (!pids.length) return cb({ ok: false, error: "No process is listening on port " + port + "." });
    for (const pid of pids) {
      if (IS_WIN) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
    pushLog("[panel] external process on port " + port + " killed (pid " + pids.join(", ") + ")", "info");
    setTimeout(() => cb({ ok: true, killed: pids }), 900);
  });
}

function probeProxy(cb) {
  const req = https.request(
    { host: "127.0.0.1", port: proxyPort(), path: "/", method: "GET", rejectUnauthorized: false, timeout: 1500 },
    (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          cb(JSON.parse(d));
        } catch {
          cb({ status: "ok" });
        }
      });
    }
  );
  req.on("error", () => cb(null));
  req.on("timeout", () => {
    req.destroy();
    cb(null);
  });
  req.end();
}

// ── Diagnostics ──────────────────────────────────────────

function certInfo() {
  const files = ["ca-cert.pem", "ca-key.pem", "server-cert.pem", "server-key.pem"];
  const present = {};
  for (const f of files) present[f] = fs.existsSync(path.join(CERT_DIR, f));
  let expires = null;
  let subject = null;
  let daysLeft = null;
  if (present["server-cert.pem"]) {
    try {
      const { X509Certificate } = require("crypto");
      const cert = new X509Certificate(fs.readFileSync(path.join(CERT_DIR, "server-cert.pem")));
      expires = cert.validTo;
      subject = cert.subject;
      daysLeft = Math.round((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
    } catch {
      /* unreadable cert */
    }
  }
  return { present, ok: files.every((f) => present[f]), expires, subject, daysLeft };
}

function desktopConfigPaths() {
  const home = os.homedir();
  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(appData, "Claude", "developer_settings.json"),
      path.join(localAppData, "Claude-3p", "developer_settings.json"),
    ];
  }
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [
      path.join(base, "Claude", "developer_settings.json"),
      path.join(base, "Claude-3p", "developer_settings.json"),
    ];
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    path.join(base, "Claude", "developer_settings.json"),
    path.join(base, "Claude-3p", "developer_settings.json"),
  ];
}

function desktopInfo() {
  const wanted = "https://localhost:" + proxyPort();
  return desktopConfigPaths().map((p) => {
    const entry = { path: p, exists: fs.existsSync(p), gateway: null, devTools: null, matches: false };
    if (entry.exists) {
      try {
        const json = JSON.parse(fs.readFileSync(p, "utf8"));
        entry.gateway = (json && json.gateway && json.gateway.url) || null;
        entry.devTools = json ? json.allowDevTools === true : null;
        entry.matches = entry.gateway === wanted;
      } catch {
        entry.error = "invalid JSON";
      }
    }
    return entry;
  });
}

// Claude Desktop keeps the third-party model list in its own config library,
// separate from developer_settings.json. Reading it lets the panel reuse the
// gateway key and keep the labels/tiers the user already set.
function desktopLibraryInfo() {
  const home = os.homedir();
  const base = IS_WIN
    ? path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Claude-3p", "configLibrary")
    : process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude-3p", "configLibrary")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude-3p", "configLibrary");

  const info = { dir: base, file: null, apiKey: null, baseUrl: null, discovery: null, models: {} };
  let files;
  try {
    files = fs.readdirSync(base).filter((f) => f.endsWith(".json") && f !== "_meta.json");
  } catch {
    return info;
  }
  for (const f of files) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
      if (!json || json.inferenceProvider !== "gateway") continue;
      info.file = path.join(base, f);
      info.apiKey = json.inferenceGatewayApiKey || null;
      info.baseUrl = json.inferenceGatewayBaseUrl || null;
      info.discovery = json.modelDiscoveryEnabled === true || json.modelDiscoveryEnabled === "true";
      const list = typeof json.inferenceModels === "string" ? JSON.parse(json.inferenceModels) : json.inferenceModels;
      for (const m of Array.isArray(list) ? list : []) {
        if (m && m.name) info.models[m.name] = m;
      }
      break;
    } catch {
      /* skip unreadable entry */
    }
  }
  return info;
}

function writeDesktopConfig() {
  const wanted = "https://localhost:" + proxyPort();
  const written = [];
  for (const p of desktopConfigPaths()) {
    let json = {};
    if (fs.existsSync(p)) {
      try {
        json = JSON.parse(fs.readFileSync(p, "utf8")) || {};
      } catch {
        json = {};
      }
      fs.copyFileSync(p, p + ".bak");
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    }
    json.allowDevTools = true;
    json.gateway = { ...(json.gateway || {}), url: wanted };
    fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
    written.push(p);
  }
  return written;
}

function runScript(kind, cb) {
  let cmd;
  let args;
  if (kind === "certs") {
    if (IS_WIN) {
      cmd = "powershell";
      args = ["-ExecutionPolicy", "Bypass", "-File", path.join(CERT_DIR, "generate-certs.ps1")];
    } else {
      cmd = "bash";
      args = [path.join(CERT_DIR, "generate-certs.sh")];
    }
  } else if (kind === "install-ca") {
    if (IS_WIN) {
      cmd = "powershell";
      args = ["-ExecutionPolicy", "Bypass", "-File", path.join(CERT_DIR, "install-ca.ps1")];
    } else {
      cmd = "bash";
      args = [path.join(CERT_DIR, "install-ca.sh")];
    }
  } else if (kind === "test") {
    cmd = process.execPath;
    args = [TEST_ENTRY];
  } else {
    return cb({ ok: false, error: "unknown script" });
  }

  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PROXY_PORT: String(proxyPort()) },
    });
  } catch (e) {
    return cb({ ok: false, error: e.message });
  }
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  proc.stderr.on("data", (c) => (out += c));
  proc.on("error", (e) => cb({ ok: false, error: e.message, output: out }));
  proc.on("close", (code) => cb({ ok: code === 0, code, output: out.trim() || "(no output)" }));
}

// ── State snapshot ───────────────────────────────────────

function buildState(cb) {
  const env = readEnvFile();
  const cfg = readConfig();
  const defaults = defaultModelMaps();
  const all = providers();

  const keys = all.map((f) => ({
    key: f.key,
    env: f.env,
    label: f.label,
    url: f.url,
    note: f.note || null,
    custom: Boolean(f.custom),
    baseUrl: f.baseUrl || null,
    set: !isPlaceholder(env[f.env]),
    masked: maskKey(env[f.env] || ""),
  }));

  // A local endpoint needs no key, so having one is not what makes it usable.
  const configured = all.filter((p) => p.custom || !isPlaceholder(env[p.env])).map((p) => p.key);
  const active = cfg.provider && configured.includes(cfg.provider) ? cfg.provider : configured[0] || null;

  const models = {};
  for (const p of BUILTIN_PROVIDERS) {
    models[p.key] = {};
    for (const [cModel, uModel] of Object.entries(defaults[p.key] || {})) {
      const override = cfg.models && cfg.models[p.key] && cfg.models[p.key][cModel];
      models[p.key][cModel] = {
        default: uModel,
        current: override || uModel,
        overridden: Boolean(override) && override !== uModel,
      };
    }
  }

  probeProxy((alive) => {
    cb({
      ui: { port: UI_PORT, root: ROOT, platform: process.platform, node: process.version },
      proxy: {
        running: Boolean(alive),
        managed: Boolean(child),
        pid: child ? child.pid : null,
        uptimeMs: child ? Date.now() - childStartedAt : null,
        port: proxyPort(),
        upstream: alive || null,
      },
      providers: all,
      keys,
      envExists: fs.existsSync(ENV_PATH),
      pinnedProvider: cfg.provider || null,
      activeProvider: active,
      configuredProviders: configured,
      models,
      config: cfg,
      certs: certInfo(),
      desktop: desktopInfo(),
      stats,
    });
  });
}

// ── HTTP plumbing ────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    if (!body) return cb({});
    try {
      cb(JSON.parse(body));
    } catch {
      cb(null);
    }
  });
}

// Mutating calls must carry a custom header. A page on another origin cannot
// set one without a preflight, and no CORS headers are sent, so only the panel
// itself can drive this API.
function trusted(req) {
  const host = (req.headers.host || "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  if (req.method === "GET") return true;
  return req.headers["x-panel"] === "1";
}

function serveStatic(req, res) {
  const url = req.url.split("?")[0];
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("404");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (!trusted(req)) return sendJSON(res, 403, { error: "forbidden" });

  if (url === "/api/logs/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("event: backlog\ndata: " + JSON.stringify(logs) + "\n\n");
    res.write("event: stats\ndata: " + JSON.stringify(stats) + "\n\n");
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* gone */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (url === "/api/state") return buildState((s) => sendJSON(res, 200, s));

  if (url === "/api/catalog") {
    const cfg = readConfig();
    const force = req.method === "POST";
    return fetchPricing((pricing) =>
      fetchAllCatalogs(force, () => {
      const discovery = cfg.discovery && typeof cfg.discovery === "object" ? cfg.discovery : {};
      const enabled = cfg.catalogEnabled && typeof cfg.catalogEnabled === "object" ? cfg.catalogEnabled : {};
      const ids = cfg.catalogIds && typeof cfg.catalogIds === "object" ? cfg.catalogIds : {};
      const env = readEnvFile();

      const cards = providers()
        .filter((p) => catalogSourcesFor(p.key))
        .map((p) => {
        const state = catalogState(p.key);
        const overrides = ids[p.key] && typeof ids[p.key] === "object" ? ids[p.key] : {};
        // A provider that reports its own pricing beats the models.dev copy.
        const costs = { ...(pricing.byProvider[p.key] || {}), ...(state.pricing || {}) };
        return {
          key: p.key,
          label: p.label,
          env: p.env,
          custom: Boolean(p.custom),
          baseUrl: p.baseUrl || null,
          hasKey: p.custom ? true : !isPlaceholder(env[p.env]),
          discovery: discovery[p.key] === true,
          models: state.models,
          enabled: Array.isArray(enabled[p.key]) ? enabled[p.key] : null,
          ids: Object.fromEntries(state.models.map((m) => [m, overrides[m] || claudeIdFor(m)])),
          // Only for models models.dev knows about; absent means "no data".
          pricing: Object.fromEntries(state.models.filter((m) => costs[m]).map((m) => [m, costs[m]])),
          surfaces: state.surfaces || {},
          fetchedAt: state.fetchedAt || null,
          error: state.error,
        };
      });

      sendJSON(res, 200, {
        providers: cards,
        port: proxyPort(),
        desktop: desktopLibraryInfo(),
        pricing: { source: "models.dev", fetchedAt: pricing.fetchedAt || null, error: pricing.error },
      });
      })
    );
  }

  if (url === "/api/catalog/save" && req.method === "POST") {
    return readBody(req, (body) => {
      if (!body || !catalogSourcesFor(body.provider)) return sendJSON(res, 400, { error: "unknown provider" });
      const provider = body.provider;
      const cfg = readConfig();

      if ("discovery" in body) {
        cfg.discovery = { ...(cfg.discovery || {}) };
        if (body.discovery === true) cfg.discovery[provider] = true;
        else delete cfg.discovery[provider];
      }

      if ("enabled" in body) {
        cfg.catalogEnabled = { ...(cfg.catalogEnabled || {}) };
        // null means "every model in this catalog"
        if (Array.isArray(body.enabled)) cfg.catalogEnabled[provider] = body.enabled.filter((m) => typeof m === "string");
        else delete cfg.catalogEnabled[provider];
      }

      if ("ids" in body) {
        const ids = {};
        for (const [model, rawId] of Object.entries(body.ids || {})) {
          if (typeof model !== "string" || typeof rawId !== "string") continue;
          const id = sanitizeClaudeId(rawId);
          if (!id || id === claudeIdFor(model)) continue; // same as generated → no override
          ids[model] = id;
        }
        cfg.catalogIds = { ...(cfg.catalogIds || {}) };
        if (Object.keys(ids).length) cfg.catalogIds[provider] = ids;
        else delete cfg.catalogIds[provider];
      }

      try {
        const saved = writeConfig(cfg);
        pushLog("[panel] " + provider + " catalog settings written to proxy-config.json", "info");
        return sendJSON(res, 200, { ok: true, config: saved, needsRestart: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
  }

  if (url === "/api/logs") return sendJSON(res, 200, { logs, stats });

  if (url === "/api/logs/clear" && req.method === "POST") {
    logs = [];
    stats = emptyStats();
    broadcast("clear", {});
    return sendJSON(res, 200, { ok: true });
  }

  if (url === "/api/proxy/start" && req.method === "POST") {
    return startProxy((r) => sendJSON(res, r.ok ? 200 : 409, r));
  }

  if (url === "/api/proxy/stop" && req.method === "POST") {
    return stopProxy((r) => sendJSON(res, r.ok ? 200 : 409, r));
  }

  if (url === "/api/proxy/restart" && req.method === "POST") {
    return stopProxy(() => setTimeout(() => startProxy((r) => sendJSON(res, r.ok ? 200 : 409, r)), 500));
  }

  if (url === "/api/keys" && req.method === "POST") {
    return readBody(req, (body) => {
      if (!body) return sendJSON(res, 400, { error: "invalid JSON" });
      const updates = {};
      for (const f of providers()) {
        const v = body[f.env];
        if (typeof v !== "string") continue; // field untouched
        if (v === "") continue; // empty input keeps the current key
        if (v === "__CLEAR__") {
          updates[f.env] = "";
          continue;
        }
        updates[f.env] = v.trim();
      }
      if (!Object.keys(updates).length) return sendJSON(res, 200, { ok: true, changed: [] });
      try {
        writeEnvFile(updates);
        pushLog("[panel] .env updated: " + Object.keys(updates).join(", "), "info");
        return sendJSON(res, 200, { ok: true, changed: Object.keys(updates), needsRestart: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
  }

  if (url === "/api/config" && req.method === "POST") {
    return readBody(req, (body) => {
      if (!body) return sendJSON(res, 400, { error: "invalid JSON" });
      const cfg = readConfig();

      if ("provider" in body) {
        if (!body.provider || body.provider === "auto") delete cfg.provider;
        else if (providers().some((p) => p.key === body.provider)) cfg.provider = body.provider;
        else return sendJSON(res, 400, { error: "unknown provider" });
      }

      if ("port" in body) {
        const p = Number(body.port);
        if (!(p > 0 && p < 65536)) return sendJSON(res, 400, { error: "invalid port" });
        if (p === 8877) delete cfg.port;
        else cfg.port = p;
      }

      if ("models" in body && body.models && typeof body.models === "object") {
        const defaults = defaultModelMaps();
        const models = {};
        for (const [ep, map] of Object.entries(body.models)) {
          if (!defaults[ep] || !map || typeof map !== "object") continue;
          for (const [cModel, uModel] of Object.entries(map)) {
            if (typeof uModel !== "string") continue;
            const val = uModel.trim();
            if (!val || val === defaults[ep][cModel]) continue; // same as default → no override
            models[ep] = models[ep] || {};
            models[ep][cModel] = val;
          }
        }
        if (Object.keys(models).length) cfg.models = models;
        else delete cfg.models;
      }

      try {
        const saved = writeConfig(cfg);
        return sendJSON(res, 200, { ok: true, config: saved, needsRestart: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
  }

  // ── Custom OpenAI-compatible providers ──
  if (url === "/api/providers" && req.method === "POST") {
    return readBody(req, (body) => {
      if (!body) return sendJSON(res, 400, { error: "invalid JSON" });

      const key = String(body.key || "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
        return sendJSON(res, 400, { error: "the id must be lowercase letters, digits or dashes" });
      }
      if (BUILTIN_PROVIDERS.some((p) => p.key === key)) {
        return sendJSON(res, 400, { error: "that id belongs to a built-in provider" });
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(String(body.baseUrl || "").trim());
      } catch {
        return sendJSON(res, 400, { error: "invalid base URL" });
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return sendJSON(res, 400, { error: "the base URL must be http or https" });
      }

      const entry = {
        key,
        label: String(body.label || key).trim().slice(0, 60),
        // Stored without a trailing slash: /chat/completions and /models hang off it.
        baseUrl: parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, ""),
      };

      const cfg = readConfig();
      const list = Array.isArray(cfg.customProviders) ? [...cfg.customProviders] : [];
      const at = list.findIndex((p) => p && p.key === key);
      if (at >= 0) list[at] = { ...list[at], ...entry };
      else list.push(entry);
      cfg.customProviders = list;

      try {
        if (typeof body.apiKey === "string" && body.apiKey.trim() && body.apiKey !== "__CLEAR__") {
          writeEnvFile({ [envKeyNameFor(key)]: body.apiKey.trim() });
        } else if (body.apiKey === "__CLEAR__") {
          writeEnvFile({ [envKeyNameFor(key)]: "" });
        }
        const saved = writeConfig(cfg);
        delete catalogCache[key]; // force a fresh fetch with the new base URL
        pushLog("[panel] custom provider saved: " + key + " (" + entry.baseUrl + ")", "info");
        return sendJSON(res, 200, { ok: true, config: saved, needsRestart: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
  }

  if (url === "/api/providers/delete" && req.method === "POST") {
    return readBody(req, (body) => {
      if (!body || !body.key) return sendJSON(res, 400, { error: "missing provider id" });
      const key = String(body.key);
      const cfg = readConfig();
      const list = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
      const next = list.filter((p) => p && p.key !== key);
      if (next.length === list.length) return sendJSON(res, 404, { error: "unknown custom provider" });

      cfg.customProviders = next;
      // Anything pinned to or configured for it would dangle otherwise.
      if (cfg.provider === key) delete cfg.provider;
      for (const field of ["discovery", "catalogEnabled", "catalogIds"]) {
        if (cfg[field] && typeof cfg[field] === "object") delete cfg[field][key];
      }

      try {
        writeEnvFile({ [envKeyNameFor(key)]: "" });
        const saved = writeConfig(cfg);
        delete catalogCache[key];
        pushLog("[panel] custom provider removed: " + key, "info");
        return sendJSON(res, 200, { ok: true, config: saved, needsRestart: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
  }

  if (url === "/api/run" && req.method === "POST") {
    return readBody(req, (body) => {
      if (!body || !body.script) return sendJSON(res, 400, { error: "missing script" });
      runScript(body.script, (r) => {
        pushLog("[panel] " + body.script + ": " + (r.ok ? "ok" : "failed"), r.ok ? "info" : "error");
        sendJSON(res, 200, r);
      });
    });
  }

  if (url === "/api/desktop/write" && req.method === "POST") {
    try {
      const written = writeDesktopConfig();
      pushLog("[panel] developer_settings.json updated (" + written.length + " file(s))", "info");
      return sendJSON(res, 200, { ok: true, written });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (url.startsWith("/api/")) return sendJSON(res, 404, { error: "not found" });

  return serveStatic(req, res);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("\n  Port " + UI_PORT + " is already in use. The panel is probably open already.");
    console.error("  Use UI_PORT=8879 node ui/server.js to bring it up elsewhere.\n");
    process.exit(1);
  }
  throw err;
});

server.listen(UI_PORT, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + UI_PORT;
  console.log("");
  console.log("  Patchbay — control panel");
  console.log("  Open:        " + url);
  console.log("  Proxy target: https://127.0.0.1:" + proxyPort());
  console.log("");
  if (process.env.NO_OPEN !== "1") {
    try {
      const opener = IS_WIN
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
      spawn(opener[0], opener[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {
      /* no browser available */
    }
  }
});

function shutdown() {
  if (child) {
    try {
      if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
