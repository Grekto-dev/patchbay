const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// Load .env if present
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && k.trim() && !k.trim().startsWith("#")) {
      process.env[k.trim()] = v.join("=").trim();
    }
  });
}

const DIR = path.join(__dirname, "..");

// ── Optional overrides written by the control panel (ui/) ─
// proxy-config.json is optional; when absent everything below
// falls back to the built-in defaults.
function loadOverrides() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "proxy-config.json"), "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}
const OVERRIDES = loadOverrides();

// ── Proxy Port ───────────────────────────────────────────
const PROXY_PORT = Number(OVERRIDES.port) > 0 ? Number(OVERRIDES.port) : 8877;

// ── Endpoint Config ──────────────────────────────────────
const ENDPOINTS = {
  deepseek: {
    label: "DeepSeek",
    host: "api.deepseek.com",
    basePath: "/anthropic",
    apiKey: process.env.DEEPSEEK_API_KEY || null,
    modelMap: {
      "claude-sonnet-4-5": "deepseek-v4-flash",
      "claude-sonnet-4-6": "deepseek-v4-flash",
      "claude-opus-4-7": "deepseek-v4-pro",
      "claude-haiku-4-5-20251001": "deepseek-v4-flash",
    },
    defaultModel: "deepseek-v4-flash",
    type: "anthropic",
  },
  gemini: {
    label: "Google AI Studio",
    host: "generativelanguage.googleapis.com",
    basePath: "/v1beta/models",
    apiKey: process.env.GEMINI_API_KEY || null,
    // Used by the image pipeline when another provider handles the text.
    // (gemini-2.5-flash now 404s for new keys; Google points at 3.6.)
    model: "gemini-3.6-flash",
    // Concrete ids, not the "-latest" aliases: those currently resolve to
    // thinking models that spend the whole budget before answering. Pro
    // models are omitted because they are 429 on the free AI Studio tier -
    // discovery adds every id, so pick one there if your key has the quota.
    modelMap: {
      "claude-sonnet-4-5": "gemini-3.6-flash",
      "claude-sonnet-4-6": "gemini-3.6-flash",
      "claude-opus-4-7": "gemini-3.8-flash",
      "claude-haiku-4-5-20251001": "gemini-3.1-flash-lite",
    },
    defaultModel: "gemini-3.6-flash",
    type: "gemini",
  },
  opencode: {
    label: "OpenCode Go",
    host: "opencode.ai",
    basePath: "/zen/go/v1/chat/completions",
    apiKey: process.env.OPENCODE_API_KEY || null,
    modelMap: {
      "claude-sonnet-4-5": "deepseek-v4-flash",
      "claude-sonnet-4-6": "deepseek-v4-flash",
      "claude-opus-4-7": "deepseek-v4-flash",
      "claude-haiku-4-5-20251001": "deepseek-v4-flash",
    },
    defaultModel: "deepseek-v4-flash",
    type: "opencode",
  },
  openrouter: {
    label: "OpenRouter",
    host: "openrouter.ai",
    basePath: "/api/v1/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY || null,
    // openrouter/auto picks a model per request and openrouter/free stays on
    // the zero-cost ones, so these defaults survive the catalog churning.
    modelMap: {
      "claude-sonnet-4-5": "openrouter/auto",
      "claude-sonnet-4-6": "openrouter/auto",
      "claude-opus-4-7": "openrouter/auto",
      "claude-haiku-4-5-20251001": "openrouter/free",
    },
    defaultModel: "openrouter/auto",
    type: "openai",
  },
  glm: {
    label: "GLM (Z.ai)",
    host: "api.z.ai",
    basePath: "/api/anthropic/v1",
    apiKey: process.env.GLM_API_KEY || null,
    modelMap: {
      "claude-sonnet-4-5": "glm-5-turbo",
      "claude-sonnet-4-6": "glm-5-turbo",
      "claude-opus-4-7": "glm-5.2",
      "claude-haiku-4-5-20251001": "glm-4.5-air",
    },
    defaultModel: "glm-5-turbo",
    type: "anthropic",
  },
};

for (const [key, ep] of Object.entries(ENDPOINTS)) ep.key = key;

// The ids every built-in provider maps - the ones Claude Desktop ships with.
// Captured before discovery starts adding to the maps, so a generic request
// can be told apart from a deliberate "give me that exact model".
const CANONICAL_IDS = new Set(
  Object.values(ENDPOINTS).flatMap((ep) => Object.keys(ep.modelMap || {}))
);

// A local model server (Ollama, LM Studio) needs no credentials, so "ready"
// is not the same as "has an API key".
function providerReady(key) {
  const ep = ENDPOINTS[key];
  return Boolean(ep && (ep.apiKey || ep.custom));
}

// Model-map overrides from proxy-config.json:
//   { "models": { "glm": { "claude-sonnet-4-5": "glm-5.2" } } }
if (OVERRIDES.models && typeof OVERRIDES.models === "object") {
  for (const [epKey, map] of Object.entries(OVERRIDES.models)) {
    const ep = ENDPOINTS[epKey];
    if (!ep || !ep.modelMap || !map || typeof map !== "object") continue;
    for (const [cModel, uModel] of Object.entries(map)) {
      if (typeof uModel === "string" && uModel.trim()) ep.modelMap[cModel] = uModel.trim();
    }
  }
}
// ─────────────────────────────────────────────────────────

// Mutually exclusive text providers, in priority order when more than one
// key happens to be configured. GLM and DeepSeek both speak the proxy's
// native Anthropic-style format (type: "anthropic"); OpenCode Go needs the
// OpenAI-format conversion (type: "opencode").
// Gemini sits last: its key is usually present for images alone, so it should
// only take over the text when nothing else is configured - or when pinned.
let TEXT_PROVIDER_PRIORITY = ["opencode", "openrouter", "glm", "deepseek", "gemini"];


// ── Live provider catalogs ───────────────────────────
// Every text provider publishes an OpenAI-style model list. With
// `discovery: { "<provider>": true }` in proxy-config.json the proxy pulls that
// list and exposes each model as a `claude-…` id, which is all Claude Desktop
// requires - so the lineup follows the provider instead of a hand-written map.
// `merge: true` means every source is queried and the results combined (the
// same OpenCode key serves two surfaces with different models); otherwise the
// sources are fallbacks and the first one that answers wins. `chatPath` is
// where completions for that surface go, when it differs from ep.basePath.
const CATALOG_SOURCES = {
  opencode: {
    merge: true,
    sources: [
      { host: "opencode.ai", path: "/zen/go/v1/models", chatPath: "/zen/go/v1/chat/completions" },
      // The non-Go surface only contributes its free models: anything paid
      // there is already covered by the Go plan.
      { host: "opencode.ai", path: "/zen/v1/models", chatPath: "/zen/v1/chat/completions", freeOnly: true },
    ],
  },
  deepseek: { sources: [{ host: "api.deepseek.com", path: "/models" }] },
  // OpenRouter reports pricing and modalities itself, so the catalog is
  // filtered to text-output models without asking models.dev.
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
const CATALOG_TTL_MS = 30 * 60 * 1000;

const CATALOGS = {};
for (const key of Object.keys(CATALOG_SOURCES)) {
  CATALOGS[key] = { models: [], fetchedAt: 0, error: null };
}

// ── Custom OpenAI-compatible providers ───────────────────
// Anything that speaks /v1/chat/completions - Ollama, LM Studio, vLLM,
// llama.cpp, a company gateway - declared in proxy-config.json as:
//   "customProviders": [{ "key": "ollama", "label": "Ollama",
//                         "baseUrl": "http://127.0.0.1:11434/v1" }]
// The key, when the endpoint needs one, comes from PATCHBAY_<KEY>_API_KEY in
// .env so secrets stay in one file.
function envKeyNameFor(key) {
  return "PATCHBAY_" + String(key).toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}

function registerCustomProviders() {
  const list = Array.isArray(OVERRIDES.customProviders) ? OVERRIDES.customProviders : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const key = String(entry.key || "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key) || ENDPOINTS[key]) continue; // never shadow a built-in
    let url;
    try {
      url = new URL(String(entry.baseUrl));
    } catch {
      console.error(`[proxy] custom provider "${key}": invalid baseUrl, skipped`);
      continue;
    }
    const base = url.pathname.replace(/\/+$/, "");
    ENDPOINTS[key] = {
      label: String(entry.label || key),
      host: url.hostname,
      scheme: url.protocol === "http:" ? "http" : "https",
      port: url.port ? Number(url.port) : undefined,
      basePath: base + "/chat/completions",
      apiKey: process.env[envKeyNameFor(key)] || entry.apiKey || null,
      modelMap: {},
      defaultModel: String(entry.defaultModel || ""),
      type: "openai",
      custom: true,
    };
    TEXT_PROVIDER_PRIORITY.push(key);
    CATALOG_SOURCES[key] = {
      sources: [
        {
          host: url.hostname,
          scheme: ENDPOINTS[key].scheme,
          port: ENDPOINTS[key].port,
          path: base + "/models",
        },
      ],
    };
    CATALOGS[key] = { models: [], fetchedAt: 0, error: null };
  }
}
registerCustomProviders();

// The control panel can pin one provider instead of relying on key priority.
// This runs after the custom ones are registered, so they can be pinned too.
if (typeof OVERRIDES.provider === "string" && TEXT_PROVIDER_PRIORITY.includes(OVERRIDES.provider)) {
  TEXT_PROVIDER_PRIORITY = [
    OVERRIDES.provider,
    ...TEXT_PROVIDER_PRIORITY.filter((k) => k !== OVERRIDES.provider),
  ];
}

const DISCOVERY = OVERRIDES.discovery && typeof OVERRIDES.discovery === "object" ? OVERRIDES.discovery : {};
const CATALOG_ENABLED = OVERRIDES.catalogEnabled && typeof OVERRIDES.catalogEnabled === "object" ? OVERRIDES.catalogEnabled : {};
const CATALOG_IDS = OVERRIDES.catalogIds && typeof OVERRIDES.catalogIds === "object" ? OVERRIDES.catalogIds : {};

function discoveryOn(provider) {
  return DISCOVERY[provider] === true;
}

function anyDiscoveryOn() {
  return Object.keys(CATALOG_SOURCES).some(discoveryOn);
}

// Which models are free. The provider APIs do not say, so this comes from
// models.dev (OpenCode's own model database): free means input and output both
// cost 0. Only needed for sources marked `freeOnly`.
const PRICING_SOURCES = {
  opencode: ["opencode-go", "opencode"],
  deepseek: ["deepseek"],
  glm: ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"],
  gemini: ["google"],
};
const FREE_TTL_MS = 12 * 60 * 60 * 1000;
// { provider: { model: { free, input, output } } } - drives both the free-only
// filter and the family a generated id lands in.
const pricing = { byProvider: {}, fetchedAt: 0, ok: false };

function needsPricing() {
  // Any provider being discovered benefits: cost decides the id family.
  return Object.keys(CATALOG_SOURCES).some(discoveryOn);
}

function refreshPricing(cb) {
  const done = cb || (() => {});
  if (pricing.fetchedAt && Date.now() - pricing.fetchedAt < FREE_TTL_MS) return done();

  const req = https.request(
    { hostname: "models.dev", port: 443, path: "/api.json", method: "GET", timeout: 25000, headers: { "User-Agent": "claude-desktop-proxy" } },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const db = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const byProvider = {};
          for (const [provider, sources] of Object.entries(PRICING_SOURCES)) {
            const costs = {};
            // Earlier sources win, so a provider's own catalog beats a generic one.
            for (const source of [...sources].reverse()) {
              const models = (db[source] && db[source].models) || {};
              for (const [id, m] of Object.entries(models)) {
                const cost = m.cost || {};
                const input = Number(cost.input);
                const output = Number(cost.output);
                if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
                costs[id] = { free: input === 0 && output === 0, input, output };
              }
            }
            byProvider[provider] = costs;
          }
          pricing.byProvider = byProvider;
          pricing.fetchedAt = Date.now();
          pricing.ok = true;
          console.log(`[proxy] [CATALOG] models.dev: pricing for ${Object.values(byProvider).reduce((n, c) => n + Object.keys(c).length, 0)} models`);
        } catch (e) {
          pricing.ok = false;
          console.error("[proxy] [CATALOG] models.dev unusable, falling back to the -free suffix:", e.message);
        }
        done();
      });
    }
  );
  req.on("error", (e) => {
    pricing.ok = false;
    console.error("[proxy] [CATALOG] models.dev unreachable, falling back to the -free suffix:", e.message);
    done();
  });
  req.on("timeout", () => {
    req.destroy();
    pricing.ok = false;
    done();
  });
  req.end();
}

// With models.dev unavailable, the naming convention is the best guess left.
function costOf(provider, model) {
  const costs = pricing.byProvider[provider];
  return (costs && costs[model]) || null;
}

function isFreeModel(provider, model) {
  const cost = costOf(provider, model);
  if (cost) return cost.free;
  return /-free$/.test(model);
}

// ── Generated model ids ──────────────────────────────────
// Claude Desktop only accepts ids in the Anthropic families; the version part
// is free-form. So a discovered model is published as claude-<family>-3,
// claude-<family>-3-1, ... with the family chosen by price: the cheap ones
// land in haiku, the mid range in sonnet, the expensive in opus, and anything
// with no price at all (a local endpoint, an unlisted model) in fable.
const ID_FAMILIES = ["haiku", "sonnet", "opus", "fable", "mythos"];
const FAMILY_START = 3;
const HAIKU_MAX_INPUT = 0.3; // $/M tokens
const SONNET_MAX_INPUT = 2;

function familyFor(provider, model) {
  const cost = costOf(provider, model);
  if (!cost) return "fable";
  if (cost.free || cost.input <= HAIKU_MAX_INPUT) return "haiku";
  if (cost.input <= SONNET_MAX_INPUT) return "sonnet";
  return "opus";
}

// Ten ids per version: claude-opus-3, claude-opus-3-1 … claude-opus-3-9,
// then claude-opus-4 and so on. Keeps any single version readable.
const PER_VERSION = 10;

function familyId(family, n) {
  const version = FAMILY_START + Math.floor(n / PER_VERSION);
  const slot = n % PER_VERSION;
  return slot === 0 ? `claude-${family}-${version}` : `claude-${family}-${version}-${slot}`;
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

// Custom providers can be plain http on localhost, so neither the module nor
// the port can be assumed.
function transportFor(ep) {
  return ep.scheme === "http" ? http : https;
}

function portFor(ep) {
  if (ep.port) return Number(ep.port);
  return ep.scheme === "http" ? 80 : 443;
}

// Generated ids are rebuilt as a whole so the numbering does not depend on
// which catalog answered first.
const generatedIds = {}; // provider → { claudeId: upstreamModel }

// Ids are handed out in this order, always. It deliberately ignores
// TEXT_PROVIDER_PRIORITY, which gets reordered when a provider is pinned, and
// mirrors the panel's provider list so both sides generate the same ids.
function idOrder() {
  const builtins = ["opencode", "openrouter", "glm", "deepseek", "gemini"];
  return [
    ...builtins.filter((k) => ENDPOINTS[k]),
    ...Object.keys(ENDPOINTS).filter((k) => ENDPOINTS[k].custom),
  ];
}

function rebuildGeneratedIds() {
  const counters = Object.fromEntries(ID_FAMILIES.map((f) => [f, 0]));
  const taken = new Set();

  // The canonical ids belong to the static maps: a generated id must never
  // land on one, or a discovered model would quietly take over claude-sonnet-4-5.
  for (const id of CANONICAL_IDS) taken.add(id);

  // Ids pinned by hand, in proxy-config.json, are reserved before anything else.
  for (const [provider, map] of Object.entries(CATALOG_IDS)) {
    if (!map || typeof map !== "object") continue;
    for (const id of Object.values(map)) if (typeof id === "string") taken.add(id);
  }
  for (const ep of Object.values(ENDPOINTS)) {
    for (const id of Object.keys((OVERRIDES.models && OVERRIDES.models[ep.key]) || {})) taken.add(id);
  }

  let total = 0;
  for (const provider of idOrder()) {
    const ep = ENDPOINTS[provider];
    const state = CATALOGS[provider];
    if (!ep || !ep.modelMap || !state) continue;

    // Drop the previous generation before assigning again.
    for (const id of Object.keys(generatedIds[provider] || {})) delete ep.modelMap[id];
    generatedIds[provider] = {};
    if (!discoveryOn(provider)) continue;

    const allow = Array.isArray(CATALOG_ENABLED[provider]) ? new Set(CATALOG_ENABLED[provider]) : null;
    const renamed = CATALOG_IDS[provider] && typeof CATALOG_IDS[provider] === "object" ? CATALOG_IDS[provider] : {};

    for (const model of state.models) {
      if (allow && !allow.has(model)) continue;

      const custom = typeof renamed[model] === "string" && /^claude-/.test(renamed[model]) ? renamed[model] : null;
      let id = custom;
      if (!id) {
        const family = familyFor(provider, model);
        do {
          id = familyId(family, counters[family]++);
        } while (taken.has(id));
      }
      if (taken.has(id) && !custom) continue;
      taken.add(id);
      ep.modelMap[id] = model;
      generatedIds[provider][id] = model;
      total++;
    }
  }
  return total;
}

function applyCatalog(provider, models, chatPaths) {
  const ep = ENDPOINTS[provider];
  if (!ep || !ep.modelMap) return 0;
  // Per-model completions path, for providers whose catalog spans more than
  // one base (see sendOpenCodeRequest).
  ep.modelBase = ep.modelBase || {};
  for (const [model, chatPath] of Object.entries(chatPaths || {})) {
    if (chatPath) ep.modelBase[model] = chatPath;
  }
  return rebuildGeneratedIds();
}

function fetchModelList(provider, sourceIndex, cb) {
  const ep = ENDPOINTS[provider];
  const spec = CATALOG_SOURCES[provider] || { sources: [] };
  const sources = spec.sources;
  const source = sources[sourceIndex];
  if (!source) return cb(new Error("no endpoint answered"), null);

  const useQueryAuth = source.auth === "query" && Boolean(ep.apiKey);
  const reqPath = useQueryAuth
    ? source.path + (source.path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(ep.apiKey)
    : source.path;

  const transport = source.scheme === "http" ? http : https;
  const req = transport.request(
    {
      hostname: source.host,
      port: source.port || (source.scheme === "http" ? 80 : 443),
      path: reqPath,
      method: "GET",
      timeout: 15000,
      headers: useQueryAuth || !ep.apiKey
        ? { "User-Agent": "claude-desktop-proxy" }
        : {
            Authorization: "Bearer " + ep.apiKey,
            "x-api-key": ep.apiKey,
            "User-Agent": "claude-desktop-proxy",
          },
    },
    (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let models = null;
        try {
          const json = JSON.parse(d);
          if (source.parse === "openrouter") {
            // OpenRouter prices its own catalog, in dollars per token.
            const costs = {};
            for (const m of json.data || []) {
              const input = Number(m.pricing && m.pricing.prompt) * 1e6;
              const output = Number(m.pricing && m.pricing.completion) * 1e6;
              // A negative price means "varies" (the auto routers), not free.
              if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
              costs[m.id] = { free: input === 0 && output === 0, input, output };
            }
            pricing.byProvider.openrouter = costs;
          }
          models =
            source.parse === "openrouter"
              ? // Keep the text-only models; the rest also emit images or audio.
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
          const chatPaths = {};
          for (const m of models) chatPaths[m] = source.chatPath || null;
          if (spec.merge && sourceIndex + 1 < sources.length) {
            // Combine the surfaces instead of stopping at the first one.
            return fetchModelList(provider, sourceIndex + 1, (err2, more, morePaths) => {
              if (err2 || !more) return cb(null, models, chatPaths);
              const seen = new Set(models);
              const all = [...models];
              for (const m of more) {
                if (seen.has(m)) continue;
                seen.add(m);
                all.push(m);
                chatPaths[m] = (morePaths && morePaths[m]) || null;
              }
              cb(null, all, chatPaths);
            });
          }
          return cb(null, models, chatPaths);
        }
        // A free-only source can legitimately come back empty after filtering.
        if (source.freeOnly && models) return cb(null, [], {});
        // Try the next base before giving up (Z.ai coding vs general plan).
        if (sourceIndex + 1 < sources.length) return fetchModelList(provider, sourceIndex + 1, cb);
        cb(new Error("HTTP " + res.statusCode + ": " + d.slice(0, 120)), null);
      });
    }
  );
  req.on("error", (e) => {
    if (sourceIndex + 1 < sources.length) return fetchModelList(provider, sourceIndex + 1, cb);
    cb(e, null);
  });
  req.on("timeout", () => {
    req.destroy();
    if (sourceIndex + 1 < sources.length) return fetchModelList(provider, sourceIndex + 1, cb);
    cb(new Error("timeout"), null);
  });
  req.end();
}

function refreshCatalog(provider, cb) {
  const done = cb || (() => {});
  const state = CATALOGS[provider];
  const ep = ENDPOINTS[provider];
  if (!state || !ep) return done(null);
  if (!ep.apiKey && !ep.custom) {
    state.error = "no API key";
    return done(state);
  }
  fetchModelList(provider, 0, (err, models, chatPaths) => {
    if (err) {
      state.error = err.message;
      console.error(`[proxy] [CATALOG] ${ep.label}: failed — ${err.message}`);
      return done(state);
    }
    state.models = models;
    state.fetchedAt = Date.now();
    state.error = null;
    const added = applyCatalog(provider, models, chatPaths);
    console.log(`[proxy] [CATALOG] ${ep.label}: ${models.length} models (${added} ids published)`);
    done(state);
  });
}

function refreshAllCatalogs() {
  if (needsPricing()) return refreshPricing(() => refreshCatalogs());
  refreshCatalogs();
}

function refreshCatalogs() {
  for (const provider of Object.keys(CATALOG_SOURCES)) {
    if (!discoveryOn(provider)) continue;
    const ep = ENDPOINTS[provider];
    if (!ep) continue;
    if (!ep.apiKey && !ep.custom) {
      // Discovery is on but there is nothing to authenticate with; say so
      // instead of reporting an empty catalog with no reason.
      CATALOGS[provider].error = "no API key";
      continue;
    }
    refreshCatalog(provider);
  }
}


// The text backend the user actually configured.
function getPrimaryTextEndpoint() {
  for (const key of TEXT_PROVIDER_PRIORITY) {
    if (providerReady(key)) return key;
  }
  return "deepseek"; // last-resort default if nothing is configured
}

// Load TLS certs
const tlsOptions = {
  key: fs.readFileSync(path.join(DIR, "certs", "server-key.pem"), "utf8"),
  cert: fs.readFileSync(path.join(DIR, "certs", "server-cert.pem"), "utf8"),
};

// ── Helpers ──────────────────────────────────────────────

function resolveEndpoint(parsed) {
  const origModel = parsed.model || "unknown";

  // Check if any message contains images → route to Gemini
  const messages = parsed.messages || [];
  for (const msg of messages) {
    if (Array.isArray(msg.content) && msg.content.some((c) => c.type === "image")) {
      const ep = ENDPOINTS.gemini;
      // When Gemini is already the text backend there is nothing to hand off
      // to: send the images to it directly instead of OCR-ing them first.
      if (getPrimaryTextEndpoint() === "gemini") {
        console.log(`[proxy] [IMAGE] image detected → Gemini handles it directly`);
        return { key: "gemini", ep, upstreamModel: ep.modelMap[origModel] || ep.defaultModel, directGemini: true };
      }
      console.log(`[proxy] [IMAGE] image detected → routing to Gemini`);
      return { key: "gemini", ep, upstreamModel: ep.model, isImagePipeline: true };
    }
  }

  // A canonical id is a generic ask, so it belongs to the active provider even
  // when that provider carries no static map of its own (a custom endpoint).
  // A discovered id like claude-kimi-k3 still goes to whoever actually serves it.
  const primaryKey = getPrimaryTextEndpoint();
  const primaryEp = ENDPOINTS[primaryKey];
  if (primaryEp && CANONICAL_IDS.has(origModel) && !primaryEp.modelMap[origModel]) {
    const fallbackModel = primaryEp.defaultModel || (CATALOGS[primaryKey] && CATALOGS[primaryKey].models[0]);
    if (fallbackModel) {
      return {
        key: primaryKey,
        ep: primaryEp,
        upstreamModel: fallbackModel,
        directGemini: primaryKey === "gemini",
      };
    }
  }

  // Route to whichever configured text provider is highest-priority for this model.
  for (const key of TEXT_PROVIDER_PRIORITY) {
    const ep = ENDPOINTS[key];
    if (!providerReady(key)) continue;
    if (ep.modelMap && ep.modelMap[origModel]) {
      return { key, ep, upstreamModel: ep.modelMap[origModel], directGemini: key === "gemini" };
    }
  }
  // Unknown model id: fall back to whichever text provider is actually configured,
  // instead of always DeepSeek (which may have no API key set).
  // An id that names an upstream model directly (gemini-3.8-flash, kimi-k3) is
  // honoured when a ready provider actually serves it - handy for a model list
  // written before the claude-* ids existed.
  for (const key of TEXT_PROVIDER_PRIORITY) {
    if (!providerReady(key)) continue;
    const state = CATALOGS[key];
    if (state && state.models.includes(origModel)) {
      return { key, ep: ENDPOINTS[key], upstreamModel: origModel, directGemini: key === "gemini" };
    }
  }

  // Nothing matches. Answering with the active provider's default would send a
  // request meant for one model to a completely different one, which is worse
  // than failing: it looks like it worked.
  return { key: null, ep: null, upstreamModel: "", unknownModel: true };
}

function cleanSchema(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);
  const keepKeys = new Set(["type", "description", "properties", "items",
    "required", "enum", "nullable", "format", "default", "minimum", "maximum",
    "minLength", "maxLength", "pattern", "title"]);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keepKeys.has(k)) {
      cleaned[k] = cleanSchema(v);
    }
  }
  return cleaned;
}

// ── Anthropic → OpenAI format conversion ────────────────────

function anthropicToOpenAIBody(parsed) {
  const openAIMessages = [];
  let systemContent = parsed.system || "";

  for (const msg of parsed.messages || []) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      systemContent += (systemContent ? "\n" : "") + text;
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        openAIMessages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text });
          } else if (block.type === "image" && block.source) {
            const mime = block.source.media_type || "image/jpeg";
            parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${block.source.data}` } });
          } else if (block.type === "tool_result") {
            const toolText = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            openAIMessages.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolText });
          }
        }
        if (parts.length > 0) {
          openAIMessages.push({ role: "user", content: parts });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        openAIMessages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          }
        }
        const entry = { role: "assistant" };
        entry.content = textParts.length > 0 ? textParts.join("\n") : null;
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        openAIMessages.push(entry);
      }
    }
  }

  if (systemContent) {
    openAIMessages.unshift({ role: "system", content: systemContent });
  }

  const body = {
    model: parsed.model,
    messages: openAIMessages,
    max_tokens: Math.max(parsed.max_tokens || 8192, 1024),
    stream: !!parsed.stream,
    thinking: { type: "disabled" },
  };

  if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) body.top_p = parsed.top_p;

  if (parsed.tools && Array.isArray(parsed.tools)) {
    body.tools = parsed.tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: cleanSchema(t.input_schema) },
    }));
  }

  return body;
}

function openAIToAnthropicResponse(raw, origModel) {
  const choice = raw.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  } else if (msg.reasoning_content) {
    content.push({ type: "text", text: msg.reasoning_content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}") });
    }
  }

  const finishMap = { "stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use" };
  const usage = raw.usage || {};

  return {
    id: "msg_" + Math.random().toString(36).substring(2, 15),
    type: "message",
    role: "assistant",
    model: origModel,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: finishMap[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

function openAIChunkToAnthropicSSE(chunk, origModel, state) {
  const choice = chunk.choices?.[0] || {};
  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;
  const events = [];

  if (!state.started) {
    state.started = true;
    state.nextBlockIndex = 0;
    state.textBlockIndex = null;
    state.toolBlocks = new Map(); // OpenAI tool_call index -> { anthropicIndex, id, name }
    events.push({
      type: "message_start",
      message: {
        id: "msg_" + Math.random().toString(36).substring(2, 15),
        type: "message",
        role: "assistant",
        model: origModel,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  const text = delta.content || delta.reasoning_content || "";
  if (text) {
    if (state.textBlockIndex === null) {
      state.textBlockIndex = state.nextBlockIndex++;
      events.push({ type: "content_block_start", index: state.textBlockIndex, content_block: { type: "text", text: "" } });
    }
    events.push({ type: "content_block_delta", index: state.textBlockIndex, delta: { type: "text_delta", text } });
  }

  // OpenAI streams tool calls incrementally: id/name arrive once, then
  // `function.arguments` arrives fragment by fragment across chunks.
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const oaIndex = tc.index ?? 0;
      let block = state.toolBlocks.get(oaIndex);
      if (!block) {
        block = {
          anthropicIndex: state.nextBlockIndex++,
          id: tc.id || ("toolu_" + Math.random().toString(36).substring(2, 15)),
          name: tc.function?.name || "",
        };
        state.toolBlocks.set(oaIndex, block);
        events.push({
          type: "content_block_start",
          index: block.anthropicIndex,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        });
      }
      const argsPiece = tc.function?.arguments;
      if (argsPiece) {
        events.push({
          type: "content_block_delta",
          index: block.anthropicIndex,
          delta: { type: "input_json_delta", partial_json: argsPiece },
        });
      }
    }
  }

  if (finishReason) {
    if (state.textBlockIndex !== null) {
      events.push({ type: "content_block_stop", index: state.textBlockIndex });
    }
    for (const block of state.toolBlocks.values()) {
      events.push({ type: "content_block_stop", index: block.anthropicIndex });
    }
    const stopMap = { "stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use" };
    events.push({
      type: "message_delta",
      delta: { stop_reason: stopMap[finishReason] || "end_turn", stop_sequence: null },
      usage: { input_tokens: chunk.usage?.prompt_tokens || 0, output_tokens: chunk.usage?.completion_tokens || 0 },
    });
    events.push({ type: "message_stop" });
  }

  return events;
}

// ───────────────────────────────────────────────────────────

function anthropicToGeminiContents(parsed, origModel) {
  const contents = [];
  let systemInstruction = null;
  const systemParts = [];
  const messages = parsed.messages || [];
  let hasSystem = false;

  for (const msg of messages) {
    if (msg.role === "system") {
      hasSystem = true;
      if (typeof msg.content === "string") {
        systemParts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") systemParts.push({ text: block.text });
        }
      }
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          let mimeType = "image/jpeg";
          let data = "";
          if (block.source) {
            mimeType = block.source.media_type || "image/jpeg";
            data = block.source.data || "";
          }
          parts.push({ inlineData: { mimeType, data } });
        } else if (block.type === "tool_use") {
          parts.push({ text: JSON.stringify({ type: "tool_use", name: block.name, input: block.input, id: block.id }) });
        } else if (block.type === "tool_result") {
          parts.push({ text: JSON.stringify({ type: "tool_result", tool_use_id: block.tool_use_id, content: block.content }) });
        }
      }
    }
    contents.push({ role, parts });
  }

  if (systemParts.length > 0) {
    systemInstruction = { parts: systemParts };
  }

  const genConfig = {};
  if (parsed.max_tokens) genConfig.maxOutputTokens = Math.min(parsed.max_tokens, 8192);
  if (parsed.temperature !== undefined) genConfig.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) genConfig.topP = parsed.top_p;

  const tools = [];
  if (parsed.tools && Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool.name && tool.input_schema) {
        tools.push({
          functionDeclarations: [{
            name: tool.name,
            description: tool.description || "",
            parameters: cleanSchema(tool.input_schema),
          }],
        });
      }
    }
  }

  const body = { contents, generationConfig: genConfig };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  // Strip tools for Gemini (not needed for vision/OCR, and schema incompatibilities cause 400)
  if (body.tools) delete body.tools;

  return body;
}

function geminiToAnthropicResponse(geminiResp, origModel) {
  const candidate = geminiResp.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  const finishReason = candidate.finishReason || "STOP";

  const stopReasonMap = {
    "STOP": "end_turn",
    "MAX_TOKENS": "max_tokens",
    "SAFETY": "end_turn",
    "RECITATION": "end_turn",
  };

  const content = [];
  for (const part of parts) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: "toolu_" + Math.random().toString(36).substring(2, 15),
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  const usage = geminiResp.usageMetadata || {};
  return {
    id: "msg_" + Math.random().toString(36).substring(2, 15),
    type: "message",
    role: "assistant",
    model: origModel,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: stopReasonMap[finishReason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

// ── Shared text-backend senders (used by the main handler and the image
// pipeline, so both honor whichever provider — DeepSeek or OpenCode Go —
// the user actually configured) ─────────────────────────────────────────

function sendAnthropicRequest(ep, parsed, req, res, origModel) {
  const newBody = JSON.stringify(parsed);
  const upstreamPath = ep.basePath + req.url.split("?")[0];
  const options = {
    hostname: ep.host,
    port: 443,
    path: upstreamPath,
    method: "POST",
    // Security: Do not forward client-supplied API key; use only configured key
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(newBody),
      "x-api-key": ep.apiKey || "",
      "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
    },
  };

  console.log(`[proxy] → POST https://${ep.host}${upstreamPath} (${newBody.length} bytes, stream=${!!parsed.stream})`);

  const upstream = https.request(options, (upstreamRes) => {
    const isSSE = (upstreamRes.headers["content-type"] || "").includes("text/event-stream");
    const respHeaders = {
      "Content-Type": upstreamRes.headers["content-type"] || "application/json",
    };
    res.writeHead(upstreamRes.statusCode, respHeaders);

    if (isSSE) {
      let buffer = "";
      upstreamRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.substring(6).trim();
            if (data === "[DONE]") { res.write("data: [DONE]\n\n"); continue; }
            try {
              const event = JSON.parse(data);
              if (event.type === "message_start" && event.message?.model) event.message.model = origModel;
              res.write("data: " + JSON.stringify(event) + "\n\n");
            } catch { res.write(line + "\n"); }
          } else { res.write(line + "\n"); }
        }
      });
      upstreamRes.on("end", () => { if (buffer) res.write(buffer + "\n"); res.end(); console.log("[proxy] ← stream complete"); });
    } else {
      let d = "";
      upstreamRes.on("data", (c) => (d += c));
      upstreamRes.on("end", () => {
        console.log(`[proxy] ← ${upstreamRes.statusCode >= 400 ? "ERR" : "OK"} ${upstreamRes.statusCode} (${d.length} bytes)`);
        try {
          const resp = JSON.parse(d);
          resp.model = origModel;
          res.end(JSON.stringify(resp));
        } catch { res.end(d); }
      });
    }
  });

  upstream.on("error", (err) => {
    console.error("[proxy] upstream error:", err.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: err.message } }));
  });
  upstream.write(newBody);
  upstream.end();
}

// OpenCode requires a session id; without it the API answers MissingSessionID
// ("free tier can only be used in OpenCode"). Reuse the caller's when present,
// otherwise derive a stable one from the first message so a conversation keeps
// the same session across turns.
function getOpenCodeSessionId(parsed, req) {
  if (req && req.headers && req.headers["x-opencode-session"]) {
    return req.headers["x-opencode-session"];
  }
  if (parsed && parsed.messages && parsed.messages.length > 0) {
    const firstMsg = JSON.stringify(parsed.messages[0]);
    let hash = 0;
    for (let i = 0; i < firstMsg.length; i++) {
      hash = (hash << 5) - hash + firstMsg.charCodeAt(i);
      hash |= 0;
    }
    return "claude-session-" + Math.abs(hash).toString(36);
  }
  return "claude-session-default";
}

function sendOpenCodeRequest(ep, parsed, req, res, origModel) {
  const openAIBody = anthropicToOpenAIBody(parsed);
  const newBody = JSON.stringify(openAIBody);
  // A model discovered on the non-Go surface has to be sent there: the Go base
  // answers "Model … is not supported" for it.
  const upstreamPath = (ep.modelBase && ep.modelBase[parsed.model]) || ep.basePath;

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(newBody),
  };
  // Security: never forward a client-supplied key; only the configured one.
  // A local model server usually has none at all.
  if (ep.apiKey) headers["Authorization"] = "Bearer " + ep.apiKey;
  if (ep.key === "opencode" || ep.type === "opencode") {
    headers["x-opencode-session"] = getOpenCodeSessionId(parsed, req);
  }
  if (ep.host === "openrouter.ai") {
    // Optional attribution headers OpenRouter uses for its rankings.
    headers["HTTP-Referer"] = "https://github.com/Grekto-dev/patchbay";
    headers["X-Title"] = "Patchbay";
  }

  const options = {
    hostname: ep.host,
    port: portFor(ep),
    path: upstreamPath,
    method: "POST",
    headers,
  };

  const tag = ep.custom ? ep.label.toUpperCase() : ep.key === "openrouter" ? "OPENROUTER" : "OPENCODE";
  const scheme = ep.scheme === "http" ? "http" : "https";
  const hostPort = ep.port ? ep.host + ":" + ep.port : ep.host;
  console.log(`[proxy] [${tag}] model: ${parsed.model} (from ${origModel})`);
  console.log(`[proxy] [${tag}] → POST ${scheme}://${hostPort}${upstreamPath} (${newBody.length} bytes, stream=${!!parsed.stream})`);

  const upstream = transportFor(ep).request(options, (upstreamRes) => {
    const isSSE = (upstreamRes.headers["content-type"] || "").includes("text/event-stream");

    if (upstreamRes.statusCode >= 400) {
      let errBuf = "";
      upstreamRes.on("data", (c) => (errBuf += c));
      upstreamRes.on("end", () => {
        console.error(`[proxy] [OPENCODE] ⚠ ERROR ${upstreamRes.statusCode}: ${errBuf.substring(0, 500)}`);
        if (!res.headersSent) {
          res.writeHead(upstreamRes.statusCode, {
            "Content-Type": "application/json"
            // "Access-Control-Allow-Origin": "*" // DISABLED: Prevent Confused Deputy attacks from browsers
          });
        }
        res.end(JSON.stringify({ type: "error", error: { message: `${ep.label} API ${upstreamRes.statusCode}` } }));
      });
      return;
    }

    if (isSSE) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream"
        // "Access-Control-Allow-Origin": "*" // DISABLED: Prevent Confused Deputy attacks from browsers
      });

      let buffer = "";
      const sseState = { started: false };

      upstreamRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.substring(6).trim();
            if (data === "[DONE]") { res.write("data: [DONE]\n\n"); continue; }
            try {
              const chunkEvent = JSON.parse(data);
              const events = openAIChunkToAnthropicSSE(chunkEvent, origModel, sseState) || [];
              for (const ev of events) {
                if (ev.type === "message_start" && ev.message?.model) ev.message.model = origModel;
                res.write("data: " + JSON.stringify(ev) + "\n\n");
              }
            } catch { res.write(line + "\n"); }
          } else { res.write(line + "\n"); }
        }
      });

      upstreamRes.on("end", () => {
        if (buffer) res.write(buffer + "\n");
        res.end();
        console.log(`[proxy] [OPENCODE] ← stream complete`);
      });
    } else {
      const respHeaders = {
        "Content-Type": "application/json"
        // "Access-Control-Allow-Origin": "*" // DISABLED: Prevent Confused Deputy attacks from browsers
      };
      res.writeHead(upstreamRes.statusCode, respHeaders);

      let d = "";
      upstreamRes.on("data", (c) => (d += c));
      upstreamRes.on("end", () => {
        console.log(`[proxy] [OPENCODE] ← ${upstreamRes.statusCode} (${d.length} bytes)`);
        try {
          const raw = JSON.parse(d);
          const anthropicResp = openAIToAnthropicResponse(raw, origModel);
          res.end(JSON.stringify(anthropicResp));
        } catch { res.end(d); }
      });
    }
  });

  upstream.on("error", (err) => {
    console.error("[proxy] [OPENCODE] upstream error:", err.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: err.message } }));
  });

  upstream.write(newBody);
  upstream.end();
}

// ── Gemini as a text backend ─────────────────────────────
// Google AI Studio speaks its own format, so the request is converted on the
// way out and the response (or SSE stream) on the way back. The same call
// handles images, since Gemini is multimodal.
function sendGeminiRequest(ep, parsed, req, res, origModel, upstreamModel, retryCount = 0) {
  const targetModel = upstreamModel || ep.defaultModel || ep.model;
  const isStream = !!parsed.stream;

  if (!parsed.max_tokens || parsed.max_tokens < 1024) parsed.max_tokens = 8192;

  const geminiBody = anthropicToGeminiContents(parsed, origModel);
  const geminiBodyStr = JSON.stringify(geminiBody);
  const action = isStream ? "streamGenerateContent?alt=sse&key=" : "generateContent?key=";
  const geminiPath = `${ep.basePath}/${targetModel}:${action}${ep.apiKey || ""}`;

  console.log(`[proxy] [GEMINI] model: ${targetModel} (from ${origModel})`);
  console.log(`[proxy] [GEMINI] → POST https://${ep.host}${ep.basePath}/${targetModel} (${geminiBodyStr.length} bytes, stream=${isStream})`);

  const upstream = https.request(
    {
      hostname: ep.host,
      port: 443,
      path: geminiPath,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(geminiBodyStr) },
    },
    (upstreamRes) => {
      // Flash models throw 503 under load; one retry usually clears it.
      if (upstreamRes.statusCode === 503 && retryCount < 2) {
        console.log(`[proxy] [GEMINI] 503 — retrying in 500ms (attempt ${retryCount + 1})`);
        upstreamRes.resume();
        setTimeout(() => sendGeminiRequest(ep, parsed, req, res, origModel, targetModel, retryCount + 1), 500);
        return;
      }

      if (upstreamRes.statusCode >= 400) {
        let errBuf = "";
        upstreamRes.on("data", (c) => (errBuf += c));
        upstreamRes.on("end", () => {
          console.error(`[proxy] [GEMINI] ⚠ ERROR ${upstreamRes.statusCode}: ${errBuf.substring(0, 500)}`);
          if (!res.headersSent) res.writeHead(upstreamRes.statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { message: `Gemini API ${upstreamRes.statusCode}: ${errBuf}` } }));
        });
        return;
      }

      if (!isStream) {
        res.writeHead(upstreamRes.statusCode, { "Content-Type": "application/json" });
        let d = "";
        upstreamRes.on("data", (c) => (d += c));
        upstreamRes.on("end", () => {
          console.log(`[proxy] [GEMINI] ← ${upstreamRes.statusCode} (${d.length} bytes)`);
          try {
            res.end(JSON.stringify(geminiToAnthropicResponse(JSON.parse(d), origModel)));
          } catch {
            res.end(d);
          }
        });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const state = { started: false, blockStarted: false, finished: false };
      const emit = (events) => {
        for (const ev of [].concat(events || [])) {
          if (!ev) continue;
          if (ev.type === "message_stop") state.finished = true;
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        }
      };

      const feed = (payload) => {
        if (!payload || payload === "[DONE]") return;
        try {
          const chunk = JSON.parse(payload);
          // The first chunk only opens the message, so run it until it stops
          // producing events for this payload.
          let guard = 0;
          let events = geminiToAnthropicSSE(chunk, origModel, state);
          while (events && guard++ < 4) {
            emit(events);
            const next = geminiToAnthropicSSE(chunk, origModel, state);
            if (!next || JSON.stringify(next) === JSON.stringify(events)) break;
            events = next;
          }
        } catch {
          /* ignore non-json lines */
        }
      };

      let buffer = "";
      upstreamRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) feed(line.slice(6).trim());
        }
      });

      upstreamRes.on("end", () => {
        if (buffer.startsWith("data: ")) feed(buffer.slice(6).trim());
        if (state.started && !state.finished) {
          if (state.blockStarted) emit({ type: "content_block_stop", index: 0 });
          emit([
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
            { type: "message_stop" },
          ]);
        }
        res.end();
        console.log(`[proxy] [GEMINI] ← stream complete`);
      });
    }
  );

  upstream.on("error", (err) => {
    console.error("[proxy] [GEMINI] upstream error:", err.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: err.message } }));
  });

  upstream.write(geminiBodyStr);
  upstream.end();
}

// ── Image pipeline ─────────────────────────────────────────
function handleImagePipeline(req, res, parsed, origModel) {
  const geminiEp = ENDPOINTS.gemini;
  // Use whichever text backend is actually configured (DeepSeek or OpenCode
  // Go) for the follow-up completion, instead of assuming DeepSeek.
  const textKey = getPrimaryTextEndpoint();
  const textEp = ENDPOINTS[textKey];

  console.log(`[proxy] [IMAGE] === Image → Gemini OCR → ${textEp.label} pipeline ===`);

  const geminiBody = anthropicToGeminiContents(parsed, origModel);
  const geminiBodyStr = JSON.stringify(geminiBody);
  const geminiPath = geminiEp.basePath + "/" + geminiEp.model + ":generateContent?key=" + (geminiEp.apiKey || "");

  console.log(`[proxy] [IMAGE] sending to Gemini (${geminiBodyStr.length} bytes)`);

  const geminiReq = https.request({
    hostname: geminiEp.host, port: 443, path: geminiPath, method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(geminiBodyStr) },
  }, (geminiRes) => {
    let gd = "";
    geminiRes.on("data", (c) => (gd += c));
    geminiRes.on("end", () => {
      console.log(`[proxy] [IMAGE] Gemini response: ${geminiRes.statusCode} (${gd.length} bytes)`);
      let imageDescription = "";
      try {
        const gr = JSON.parse(gd);
        const parts = gr.candidates?.[0]?.content?.parts || [];
        imageDescription = parts.map((p) => p.text || "").join("").trim();
      } catch { /* use empty description if Gemini fails */ }

      if (!imageDescription) {
        console.log(`[proxy] [IMAGE] Gemini returned no description (status ${geminiRes.statusCode}), removing images from request`);
      } else {
        console.log(`[proxy] [IMAGE] description (${imageDescription.length} chars): ${imageDescription.substring(0, 200)}...`);
      }

      const textModel = textEp.modelMap[origModel] || textEp.defaultModel;
      parsed.model = textModel;

      if (!parsed.max_tokens || parsed.max_tokens < 1024) parsed.max_tokens = 8192;

      if (parsed.messages) {
        for (const msg of parsed.messages) {
          if (Array.isArray(msg.content)) {
            const newContent = [];
            const userTextParts = [];
            let hasImage = false;
            for (const block of msg.content) {
              if (block.type === "image") {
                hasImage = true;
              } else if (block.type === "text") {
                userTextParts.push(block.text);
              } else {
                newContent.push(block);
              }
            }
            if (hasImage) {
              const userText = userTextParts.join("\n");
              let imageText;
              if (imageDescription) {
                imageText = userText
                  ? userText + "\n\nL'utente ha caricato un'immagine. Ecco la sua descrizione dettagliata:\n" + imageDescription
                  : imageDescription;
              } else {
                imageText = userText
                  ? userText + "\n\n[Immagine non analizzabile]"
                  : "Immagine caricata";
              }
              newContent.unshift({ type: "text", text: imageText });
            }
            if (newContent.length > 0) {
              msg.content = newContent;
            }
          }
        }
      }

      console.log(`[proxy] [IMAGE] model map: ${origModel} → ${textModel} (${textEp.label})`);

      if (textEp.type === "anthropic") {
        sendAnthropicRequest(textEp, parsed, req, res, origModel);
      } else {
        sendOpenCodeRequest(textEp, parsed, req, res, origModel);
      }
    });
  });

  geminiReq.on("error", (e) => {
    console.error("[proxy] [IMAGE] gemini error:", e.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
  });
  geminiReq.write(geminiBodyStr);
  geminiReq.end();
}

// ── Request handler ──────────────────────────────────────

function handleRequest(req, res) {
  // Security: CORS headers disabled – proxy is only for Claude Desktop
  // res.setHeader("Access-Control-Allow-Origin", "*");
  // res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === "GET") {
    // /v1/models — OpenAI-compatible models list (required by newer Claude Desktop connection test)
    if (req.url === "/v1/models" || req.url.startsWith("/v1/models?")) {
      const modelIds = new Set();
      for (const ep of Object.values(ENDPOINTS)) {
        if (ep.modelMap) {
          for (const cModel of Object.keys(ep.modelMap)) modelIds.add(cModel);
        }
      }
      const data = Array.from(modelIds).map(id => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data }));
    }

    // Root status endpoint
    const models = {};
    for (const [key, ep] of Object.entries(ENDPOINTS)) {
      if (ep.modelMap) {
        for (const [cModel, uModel] of Object.entries(ep.modelMap)) {
          models[cModel] = `${key}:${uModel}`;
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      proxy: "claude-deepseek-proxy",
      endpoints: "DeepSeek + OpenCode Go + GLM (Z.ai) + Gemini Flash (auto image routing)",
      activeTextBackend: ENDPOINTS[getPrimaryTextEndpoint()].label,
      catalog: Object.fromEntries(
        Object.keys(CATALOG_SOURCES).map((k) => [
          k,
          {
            discovery: discoveryOn(k),
            count: CATALOGS[k].models.length,
            fetchedAt: CATALOGS[k].fetchedAt || null,
            error: CATALOGS[k].error,
          },
        ])
      ),
      models,
    }));
  }

  let body = "";
  // Security: Limit request payload size to 50 MB to mitigate DoS attacks
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 50 * 1024 * 1024) { // 50MB limit
      if (!res.headersSent) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
      }
      req.destroy();
    }
  });
  req.on("end", () => {
    if (req.destroyed) return;

    let parsed;
    // Security: Ensure payload is valid JSON object
    try {
      parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Payload must be a JSON object");
      }
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }

    const origModel = parsed.model || "unknown";
    const origMaxTokens = parsed.max_tokens;
    const { key: epKey, ep, upstreamModel, directGemini, unknownModel } = resolveEndpoint(parsed);

    console.log(`[proxy] incoming: model=${origModel}, max_tokens=${origMaxTokens}, stream=${!!parsed.stream}, endpoint=${epKey || "none"}`);

    // ── INTERCEPT PROBES ──────────────────────────────
    if (origMaxTokens !== undefined && origMaxTokens <= 1 && !parsed.stream) {
      const probeResp = {
        id: "msg_" + Math.random().toString(36).substring(2, 15),
        type: "message",
        role: "assistant",
        model: origModel,
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      };
      console.log(`[proxy] ← PROBE response`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(probeResp));
    }

    if (unknownModel || !ep || !upstreamModel) {
      const ready = Object.keys(ENDPOINTS)
        .filter((k) => providerReady(k) && ENDPOINTS[k].modelMap)
        .map((k) => ENDPOINTS[k].label)
        .join(", ");
      console.error(`[proxy] ✖ unknown model "${origModel}" — no provider serves it`);
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          type: "error",
          error: {
            message:
              `No configured provider serves "${origModel}". Configured: ${ready || "none"}. ` +
              `Re-export the model list from the Patchbay panel (Models → Export to Claude Desktop) ` +
              `so Claude Desktop uses the ids the proxy actually publishes.`,
          },
        })
      );
    }

    // ── Gemini as the text backend (also multimodal) ──
    if (directGemini) {
      console.log(`[proxy] model map: ${origModel} → ${upstreamModel} (Google AI Studio)`);
      sendGeminiRequest(ep, parsed, req, res, origModel, upstreamModel);
      return;
    }

    // ── Route to DeepSeek (Anthropic format) ────────
    if (ep.type === "anthropic") {
      parsed.model = upstreamModel;
      console.log(`[proxy] model map: ${origModel} → ${upstreamModel}`);
      if (!parsed.max_tokens || parsed.max_tokens < 1024) parsed.max_tokens = 8192;
      sendAnthropicRequest(ep, parsed, req, res, origModel);
      return;
    }

    // ── Route to any OpenAI-compatible provider ────
    if (ep.type === "opencode" || ep.type === "openai") {
      parsed.model = upstreamModel;
      if (!parsed.max_tokens || parsed.max_tokens < 1024) parsed.max_tokens = 8192;
      sendOpenCodeRequest(ep, parsed, req, res, origModel);
      return;
    }

    // ── Image → Gemini OCR → text-backend pipeline ─────
    if (ep.type === "gemini") {
      handleImagePipeline(req, res, parsed, origModel);
      return;
    }
  });
}

function geminiToAnthropicSSE(geminiChunk, origModel, state) {
  const candidates = geminiChunk.candidates || [];
  if (candidates.length === 0) return null;

  if (!state.started) {
    state.started = true;
    return {
      type: "message_start",
      message: {
        id: "msg_" + Math.random().toString(36).substring(2, 15),
        type: "message",
        role: "assistant",
        model: origModel,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  const candidate = candidates[0];
  const parts = candidate.content?.parts || [];

  const texts = [];
  for (const part of parts) {
    if (part.text) texts.push(part.text);
  }

  if (texts.length > 0 && !state.blockStarted) {
    state.blockStarted = true;
    return {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };
  }

  if (texts.length > 0) {
    return {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: texts.join("") },
    };
  }

  const finishReason = candidate.finishReason;
  if (finishReason) {
    const events = [];
    if (state.blockStarted) {
      events.push({ type: "content_block_stop", index: 0 });
    }
    const stopReasonMap = { "STOP": "end_turn", "MAX_TOKENS": "max_tokens" };
    events.push({
      type: "message_delta",
      delta: { stop_reason: stopReasonMap[finishReason] || "end_turn", stop_sequence: null },
      usage: {
        input_tokens: geminiChunk.usageMetadata?.promptTokenCount || 0,
        output_tokens: geminiChunk.usageMetadata?.candidatesTokenCount || 0,
      },
    });
    events.push({ type: "message_stop" });
    return events;
  }

  return null;
}

// ── Startup ───────────────────────────────────────────────
function startServer() {
  const server = https.createServer(tlsOptions, handleRequest);
  // Security: Bind server to localhost only to prevent external access
  if (anyDiscoveryOn()) {
    refreshAllCatalogs();
    const timer = setInterval(refreshAllCatalogs, CATALOG_TTL_MS);
    timer.unref();
  }
server.listen(PROXY_PORT, "127.0.0.1", () => {
    const activeKey = getPrimaryTextEndpoint();
    const activeEp = ENDPOINTS[activeKey];
    console.log(`\n  Claude → Multi-Backend Proxy (HTTPS)`);
    console.log(`  Listening:    https://127.0.0.1:${PROXY_PORT}`);
    const keyNote = activeEp.apiKey || activeEp.custom ? "" : "  ⚠ no API key configured!";
    console.log(`  Text backend: ${activeEp.label}${keyNote}`);
    console.log(`  Gemini Flash: auto image/OCR routing`);
    const discovering = Object.keys(CATALOG_SOURCES).filter(discoveryOn);
    if (discovering.length) {
      console.log(`  Dynamic discovery: ${discovering.map((k) => ENDPOINTS[k].label).join(", ")}`);
    }
    for (const [key, ep] of Object.entries(ENDPOINTS)) {
      if (ep.modelMap) {
        for (const [cModel, uModel] of Object.entries(ep.modelMap)) {
          console.log(`    ${cModel} → ${uModel}`);
        }
      }
    }
    console.log("");
  });
}

startServer();
