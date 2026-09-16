<div align="center">

<img src="assets/logo.svg" width="104" alt="Patchbay logo">

# Patchbay

**A local gateway that lets Claude Desktop run on other models.**

Point the app at a proxy on your own machine and its model picker fills up with
OpenCode Go, OpenRouter, DeepSeek, GLM, Google AI Studio and anything you run
locally — including free models — while the interface, the tools and the
workflow stay exactly as they are.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-5fa04e)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-8957e5)
![Platforms](https://img.shields.io/badge/windows%20%C2%B7%20macos%20%C2%B7%20linux-supported-6e7781)

</div>

---

## What it is

Claude Desktop can be told to send its inference to a **gateway** instead of
Anthropic's API. Patchbay is that gateway, running on `localhost`: it accepts
Anthropic-format requests, translates them, and forwards them to whichever
provider you configured.

```
                                   ┌─→ OpenCode Go       45 models, 8 of them free
Claude Desktop                     │
      │  HTTPS                     ├─→ OpenRouter        432 models, 20 free
      ▼                            │
https://127.0.0.1:8877  ──────────►├─→ DeepSeek · GLM (Z.ai)
   Patchbay proxy                  │
      ▲                            ├─→ Google AI Studio  text + images
      │                            │
http://127.0.0.1:8878              └─→ your own endpoint  Ollama · LM Studio · vLLM · …
   Patchbay panel  ── start/stop · keys · models · live logs · diagnostics
```

One text provider answers at a time. Images are always handled by Google —
directly when it is also the text backend, through an OCR hand-off otherwise.

## Highlights

- **Web control panel.** Start and stop the proxy, write API keys, pick the
  provider, browse model catalogs, watch traffic live, generate certificates
  and configure Claude Desktop — without touching a config file.
- **Live model catalogs.** Each provider is asked what it currently serves, and
  every model is published as a `claude-…` id that Claude Desktop accepts. No
  hand-maintained lists that rot the week a provider renames something.
- **Free models surfaced.** The free tiers on OpenCode and OpenRouter are
  discovered and labelled, with the cost of every other model next to it.
- **Bring your own endpoint.** Anything that speaks the OpenAI API — Ollama,
  LM Studio, vLLM, llama.cpp, a company gateway — is added from the panel, over
  plain http on localhost if that is where it lives, with no key required.
- **Zero dependencies.** Node's standard library only — no `npm install`, no
  lockfile to audit, nothing to keep patched.
- **Local by construction.** Both servers bind to `127.0.0.1`, no CORS headers
  are sent, and API keys never leave your machine except to their own provider.

---

## Requirements

| | |
|---|---|
| **Node.js 18+** | `node --version`. The setup scripts install it on Windows via winget if missing. |
| **Claude Desktop** | Already installed and updated. |
| **A text provider** | A key for [OpenCode Go](https://opencode.ai) · [OpenRouter](https://openrouter.ai/keys) · [DeepSeek](https://platform.deepseek.com) · [GLM / Z.ai](https://z.ai) · [Google AI Studio](https://aistudio.google.com/apikey), **or** a local server such as Ollama or LM Studio, which needs no key at all. One of them is enough; configure several and switch in the panel. |
| **A Google AI Studio key** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free tier, no card. It handles images whichever provider answers the text, so it is worth having even when it is not your text backend. |

---

## Quick start

```bash
git clone https://github.com/Grekto-dev/patchbay.git
cd patchbay
```

**Windows**

```cmd
setup.bat
```

**macOS / Linux**

```bash
chmod +x setup.sh && ./setup.sh
```

The setup script asks for your keys, generates the TLS certificates, installs
the local CA, writes Claude Desktop's config and starts the proxy. When it is
done, open the panel:

```cmd
panel.bat          :: Windows (double-click works too)
```
```bash
./panel.sh         # macOS / Linux
```

Everything the script does can also be done from the panel, so if you prefer to
skip the script entirely, run `panel.bat` / `./panel.sh` on a fresh clone and
work through the **Getting started** checklist on the Status tab.

---

## Setting up Claude Desktop

Two steps happen inside the app itself and cannot be automated.

### 1. Enable Developer Mode

Open Claude Desktop **without signing in** — stay on the login screen. Then, in
the menu at the **top left** of the window:

> **Help → Troubleshooting → Enable Developer Mode**

The app will ask to restart. Let it.

### 2. Configure third-party inference

Back in the same top-left menu, a new entry has appeared:

> **Developer → Configure third-party inference**

Fill in:

| Field | Value |
|---|---|
| Inference provider | `Gateway` |
| Gateway base URL | `https://localhost:8877` |
| Gateway API key | `proxy-local-key` |
| Auth scheme | `Bearer` |

Then the **model list**. Either add entries by hand — the id has to belong to
one of the Anthropic families (see [Model ids](#model-ids)), while the display
name is free — or use the panel's **Export to Claude Desktop** button (Models
tab), which copies a ready-to-import block:

```json
{
  "inferenceGatewayBaseUrl": "https://localhost:8877",
  "inferenceGatewayApiKey": "proxy-local-key",
  "modelDiscoveryEnabled": false,
  "inferenceModels": [
    { "name": "claude-opus-3", "labelOverride": "kimi-k3", "anthropicFamilyTier": "opus" }
  ]
}
```

Paste it into the **Import** field on that same screen. The header keys matter —
importing a bare array is rejected.

Click **Apply locally**, quit Claude Desktop completely (tray icon included),
and reopen it. Your models are in the picker.

> **Tip.** Setting `modelDiscoveryEnabled` to `true` makes Claude Desktop read
> the model list from the gateway's `/v1/models` by itself, so the catalog
> follows your providers with no further imports. You lose the custom display
> names and tier grouping, which is why the export defaults it to `false`.

---

## The control panel

`http://127.0.0.1:8878` — five tabs.

| Tab | What lives there |
|---|---|
| **Status** | Proxy up/down, active backend, request / probe / image / error counters, per-backend split, and a checklist of what is still missing. |
| **Keys & provider** | Write or remove API keys (stored in `.env`, shown masked), pin a text provider instead of relying on priority, change the proxy port. |
| **Models** | One card per provider: switch the provider on or off, toggle discovery, pick which models to expose (with a live counter and a select-all in the table header), rename their ids, export the Claude Desktop config. |
| **Live logs** | The proxy's output, colour-coded and filterable — requests, images, probes, errors. |
| **Diagnostics** | Certificate status and chain, install / reissue / remove the CA, write `developer_settings.json`, run the connectivity test. |

Start / Stop / Restart run the proxy as a child process, which is how its output
reaches the log tab. A proxy started elsewhere (`start.bat`, a scheduled task)
is still detected and can be stopped from the panel — the panel simply cannot
show its output.

To drive a different checkout from one panel:

```bash
PROXY_ROOT=/path/to/other/patchbay node ui/server.js
```

`UI_PORT=8879 node ui/server.js` moves the panel itself.

---

## Models

### Model ids

Claude Desktop only accepts ids in its own families — **haiku, sonnet, opus,
fable, mythos** — but it does not care about the version part: `claude-sonnet-3`
and `claude-sonnet-3-7` are both fine. The display name and the tier are
resolved on its side, so the proxy only needs to agree with it on which ids
exist and where each one points.

Patchbay handles that naming itself. With **discovery** on for a provider, it
asks for the catalog at startup and every 30 minutes, then publishes each model
as `claude-<family>-<version>`, ten per version: `claude-opus-3`,
`claude-opus-3-1` … `claude-opus-3-9`, then `claude-opus-4`. The family comes
from the price per million input tokens:

| Family | When |
|---|---|
| `haiku` | free, or at most $0.30/M |
| `sonnet` | up to $2/M |
| `opus` | above $2/M |
| `fable` | no pricing data — a local endpoint, an unlisted model |

So `big-pickle` (free) becomes `claude-haiku-3-16`, `kimi-k3` ($3/M) becomes
`claude-opus-3`. The numbering is global: every provider draws from the same
counters, so two of them never collide in the one list Claude Desktop sees.

Ids are **renumbered whenever the selection changes** — untick a model and the
ones after it move up to fill the gap. Click the padlock on a row to pin its id
in place, or rename it (a rename pins it too): pinned ids are kept in
`proxy-config.json` and the generated ones are recomputed around them.

| Provider | Catalog endpoint |
|---|---|
| OpenCode | `/zen/go/v1/models` **and** `/zen/v1/models` on `opencode.ai`, merged |
| DeepSeek | `https://api.deepseek.com/models` |
| GLM (Z.ai) | `https://api.z.ai/api/coding/paas/v4/models`, falling back to `/api/paas/v4/models` |
| OpenRouter | `https://openrouter.ai/api/v1/models` |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/models` |
| Custom provider | `<your base URL>/models` |

Discovery is optional. With it off, the static maps in `proxy/server.js` apply:

| Claude Desktop id | OpenCode Go | OpenRouter | DeepSeek | GLM | Google |
|---|---|---|---|---|---|
| `claude-sonnet-4-5` / `-4-6` | `deepseek-v4-flash` | `openrouter/auto` | `deepseek-v4-flash` | `glm-5-turbo` | `gemini-3.6-flash` |
| `claude-opus-4-7` | `deepseek-v4-flash` | `openrouter/auto` | `deepseek-v4-pro` | `glm-5.2` | `gemini-3.8-flash` |
| `claude-haiku-4-5-20251001` | `deepseek-v4-flash` | `openrouter/free` | `deepseek-v4-flash` | `glm-4.5-air` | `gemini-3.1-flash-lite` |

A custom provider ships no static map: turn discovery on, or map its ids by
hand in `proxy-config.json`.

Provider lineups move fast — the GLM ids above are inherited from upstream and
may already be gone. Turning discovery on is the maintenance-free option.

### Free models

Most provider APIs return ids and nothing else: no price, no free flag. Costs
then come from [models.dev](https://models.dev), the model database OpenCode
itself maintains, where a model counts as free when input and output both cost
0. **OpenRouter is the exception** — it reports pricing and modalities in its
own `/models` response, so its numbers come straight from the source and its
catalog keeps the text models without outside help — 432 of the 445 it lists,
dropping the ones that answer in audio (Lyria, gpt-audio) or whose primary
output is an image. Free models get a `free` tag; everything else shows `$in / $out` per
million tokens.

OpenCode is a special case: one key reaches **two** surfaces with different
models, and the free ones only exist on the non-Go surface. Patchbay merges the
two — everything from the Go plan, and **only the free models** from the other,
since anything paid there is already covered by Go — and routes each model back
to the base it came from. At the time of writing that is 45 models, 8 of them
free.

### The Models table

Each provider card lists what it serves, twelve rows at a time:

| Column | |
|---|---|
| ☑ | Whether the model is exposed. Unticked means no id and nothing in the picker. |
| **name in Claude Desktop** | What the picker shows. Defaults to the provider's own model name; click the pencil to change it. |
| **model on …** | The upstream name, as the provider reports it. |
| **id in Claude Desktop** | The generated id. The pencil edits it — still inside one of the five families. |
| 🔓 | Pin the id so the renumbering leaves it alone. |
| **cost / map** | `$in / $out` per million tokens, or the `static map` tag. |

Click any of the three text headers to sort by it: ascending, descending, then
back to the catalog order. Above the cards, a search box matches names, models
and ids, and the selects filter by provider, selection, price, family, id
origin and mapping.

Whenever the ids change — a provider added models, you ticked or unticked
something, you renamed one — re-run **Export to Claude Desktop** and import it
again, so the app's list and the proxy agree. The export carries only the
models that are ticked, from providers whose discovery is on: anything else
would be an entry the proxy cannot answer.

### Switching a provider off

The **provider** switch in a card's header takes the whole provider out of
circulation: nothing is routed to it, its catalog is not fetched, none of its
ids are published, and the remaining providers are renumbered around it. The
key stays in `.env` and the model selection is kept, so flipping it back
restores exactly what was there — it is written as `providersOff` in
`proxy-config.json`, and like every other setting it needs a proxy restart.

Useful when a provider is rate-limited, down, or simply in the way: switching
it off is reversible and leaves no half-configured state behind. Re-export the
model list afterwards, since the ids of everything else move.

---

## OpenRouter

Add `OPENROUTER_API_KEY` on the Keys tab and turn discovery on: 432 text models
in one catalog, priced by the request, with about twenty of them free. The
static map uses OpenRouter's own routers rather than pinning a vendor model —
`openrouter/auto` picks per request and `openrouter/free` stays on the zero-cost
pool — so the defaults keep working as the catalog changes underneath.

Requests carry the optional `HTTP-Referer` and `X-Title` headers OpenRouter uses
for its public rankings.

---

## Custom providers: Ollama, LM Studio, and anything OpenAI-compatible

If it serves `POST /chat/completions` and `GET /models` in the OpenAI shape,
Patchbay can use it. Add it under **Keys & provider → Custom providers**:

| Field | Example |
|---|---|
| Id | `ollama` — lowercase, used in the config and in the log |
| Name | `Ollama (local)` — what the panel shows |
| Base URL | `http://127.0.0.1:11434/v1` — the base that holds `/chat/completions` and `/models` |
| API key | usually empty for a local server |

Common bases: **Ollama** `http://127.0.0.1:11434/v1`, **LM Studio**
`http://127.0.0.1:1234/v1`, **vLLM** `http://127.0.0.1:8000/v1`,
**llama.cpp server** `http://127.0.0.1:8080/v1`.

Saved entries land in `proxy-config.json`:

```json
{
  "customProviders": [
    { "key": "ollama", "label": "Ollama (local)", "baseUrl": "http://127.0.0.1:11434/v1" }
  ]
}
```

Notes worth knowing:

- **Plain http is fine.** Local endpoints are reached over http on their own
  port; only the gateway Claude Desktop talks to needs TLS.
- **No key, no problem.** A provider without credentials is still selectable and
  discoverable — "configured" does not mean "has a key". When one is needed it
  goes to `.env` as `PATCHBAY_<ID>_API_KEY`, alongside every other secret.
- **Last in priority.** Custom providers sit after the built-ins, so adding one
  never silently takes over from a configured cloud provider. Pin it in the
  panel to make it answer.
- **Discovery is the practical path.** There is no built-in model map for an
  endpoint whose models only you know about.
- **Removing one cleans up after itself** — its entry, its key and any model
  selection or pin that referenced it.

---

## Google AI Studio as a text provider

Gemini is not only the image backend. Pin **Google AI Studio** on the Keys tab
(or configure no other provider key) and it answers everything — with its own
discovered catalog, so a specific Gemini model stays reachable by id even while
another provider handles the rest.

Google lists image, music, speech and agent-only models side by side with the
chat ones, all under `generateContent`, with no modality field to tell them
apart. Patchbay filters the catalog down to text models: the Nano Banana /
`*-image` family, Lyria (music), TTS and transcribe, Omni, Robotics-ER,
Computer Use and `antigravity-*` / `deep-research-*` are dropped — the last two
answer `This model only supports Interactions API` anyway. The whole
`gemini-2.5-*` family is dropped too: Google retired it for new keys (404,
"no longer available to new users") while still advertising it in the API.

The rule lives in `isTextModel()` in both `proxy/server.js` and `ui/server.js`;
widen it there if Google ships a category this misses.

Two things to know about the free tier:

- **Pro models answer 429.** `gemini-pro-latest` and `gemini-3.1-pro-preview`
  are out of quota on a free key, which is why the defaults stay on Flash.
  Discovery still lists them — pick one if your key has the quota.
- **The `-latest` aliases currently resolve to thinking models.** Asking
  `gemini-flash-latest` for a one-word answer took 53 seconds and spent the
  entire token budget on thoughts before replying. The concrete ids in the
  table above answer in about two seconds.

---

## Images

```
image in the request
        │
        ├── Google is the text backend ──→ sent straight to Gemini (multimodal)
        │
        └── another provider answers ────→ Gemini describes it, the description
                                           is injected into the prompt, and the
                                           text provider writes the reply
```

Supported formats: JPEG, PNG, WEBP, HEIC, HEIF.

---

## Configuration

### `.env`

Written by the setup script or the panel; one key per provider.

```env
OPENCODE_API_KEY=...     # https://opencode.ai
OPENROUTER_API_KEY=...   # https://openrouter.ai/keys
GLM_API_KEY=...          # https://z.ai
DEEPSEEK_API_KEY=...     # https://platform.deepseek.com
GEMINI_API_KEY=...       # https://aistudio.google.com/apikey
PATCHBAY_OLLAMA_API_KEY= # only if that custom provider needs one
```

With more than one configured, priority is **OpenCode Go → OpenRouter → GLM →
DeepSeek → Google AI Studio**, and custom providers come after those. Pinning a
provider in the panel overrides the order.

### `proxy-config.json`

Optional, gitignored, written by the panel and read by the proxy at startup.
Delete it to return to the built-in defaults. Nothing here rewrites
`proxy/server.js`.

```jsonc
{
  "port": 8877,                       // proxy port
  "provider": "gemini",               // pinned text provider
  "discovery": {                      // pull live catalogs
    "opencode": true,
    "gemini": true
  },
  "providersOff": {                   // switched off entirely: no routing, no ids
    "deepseek": true
  },
  "catalogEnabled": {                 // omit a provider to expose its whole catalog
    "deepseek": ["deepseek-v4-pro"]
  },
  "catalogIds": {                     // renamed ids
    "opencode": { "minimax-m3": "claude-minimax-m3-turbo" }
  },
  "models": {                         // hand-written entries; these win over discovery
    "glm": { "claude-sonnet-4-5": "glm-5.3" }
  },
  "customProviders": [                // OpenAI-compatible endpoints of your own
    { "key": "ollama", "label": "Ollama (local)", "baseUrl": "http://127.0.0.1:11434/v1" }
  ]
}
```

---

## Running and stopping

```cmd
panel.bat                 :: control panel (recommended — it can start the proxy)
start.bat                 :: proxy only
node proxy/server.js      :: proxy only, any platform
```

```cmd
taskkill /f /im node.exe           :: Windows
```
```bash
pkill -f 'node.*server.js'         # macOS / Linux
```

Auto-start at Windows login is offered by `setup.bat`. To remove it:

```cmd
schtasks /delete /tn ClaudeDeepSeekProxy /f
```

---

## Project layout

```
.
├── panel.bat / panel.sh     Control panel launchers
├── start.bat / start.sh     Proxy launchers
├── setup.bat / setup.sh     Interactive first-time setup
├── .env                     API keys (gitignored)
├── proxy-config.json        Panel-written overrides (gitignored)
├── assets/logo.svg
├── proxy/
│   ├── server.js            The proxy: routing, format translation, catalogs
│   └── test-proxy.js        Connectivity test
├── ui/
│   ├── server.js            Control panel server (no dependencies)
│   └── public/              Panel front-end
├── certs/                   Certificate generation, CA install and uninstall scripts
└── mcp-gemini-vision/       Optional MCP server for Gemini vision (from upstream)
```

---

## Security

- Both servers listen on `127.0.0.1` only — nothing on your LAN can reach them.
- No CORS headers are sent, and every mutating panel call requires an `x-panel`
  header, which a web page cannot set cross-origin without a preflight. A site
  you happen to be visiting cannot drive the panel.
- API keys are never sent back to the browser; the panel only shows a masked
  preview.
- Client-supplied `x-api-key` headers are not forwarded upstream.
- Request bodies are capped at 50 MB and validated as JSON.
- The TLS certificate is generated locally and the CA is installed only in your
  own trust store (`CurrentUser\Root` on Windows — no administrator rights).
  Claude Desktop rejects a self-signed certificate without `CA:TRUE`, which is
  why a small local CA exists at all. Diagnostics → **Remove CA** takes it back
  out whenever you want; the PEM files under `certs/` are left alone.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_CERT_AUTHORITY_INVALID` | The CA is not trusted yet, or the server certificate no longer chains to it. Diagnostics shows both as their own row; **Install CA** trusts it, **Reissue & reinstall** replaces the pair when the chain is broken. |
| "server is busy" loop in Claude Desktop | The proxy is not running. Start it from the panel. |
| Model missing from the picker | The id must be in one of the families (haiku, sonnet, opus, fable, mythos). Add it under **Configure third-party inference**, or enable `modelDiscoveryEnabled`. |
| Every model answers as the same one | The app's list was imported before the ids changed, so its entries no longer match. Re-export from the Models tab and import again. |
| `MissingSessionID` from OpenCode | OpenCode requires an `x-opencode-session` header; the proxy sends one. Seeing this means an older `proxy/server.js` is running. |
| `Model … is not supported` (OpenCode) | The model lives on the other OpenCode surface. Enable discovery so the proxy learns which base each model belongs to. |
| `429 quota exceeded` (Google) | Gemini Pro models are not available on the free AI Studio tier. Use a Flash model or enable billing. |
| `404 no longer available to new users` (Google) | A retired model id. Refresh the catalog in the panel; `gemini-2.5-*` is filtered out for this reason. |
| Gemini takes ~1 minute for a short answer | A thinking model burning the budget before replying, typically through a `-latest` alias. Pick a concrete id such as `gemini-3.6-flash`. |
| Image upload returns 503 | Use drag & drop or the `+` button; the Quick Entry shortcut bypasses the gateway. |
| Panel says the port is in use | It is already open in another window, or something else holds 8878. `UI_PORT=8879 node ui/server.js`. |
| Live logs stay empty | The proxy was started outside the panel. Stop it and start it from the panel. |
| Custom provider shows 0 models | Its `/models` endpoint did not answer. Check the base URL (it usually ends in `/v1`), that the server is running, and that the path has no trailing slash surprises. |
| Custom provider answers 404 on chat | The base URL points one level too deep or too shallow: Patchbay appends `/chat/completions` to it. |
| OpenRouter returns 401 | The key is missing or wrong — its catalog is public, so models can list while requests still fail. |

The **Diagnostics** tab runs `proxy/test-proxy.js` against the running proxy and
prints a health check, a probe test and a malformed-payload test.

---

## Limitations

- **One text backend at a time.** Providers are not load-balanced or failed
  over; the pinned one (or the first configured by priority) answers everything.
- **Custom providers are trusted as given.** Patchbay does not probe whether an
  endpoint really is OpenAI-compatible; if it is not, the error comes back from
  the request itself.
- **Free-tier labels depend on models.dev.** If it is unreachable, the panel
  shows no cost data and the proxy falls back to matching `-free` in the model
  name — which misses free models named otherwise, such as `big-pickle`.
- **Catalogs are cached.** 30 minutes in the proxy, 5 minutes in the panel
  (12 hours for pricing). Use **Refresh** when a provider has just shipped
  something.
- **Generated ids can shift.** They are assigned in order, so a provider adding
  or dropping models renumbers what comes after it. Rename the ones you rely on
  — pinned ids never move — or re-export after a catalog change.
- **Config changes need a restart.** The proxy reads `proxy-config.json` and
  `.env` at startup; the panel shows a banner and a one-click restart.
- **The panel only logs proxies it started.** An externally started proxy is
  detected and controllable, but its output goes wherever it was launched from.
- **Provider quirks are not hidden.** A model that is unavailable, rate-limited
  or retired upstream fails as it would without the proxy; the error is passed
  through, not masked.
- **Tested on Windows 11.** The macOS and Linux paths exist and are
  straightforward, but have had less exercise.

---

## Credits

Patchbay is a fork of **[simoianni/claude-desktop-proxy](https://github.com/simoianni/claude-desktop-proxy)** —
the original project worked out the hard parts: that Claude Desktop needs a
properly chained local CA, that its connectivity probes must be intercepted,
and how the gateway plumbing fits together. Thank you for building and
publishing it; everything here stands on that work.

Thanks also to [models.dev](https://models.dev) for the open model database
behind the cost and free-tier labels.

## License

MIT — see [LICENSE](LICENSE).
