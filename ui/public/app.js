"use strict";

// ── helpers ──────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, body) {
  const opts = body
    ? { method: "POST", headers: { "Content-Type": "application/json", "x-panel": "1" }, body: JSON.stringify(body) }
    : { headers: { "x-panel": "1" } };
  const res = await fetch(path, opts);
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok && !json.error) json.error = "HTTP " + res.status;
  return json;
}

function toast(msg, kind) {
  const node = el("div", { class: "toast " + (kind || "") }, msg);
  $("#toast").append(node);
  setTimeout(() => {
    node.style.transition = "opacity .3s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 320);
  }, kind === "err" ? 6000 : 3200);
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
}

// ── state ────────────────────────────────────────────────

let state = null;
let catalogNeedsRepaint = false;
let logLines = [];
let needsRestart = false;
const providerLabel = {};

// ── tabs ─────────────────────────────────────────────────

$$("nav.tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("nav.tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  });
});

// ── rendering ────────────────────────────────────────────

function render(s, force) {
  state = s;
  for (const p of s.providers) providerLabel[p.key] = p.label;

  const running = s.proxy.running;
  const pill = $("#status-pill");
  pill.className = "pill " + (running ? "on" : "off");
  $("#status-text").textContent = running
    ? s.proxy.managed
      ? "running · pid " + s.proxy.pid
      : "running (external process)"
    : "stopped";

  const activeLabel = s.activeProvider ? providerLabel[s.activeProvider] : "no provider configured";
  $("#backend-text").textContent = "backend: " + activeLabel;
  $("#brand-port").textContent = "https://127.0.0.1:" + s.proxy.port;
  $("#gw-url").textContent = "https://localhost:" + s.proxy.port;

  $("#btn-start").disabled = running;
  $("#btn-stop").disabled = !running;
  $("#btn-restart").disabled = !running && !s.certs.ok;

  if (catalogNeedsRepaint) {
    catalogNeedsRepaint = false;
    renderCatalog();
  }

  renderStats(s.stats);
  renderStatusRows(s);
  renderChecklist(s);
  if (force || !sectionBusy("#key-fields")) renderKeys(s);
  if (force || !sectionBusy("#provider-list")) renderProviders(s);
  if (document.activeElement !== $("#inp-port")) $("#inp-port").value = s.proxy.port;
  renderDiag(s);

  $("#log-note").textContent = running && !s.proxy.managed
    ? "The proxy is running outside this panel (start.bat, the scheduled task…), so its output never reaches here. Stop it and start it from the panel to watch live traffic."
    : "";
}

function renderStats(st) {
  const byEp = Object.entries(st.byEndpoint).sort((a, b) => b[1] - a[1]);
  const cards = [
    { n: st.requests, l: "requests" },
    { n: st.probes, l: "probes" },
    { n: st.images, l: "images" },
    { n: st.errors, l: "errors", cls: st.errors ? "err" : "" },
    { n: byEp.length ? providerLabel[byEp[0][0]] || byEp[0][0] : "—", l: "most used" },
    { n: st.lastRequestAt ? fmtTime(st.lastRequestAt) : "—", l: "last request" },
  ];
  $("#stats-grid").replaceChildren(
    ...cards.map((c) => el("div", { class: "stat " + (c.cls || "") }, el("div", { class: "n" }, c.n), el("div", { class: "l" }, c.l)))
  );
}

function row(k, ...v) {
  return el("div", { class: "row" }, el("div", { class: "k" }, k), el("div", { class: "v" }, ...v));
}

// replaceChildren() would stringify a null, so drop the conditional rows first.
function setChildren(node, children) {
  node.replaceChildren(...children.flat().filter(Boolean));
}

// The panel polls every few seconds. Never rebuild a form the user is in the
// middle of: skip while it holds focus or has unsaved edits.
function sectionBusy(sel) {
  const c = $(sel);
  if (!c) return false;
  if (c.contains(document.activeElement)) return true;
  for (const i of c.querySelectorAll("input")) {
    if (i.type === "radio") {
      if (i.checked && i.value !== (i.dataset.rendered || "")) return true;
    } else if (i.type !== "checkbox") {
      if ((i.value || "") !== (i.dataset.rendered || "")) return true;
    }
  }
  return false;
}

function renderStatusRows(s) {
  const up = s.proxy.upstream || {};
  const eps = Object.entries(s.stats.byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => (providerLabel[k] || k) + " " + n);

  setChildren($("#status-rows"), [
    row("Proxy", s.proxy.running ? el("span", { class: "tag ok" }, "up") : el("span", { class: "tag err" }, "stopped"), " ", "https://127.0.0.1:" + s.proxy.port),
    row("Managed by the panel", s.proxy.managed ? "yes · up for " + fmtDuration(s.proxy.uptimeMs) : "no"),
    row("Text backend", s.activeProvider ? providerLabel[s.activeProvider] : el("span", { class: "tag warn" }, "no key configured")),
    row("Pinned provider", s.pinnedProvider ? providerLabel[s.pinnedProvider] : "automatic (by priority)"),
    row("Backend reported", up.activeTextBackend || "—"),
    row("Keys present", s.keys.filter((k) => k.set).map((k) => k.env).join(", ") || "none"),
    row("Split", eps.length ? eps.join(" · ") : "—"),
    row(".env", s.envExists ? el("span", { class: "tag ok" }, "present") : el("span", { class: "tag err" }, "missing")),
    row("proxy-config.json", Object.keys(s.config).length ? JSON.stringify(s.config) : el("span", { class: "tag" }, "no overrides")),
    row("Node / OS", s.ui.node + " · " + s.ui.platform),
    s.stats.lastError ? row("Last error", el("span", { class: "tag err" }, fmtTime(s.stats.lastError.t)), " ", s.stats.lastError.text) : null,
  ]);
}

function renderChecklist(s) {
  const items = [];
  const textKey = s.keys.find((k) => k.set);
  const gem = s.keys.find((k) => k.key === "gemini");

  items.push({
    ok: Boolean(textKey),
    txt: textKey ? "Text provider key configured (" + textKey.label + ")" : "Add a text provider key on the Keys tab",
  });
  items.push({
    ok: Boolean(gem && gem.set),
    txt: gem && gem.set ? "Google AI Studio key configured (images/OCR)" : "Add the Google AI Studio key (used for images/OCR)",
  });
  items.push({ ok: s.certs.ok, txt: s.certs.ok ? "TLS certificates present" : "Generate the certificates on the Diagnostics tab" });
  items.push({
    ok: s.desktop.every((d) => d.matches),
    txt: s.desktop.every((d) => d.matches)
      ? "Claude Desktop points at the gateway"
      : "Write developer_settings.json on the Diagnostics tab",
  });
  items.push({ ok: s.proxy.running, txt: s.proxy.running ? "Proxy is up" : "Start the proxy" });

  $("#checklist").replaceChildren(
    ...items.map((i) =>
      el("li", {}, el("span", { class: "tag " + (i.ok ? "ok" : "warn") }, i.ok ? "done" : "pending"), " ", i.txt)
    )
  );
}

function renderKeys(s) {
  const show = $("#chk-show-keys").checked;
  setChildren(
    $("#key-fields"),
    s.keys.map((k) =>
      el(
        "label",
        { class: "field" },
        el(
          "span",
          { class: "lab" },
          k.label,
          el("small", {}, k.env),
          k.set ? el("span", { class: "tag ok" }, k.masked) : el("span", { class: "tag warn" }, "not configured"),
          k.set ? el("button", { class: "rm", type: "button", onclick: (e) => removeKey(k, e.target) }, "remove") : null,
          el("a", { href: k.url, target: "_blank", rel: "noreferrer", style: "margin-left:auto;font-size:12px;font-weight:400" }, "get a key ↗")
        ),
        k.note ? el("span", { class: "fieldnote" }, k.note) : null,
        el("input", {
          type: show ? "text" : "password",
          "data-env": k.env,
          "data-rendered": "",
          placeholder: k.set ? "•••• keep the current key" : "paste the key here",
          autocomplete: "off",
          spellcheck: "false",
        })
      )
    )
  );
}

// Clears the value in .env, keeping the line so the file stays readable.
function removeKey(k, btn) {
  if (!confirm("Remove " + k.env + " from .env?\n\nThe key is erased from the file; paste it again to restore it.")) return;
  return withBusy(btn, async () => {
    const r = await api("/api/keys", { [k.env]: "__CLEAR__" });
    if (r.error) return toast(r.error, "err");
    toast(k.label + " key removed.", "ok");
    if (state && state.proxy.running) markRestart(true);
    loadCatalog(false);
  });
}

function renderProviders(s) {
  const current = s.pinnedProvider || "auto";
  const opts = [
    { key: "auto", label: "Automatic", desc: "Follows the OpenCode Go → GLM → DeepSeek → Google priority across the configured keys.", enabled: true },
    ...s.providers.map((p) => ({
      key: p.key,
      label: p.label,
      desc: s.configuredProviders.includes(p.key) ? "Key configured." : "No key — set " + p.env + " before pinning it.",
      enabled: s.configuredProviders.includes(p.key),
    })),
  ];

  $("#provider-list").replaceChildren(
    ...opts.map((o) => {
      const input = el("input", {
        type: "radio",
        name: "provider",
        value: o.key,
        checked: o.key === current,
        disabled: !o.enabled,
        "data-rendered": current,
      });
      const wrap = el(
        "label",
        { class: "provider" + (o.key === current ? " sel" : "") + (o.enabled ? "" : " disabled") },
        input,
        el("div", {}, el("div", { class: "pl" }, o.label), el("div", { class: "pd" }, o.desc))
      );
      input.addEventListener("change", () => {
        $$("#provider-list .provider").forEach((n) => n.classList.remove("sel"));
        wrap.classList.add("sel");
      });
      return wrap;
    })
  );
}

function renderDiag(s) {
  const c = s.certs;
  setChildren($("#cert-rows"), [
    ...Object.entries(c.present).map(([f, ok]) =>
      row(f, ok ? el("span", { class: "tag ok" }, "present") : el("span", { class: "tag err" }, "missing"))
    ),
    c.expires
      ? row(
          "Valid until",
          c.daysLeft > 30
            ? el("span", { class: "tag ok" }, c.daysLeft + " days")
            : el("span", { class: "tag warn" }, c.daysLeft + " days"),
          " ",
          c.expires
        )
      : null,
    c.subject ? row("Subject", c.subject.replace(/\n/g, " · ")) : null,
  ]);

  setChildren($("#desktop-rows"), [
    ...s.desktop.map((d) =>
      row(
        d.path.split(/[\\/]/).slice(-2).join("/"),
        d.matches
          ? el("span", { class: "tag ok" }, "ok")
          : d.exists
          ? el("span", { class: "tag warn" }, d.error || "gateway: " + (d.gateway || "not set"))
          : el("span", { class: "tag err" }, "does not exist"),
        " ",
        d.path
      )
    ),
  ]);
}

// ── Provider catalogs ──────────────────────────────
// One card per text provider: its own discovery switch, its own model list.

let catalog = { providers: [], port: 8877, desktop: {} };

function claudeIdFor(m) {
  return "claude-" + String(m).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function enabledSetFor(p) {
  return p.enabled === null ? new Set(p.models) : new Set(p.enabled);
}

// A model already mapped by hand in proxy/server.js for this provider.
function isStaticallyMapped(providerKey, upstreamModel) {
  const map = (state && state.models && state.models[providerKey]) || {};
  return Object.values(map).some((info) => info.current === upstreamModel);
}

function renderCatalog() {
  const total = catalog.providers.reduce((n, p) => n + p.models.length, 0);
  $("#catalog-badge").textContent = total || "—";

  const pricing = catalog.pricing || {};
  $("#pricing-note").textContent = pricing.error
    ? "Cost data unavailable (" + pricing.error + ") — the provider APIs do not report pricing."
    : pricing.fetchedAt
    ? "Cost and free-tier labels come from models.dev; the provider APIs do not report pricing."
    : "";

  const upstream = (state && state.proxy.upstream && state.proxy.upstream.catalog) || {};
  const active = state && state.activeProvider;

  setChildren(
    $("#catalog-cards"),
    catalog.providers.map((p) => providerCard(p, upstream[p.key], p.key === active))
  );
}

// Collapsed state is a per-viewer convenience, so it lives in localStorage.
function isCollapsed(key, isActive) {
  try {
    const raw = localStorage.getItem("cdp.collapsed." + key);
    if (raw !== null) return raw === "1";
  } catch {
    /* storage can be blocked */
  }
  return !isActive; // by default only the active backend starts open
}

function setCollapsed(key, value) {
  try {
    localStorage.setItem("cdp.collapsed." + key, value ? "1" : "0");
  } catch {
    /* storage can be blocked */
  }
}

function providerCard(p, live, isActive) {
  const on = enabledSetFor(p);
  const filter = $("#catalog-filter").value.trim().toLowerCase();
  const freeCount = p.models.filter((m) => p.pricing && p.pricing[m] && p.pricing[m].free).length;

  const discovery = el("input", { type: "checkbox", checked: p.discovery, disabled: !p.hasKey });
  discovery.addEventListener("change", () => saveCatalog(p, { discovery: discovery.checked }, discovery));

  // Master switch: flips every model of this provider at once. Half-checked
  // whenever only some of them are on.
  const master = el("input", { type: "checkbox", disabled: !p.hasKey || !p.models.length });

  const syncMaster = () => {
    const boxes = $$('#catalog-cards input[data-provider="' + p.key + '"]');
    const checked = boxes.filter((b) => b.checked).length;
    master.checked = boxes.length > 0 && checked === boxes.length;
    master.indeterminate = checked > 0 && checked < boxes.length;
  };

  const setAll = (value) => {
    for (const box of $$('#catalog-cards input[data-provider="' + p.key + '"]')) {
      box.checked = value;
      box.closest("tr").classList.toggle("off", !value);
    }
    syncMaster();
  };

  master.addEventListener("change", () => setAll(master.checked));

  const chevron = el("span", { class: "chev" }, "\u25be");
  const title = el(
    "button",
    { class: "collapser", type: "button" },
    chevron,
    el("span", { class: "ctitle" }, p.label),
    isActive ? el("span", { class: "tag ok" }, "active backend") : null,
    p.hasKey ? null : el("span", { class: "tag warn" }, "no " + p.env),
    freeCount ? el("span", { class: "tag info" }, freeCount + " free") : null
  );

  const head = el(
    "div",
    { class: "card-head" },
    el(
      "div",
      {},
      title,
      el(
        "p",
        { class: "hint" },
        p.hasKey
          ? p.error
            ? "Catalog error: " + p.error
            : p.models.length + " models · fetched at " + (p.fetchedAt ? fmtTime(p.fetchedAt) : "—") +
              (p.enabled === null ? " · all exposed" : " · " + on.size + " exposed") +
              (live ? " · running proxy: " + (live.discovery ? live.count + " ids" : "discovery off") : "")
          : "Add " + p.env + " on the Keys tab to pull this catalog."
      )
    ),
    el("label", { class: "switch" }, master, el("span", {}, "select all")),
    el("label", { class: "switch" }, discovery, el("span", {}, "discovery"))
  );

  if (!p.hasKey || !p.models.length) {
    // Nothing to fold away, so the chevron would be a dead control.
    chevron.style.visibility = "hidden";
    title.style.cursor = "default";
    return el("div", { class: "card" }, head);
  }

  const rows = p.models
    .filter((m) => !filter || m.includes(filter) || (p.ids[m] || "").includes(filter))
    .map((m) => {
      const checked = on.has(m);
      const cost = p.pricing && p.pricing[m];
      const box = el("input", { type: "checkbox", "data-model": m, "data-provider": p.key, checked: checked });
      const tr = el(
        "tr",
        { class: checked ? "" : "off" },
        el("td", { class: "tight" }, box),
        el(
          "td",
          {},
          m,
          cost && cost.free ? el("span", { class: "tag ok", style: "margin-left:8px" }, "free") : null
        ),
        idCell(p, m),
        el(
          "td",
          {},
          cost && !cost.free
            ? el("span", { class: "cost", title: "models.dev: $/M tokens" }, "$" + cost.input + " / $" + cost.output)
            : isStaticallyMapped(p.key, m)
            ? el("span", { class: "tag info" }, "static map")
            : ""
        )
      );
      box.addEventListener("change", () => {
        tr.classList.toggle("off", !box.checked);
        syncMaster();
      });
      return tr;
    });

  // Twelve rows fit; the rest scrolls inside the card instead of stretching it.
  const table = el(
    "div",
    { class: "table-scroll model-window" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el("tr", {}, el("th", { style: "width:44px" }, ""), el("th", {}, "model on " + p.label), el("th", {}, "id in Claude Desktop"), el("th", {}, "cost / map"))
      ),
      el("tbody", {}, ...(rows.length ? rows : [el("tr", {}, el("td", { colspan: "4", class: "empty" }, "Nothing matches the filter."))]))
    )
  );

  const actions = el(
    "div",
    { class: "actions", style: "margin-top:14px" },
    el("button", { class: "primary sm", onclick: (e) => saveSelection(p, e.target) }, "Save selection"),
    el("span", { class: "spacer" }),
    el("button", { class: "sm ghost", onclick: (e) => refreshCatalog(e.target) }, "Refresh")
  );

  const body = el("div", { class: "card-body" }, table, actions);
  const card = el("div", { class: "card" }, head, body);

  const collapsed = isCollapsed(p.key, isActive);
  const apply = (value) => {
    card.classList.toggle("collapsed", value);
    body.hidden = value;
    chevron.textContent = value ? "\u25b8" : "\u25be";
    title.setAttribute("aria-expanded", String(!value));
  };
  apply(collapsed);
  title.addEventListener("click", () => {
    const next = !card.classList.contains("collapsed");
    apply(next);
    setCollapsed(p.key, next);
  });

  queueMicrotask(syncMaster);
  return card;
}

// The id cell: a fixed "claude-" prefix plus an editable suffix. The pencil
// only shows on hover (CSS); clicking it swaps the text for an input.
function idCell(p, model) {
  const td = el("td", { class: "idcell" });

  const paint = () => {
    const id = p.ids[model] || claudeIdFor(model);
    const custom = id !== claudeIdFor(model);
    td.replaceChildren(
      el(
        "span",
        { class: "idview" + (custom ? " custom" : "") },
        el("span", { class: "idfix" }, "claude-"),
        el("span", { class: "idsuf" }, id.replace(/^claude-/, "")),
        el("button", { class: "pencil", title: "rename", onclick: edit }, "\u270e")
      )
    );
  };

  const commit = (raw) => {
    const suffix = String(raw)
      .toLowerCase()
      .replace(/^claude-/, "")
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!suffix) {
      toast("Empty id — kept the previous one.", "err");
      return paint();
    }
    const next = "claude-" + suffix;
    // Ids have to be unique across every provider: Claude Desktop sees one list.
    for (const other of catalog.providers) {
      const clash = Object.entries(other.ids).find(([m, id]) => id === next && !(other.key === p.key && m === model));
      if (clash) {
        toast("That id is already used by " + clash[0] + " (" + other.label + ").", "err");
        return paint();
      }
    }
    p.ids[model] = next;
    paint();
  };

  function edit() {
    const id = p.ids[model] || claudeIdFor(model);
    const input = el("input", { type: "text", class: "idinput", value: id.replace(/^claude-/, ""), spellcheck: "false" });
    td.replaceChildren(el("span", { class: "idedit" }, el("span", { class: "idfix" }, "claude-"), input));
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      save ? commit(input.value) : paint();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  paint();
  return td;
}

async function saveCatalog(p, payload, btn) {
  const r = await api("/api/catalog/save", { provider: p.key, ...payload });
  if (r.error) {
    toast(r.error, "err");
    return false;
  }
  if ("discovery" in payload) {
    p.discovery = payload.discovery;
    toast(p.label + ": discovery " + (payload.discovery ? "enabled" : "disabled") + ".", "ok");
  }
  if (state && state.proxy.running) markRestart(true);
  refresh(true);
  return true;
}

async function saveSelection(p, btn) {
  await withBusy(btn, async () => {
    const boxes = $$('#catalog-cards input[data-provider="' + p.key + '"]');
    // A filtered view must not silently drop the models it is hiding.
    const shown = new Set(boxes.map((i) => i.dataset.model));
    const prev = enabledSetFor(p);
    const picked = p.models.filter((m) => (shown.has(m) ? boxes.find((i) => i.dataset.model === m).checked : prev.has(m)));
    const all = picked.length === p.models.length;

    const ids = {};
    for (const m of p.models) {
      const id = p.ids[m];
      if (id && id !== claudeIdFor(m)) ids[m] = id;
    }

    const r = await api("/api/catalog/save", { provider: p.key, enabled: all ? null : picked, ids });
    if (r.error) return toast(r.error, "err");
    p.enabled = all ? null : picked;
    const renamed = Object.keys(ids).length;
    toast(
      p.label + ": " + (all ? "whole catalog enabled" : picked.length + " models enabled") +
        (renamed ? " · " + renamed + " id(s) renamed" : "") + ".",
      "ok"
    );
    if (state && state.proxy.running) markRestart(true);
    renderCatalog();
  });
}

async function loadCatalog(force) {
  const r = force ? await api("/api/catalog", {}) : await api("/api/catalog");
  if (r.error && !r.providers) return toast(r.error, "err");
  catalog = {
    providers: r.providers || [],
    port: r.port || 8877,
    desktop: r.desktop || {},
    pricing: r.pricing || {},
  };
  if (!state) catalogNeedsRepaint = true;
  renderCatalog();
}

function refreshCatalog(btn) {
  return withBusy(btn, async () => {
    await loadCatalog(true);
    const errors = catalog.providers.filter((p) => p.hasKey && p.error);
    if (errors.length) toast(errors.map((p) => p.label + ": " + p.error).join(" · "), "err");
    else toast(catalog.providers.reduce((n, p) => n + p.models.length, 0) + " models across the configured providers.", "ok");
  });
}

$("#catalog-filter").addEventListener("input", renderCatalog);
$("#btn-catalog-refresh").addEventListener("click", (e) => refreshCatalog(e.target));

// Claude Desktop imports the whole gateway block, not a bare array - without
// this header the import is rejected. Labels and tiers already set in the app
// are preserved for ids it already knows.
$("#btn-catalog-copy").addEventListener("click", async () => {
  const known = (catalog.desktop && catalog.desktop.models) || {};
  const seen = new Set();
  const inferenceModels = [];

  // Active provider first: if two providers serve the same model name, the one
  // that actually answers keeps the id.
  const order = [...catalog.providers].sort((a, b) => {
    const active = state && state.activeProvider;
    return (b.key === active) - (a.key === active);
  });

  for (const p of order) {
    if (!p.hasKey) continue;
    const on = enabledSetFor(p);
    for (const m of p.models) {
      if (!on.has(m)) continue;
      const name = p.ids[m] || claudeIdFor(m);
      if (seen.has(name)) continue;
      seen.add(name);
      const prev = known[name] || {};
      const entry = {
        name,
        labelOverride: prev.labelOverride || m,
        anthropicFamilyTier: prev.anthropicFamilyTier || "sonnet",
      };
      if (prev.isFamilyDefault) entry.isFamilyDefault = true;
      inferenceModels.push(entry);
    }
  }

  const payload = {
    inferenceGatewayBaseUrl: "https://localhost:" + (catalog.port || 8877),
    inferenceGatewayApiKey: (catalog.desktop && catalog.desktop.apiKey) || "proxy-local-key",
    modelDiscoveryEnabled: false,
    inferenceModels,
  };

  const text = JSON.stringify(payload, null, 2);
  const out = $("#catalog-out");
  out.hidden = false;
  out.textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    toast("Config copied (" + inferenceModels.length + " models).", "ok");
  } catch {
    // Clipboard access can be refused; select the fallback so Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents(out);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Could not reach the clipboard — the JSON below is selected, press Ctrl+C.", "err");
  }
});

// ── logs ─────────────────────────────────────────────────

function logMatches(line) {
  if (!$("#chk-probes").checked && line.level === "probe") return false;
  const f = $("#log-filter").value.trim().toLowerCase();
  return !f || line.text.toLowerCase().includes(f);
}

function lineNode(line) {
  return el("div", { class: "line " + line.level }, el("span", { class: "ts" }, fmtTime(line.t)), el("span", { class: "tx" }, line.text));
}

function renderLogs() {
  const box = $("#log");
  const visible = logLines.filter(logMatches);
  if (!visible.length) {
    box.replaceChildren(
      el("div", { class: "empty" }, logLines.length ? "Nothing matches the filter." : "No logs yet. Start the proxy from this panel to capture its output.")
    );
    return;
  }
  box.replaceChildren(...visible.map(lineNode));
  if ($("#chk-follow").checked) box.scrollTop = box.scrollHeight;
  $("#logs-badge").textContent = logLines.length;
}

function appendLog(line) {
  logLines.push(line);
  if (logLines.length > 800) logLines = logLines.slice(-800);
  $("#logs-badge").textContent = logLines.length;
  if (!logMatches(line)) return;
  const box = $("#log");
  const empty = box.querySelector(".empty");
  if (empty) empty.remove();
  box.append(lineNode(line));
  while (box.children.length > 800) box.firstChild.remove();
  if ($("#chk-follow").checked) box.scrollTop = box.scrollHeight;
}

function connectStream() {
  const es = new EventSource("/api/logs/stream");
  es.addEventListener("backlog", (e) => {
    logLines = JSON.parse(e.data);
    renderLogs();
  });
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener("stats", (e) => {
    if (state) {
      state.stats = JSON.parse(e.data);
      renderStats(state.stats);
      renderStatusRows(state);
    }
  });
  es.addEventListener("clear", () => {
    logLines = [];
    renderLogs();
  });
  es.addEventListener("state", () => refresh());
  es.onerror = () => {
    /* EventSource reconnects on its own */
  };
}

// ── actions ──────────────────────────────────────────────

async function refresh(force) {
  try {
    const s = await api("/api/state");
    if (s.error) return toast(s.error, "err");
    render(s, force === true);
  } catch {
    $("#status-pill").className = "pill off";
    $("#status-text").textContent = "panel offline";
  }
}

function markRestart(needed) {
  needsRestart = needed;
  $("#restart-banner").classList.toggle("show", needed);
}

async function withBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await fn();
  } finally {
    btn.textContent = label;
    btn.disabled = false;
    refresh(true);
  }
}

$("#btn-start").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const r = await api("/api/proxy/start", {});
    r.ok ? toast("Proxy started.", "ok") : toast(r.error || "Failed.", "err");
    if (r.ok) markRestart(false);
  })
);

$("#btn-stop").addEventListener("click", (e) => {
  if (state && state.proxy.running && !state.proxy.managed) {
    const ok = confirm(
      "The proxy on port " +
        state.proxy.port +
        " was not started by this panel.\n\nStop it anyway? The process will be force-killed."
    );
    if (!ok) return;
  }
  withBusy(e.target, async () => {
    const r = await api("/api/proxy/stop", {});
    r.ok ? toast("Proxy stopped.", "ok") : toast(r.error || "Failed.", "err");
  });
});

const restart = (e) =>
  withBusy(e.target, async () => {
    const r = await api("/api/proxy/restart", {});
    r.ok ? toast("Proxy restarted.", "ok") : toast(r.error || "Failed.", "err");
    if (r.ok) markRestart(false);
  });
$("#btn-restart").addEventListener("click", restart);
$("#banner-restart").addEventListener("click", restart);

$("#btn-save-keys").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const body = {};
    for (const input of $$("#key-fields input[data-env]")) {
      if (input.value.trim()) body[input.dataset.env] = input.value.trim();
    }
    if (!Object.keys(body).length) return toast("No new key to save.");
    const r = await api("/api/keys", body);
    if (r.error) return toast(r.error, "err");
    toast("Saved: " + r.changed.join(", "), "ok");
    $$("#key-fields input[data-env]").forEach((i) => (i.value = ""));
    if (state && state.proxy.running) markRestart(true);
  })
);

$("#chk-show-keys").addEventListener("change", () => state && renderKeys(state));

$("#btn-save-provider").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const sel = $("#provider-list input:checked");
    const r = await api("/api/config", { provider: sel ? sel.value : "auto" });
    if (r.error) return toast(r.error, "err");
    toast("Provider saved.", "ok");
    if (state && state.proxy.running) markRestart(true);
  })
);

$("#btn-save-port").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const r = await api("/api/config", { port: Number($("#inp-port").value) });
    if (r.error) return toast(r.error, "err");
    toast("Port saved. Update Claude Desktop as well.", "ok");
    if (state && state.proxy.running) markRestart(true);
  })
);

$("#btn-clear-log").addEventListener("click", async () => {
  await api("/api/logs/clear", {});
  logLines = [];
  renderLogs();
});

$("#btn-clear-stats").addEventListener("click", async () => {
  await api("/api/logs/clear", {});
  logLines = [];
  renderLogs();
  refresh();
});

$("#log-filter").addEventListener("input", renderLogs);
$("#chk-probes").addEventListener("change", renderLogs);

function runScript(btn, script, outSel, okMsg) {
  return withBusy(btn, async () => {
    const r = await api("/api/run", { script });
    const out = $(outSel);
    out.hidden = false;
    out.textContent = r.output || r.error || "(no output)";
    r.ok ? toast(okMsg, "ok") : toast("Failed — see the output below.", "err");
  });
}

$("#btn-gen-certs").addEventListener("click", (e) => runScript(e.target, "certs", "#cert-out", "Certificates generated."));
$("#btn-install-ca").addEventListener("click", (e) => runScript(e.target, "install-ca", "#cert-out", "CA installed."));
$("#btn-test").addEventListener("click", (e) => runScript(e.target, "test", "#test-out", "Test finished."));

$("#btn-write-desktop").addEventListener("click", (e) => {
  if (!confirm("Overwrite the Claude Desktop developer_settings.json?\n\nA .bak backup is written first.")) return;
  withBusy(e.target, async () => {
    const r = await api("/api/desktop/write", {});
    r.ok ? toast("Configuration written. Restart Claude Desktop.", "ok") : toast(r.error || "Failed.", "err");
  });
});

// ── boot ─────────────────────────────────────────────────

refresh();
loadCatalog(false);
connectStream();
setInterval(refresh, 5000);
