# ArcGIS Agent Components Demo

React + Vite app built with ArcGIS Maps SDK, ArcGIS Assistant components, and an MCP hub.

The setup steps below include command equivalents for macOS, Linux, and Windows to reduce shell-specific onboarding errors.

## Quick Start (Brand New Computer, Nothing Installed)

Follow this if the machine has no dev tools at all yet. It only covers getting the tools installed — see [Local Setup](#local-setup) below for cloning and configuring this specific app.

1. **Install Git**
   - Windows: download and run the installer from [git-scm.com](https://git-scm.com/download/win), accepting the defaults.
   - macOS: run `git --version` in Terminal — this prompts to install the Xcode Command Line Tools if Git is missing.
   - Linux (Debian/Ubuntu): `sudo apt-get update && sudo apt-get install -y git`
2. **Install Node.js 18+** (includes `npm`)
   - Windows/macOS: download the **LTS** installer from [nodejs.org](https://nodejs.org/) and run it, accepting the defaults.
   - Linux: install via [nvm](https://github.com/nvm-sh/nvm) (`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`, restart the shell, then `nvm install --lts`).
3. **Verify the installs** in a new terminal/PowerShell window:
   ```bash
   git --version
   node --version   # should print v18 or higher
   npm --version
   ```
4. **Continue with [Local Setup](#local-setup)** below: clone the repo, run `npm install`, configure `.env.local` and ArcGIS OAuth, then `npm run dev`.

## Video Walkthrough

[![Watch the video walkthrough: Agentic GIS Meets MCP: Building an ArcGIS AI App](https://img.youtube.com/vi/fz4QGr099ws/hqdefault.jpg)](https://youtu.be/fz4QGr099ws)

This video walks through local setup, authorization, running the app, ArcGIS agents, and MCP integration.

## Disclaimer

Most of this app has been vibe coded with various coding agents. Review the code, configuration, and deployment choices before using it beyond demos or internal experimentation.

## What It Does

- Sign in with ArcGIS and load an existing WebMap or create a new one.
- Use built-in map-aware assistant tools for navigation and data exploration.
- Use MCP-backed tools for external workflows such as weather, catalog, or custom server tasks.
- Render MCP geography on the map when results include places, ranked city lists, or bounding boxes — each map pin shows a popup sourced from the specific article or record that mentioned that place, not a generic summary.
- Create and manage hosted feature layers from assistant results.
- Customise the app header and chat panel via the theme editor (`?mode=edit`) — changes persist across browser refreshes via `localStorage`.

## Local Development Requirements

- Node.js 18+
- An ArcGIS OAuth client ID
- A WebMap item ID to load, or permission to create WebMaps in your ArcGIS org

## Local Setup

### 1. Clone The Repository

```bash
git clone https://github.com/ralouta/ArcGIS-JavaScript-AI-Component.git
cd ArcGIS-JavaScript-AI-Component
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create Local Config Files

macOS and Linux:

```bash
cp .env.example .env.local
cp mcp-hub.config.example.json mcp-hub.config.json
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
Copy-Item mcp-hub.config.example.json mcp-hub.config.json
```

Windows Command Prompt:

```bat
copy .env.example .env.local
copy mcp-hub.config.example.json mcp-hub.config.json
```

### 4. Configure Environment

Edit `.env.local` in the project root:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-client-id
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com
VITE_APP_NAME=ArcGIS Agent Components Demo
```

Update `mcp-hub.config.json` with the MCP servers you want to use and any local-only API keys.

### 5. Configure ArcGIS OAuth

1. Sign in to your ArcGIS portal and create a new credential item:
	- Click `New item`.
	- In the `New item` popup, click `Developer credentials`.
2. Choose the credential type:
	- Select `OAuth 2.0 credential` for user authentication.
	- Click `Next`.
3. Add the local redirect URLs:
	- `http://localhost:5173`
	- `http://localhost:4173`
	- Leave the remaining settings at their defaults.
	- Click `Next`.
4. Fill in the credential metadata in a way that is easy for you or your team to identify later.
	For the workshop, you can use values like:
	- Title: `<your_title>`
	- Tags: `<tag1>`, `<tag2>`, `<tag3>`
	- Summary: `Developer credentials for AI Workshop client app exercise.`
	Then click `Next`.
5. Review the summary page and click `Create`.
6. Copy the generated client ID and add it to `.env.local` as the value of `VITE_ARCGIS_OAUTH_APP_ID`.

Example:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-generated-client-id
```

## Local Run Commands

```bash
npm run dev
npm run hub
npm run hub:dev
npm run build
npm run preview
npm run test:local
```

Run the app and hub in separate terminals when using MCP features.

Terminal 1: start the Vite app

```bash
cd ArcGIS-JavaScript-AI-Component
npm run dev
```

Terminal 2: open a new terminal window or tab, change into the repo again, then start the MCP hub

```bash
cd ArcGIS-JavaScript-AI-Component
npm run hub
```

If you are editing the hub and want automatic restarts, use this in Terminal 2 instead:

```bash
cd ArcGIS-JavaScript-AI-Component
npm run hub:dev
```

## Full Dev Stack: App + MCP Hub + TA5500 RAG (Linux / WSL)

This is the setup used for day-to-day development on the Tel Aviv master plan (תא/5500): the RAG service in Docker, the MCP hub, and the Vite dev server, all on one machine. It was written on WSL 2 (Ubuntu) but works the same on Linux and macOS.

Four processes run, each from its own repo:

| Process | Repo | Port | Started by |
|---|---|---|---|
| RAG embedder (llama.cpp, bge-m3) | `ta5500-rag` | internal | `docker compose` |
| RAG service (FastAPI) | `ta5500-rag` | `8000` | `docker compose` |
| MCP hub (starts the RAG's MCP wrapper over stdio) | this repo | `8808` | `npm run hub:dev` |
| Vite dev server | this repo | `5173` | `npm run dev` |

Request flow: browser → Vite (`/api/mcp` proxy) → hub → `ta5500-rag/mcp/server.mjs` → RAG service `:8000` → embedder.

### Prerequisites

- **Node.js 20+** (the RAG's MCP wrapper needs 20+; check with `node --version`).
- **Docker** with Compose. On WSL: Docker Desktop for Windows with *Settings → Resources → WSL integration* turned on for your distro, so `docker` works inside the WSL shell. About 3 GB free memory and 3 GB disk for the RAG images and model.
- **Both repos side by side**, for example:
  ```text
  ~/systematics-project/
    ArcGIS-JavaScript-AI-Component-main/ArcGIS-JavaScript-AI-Component-main/   ← this app
    ta5500-rag/                                                                ← the RAG
  ```
  Paths below assume this layout; adjust them if yours differs.
- An ArcGIS OAuth client ID whose redirect URLs include `http://localhost:5173` (see [Configure ArcGIS OAuth](#5-configure-arcgis-oauth)).

### 1. Start the RAG service (once per boot)

```bash
cd ~/systematics-project/ta5500-rag
docker compose up -d --build
```

- The first start downloads the llama.cpp image (~1.2 GB) and the bge-m3 model (~1 GB) and builds the service image; expect a few minutes. Later starts take seconds, and both containers restart by themselves after a reboot as long as Docker starts.
- Optional API key: put `RAG_API_KEY=<key>` in a `.env` file next to `docker-compose.yml` **before** `up`. Without it the service accepts unauthenticated calls, which is fine on your own machine.

Wait until it is healthy (200; 503 means the embedder is still loading):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/health
docker compose ps        # both containers "Up", embedder "(healthy)"
```

You can try the RAG on its own at `http://localhost:8000/demo` (Hebrew search page) and `http://localhost:8000/docs` (API).

### 2. Install the RAG's MCP wrapper (once)

```bash
cd ~/systematics-project/ta5500-rag/mcp
npm install
```

### 3. Install this app (once, and after every pull that changes `package.json`)

```bash
cd ~/systematics-project/ArcGIS-JavaScript-AI-Component-main/ArcGIS-JavaScript-AI-Component-main
npm install
```

### 4. App environment (once)

Create `.env.local` (git-ignored) in this app's folder:

```bash
VITE_ARCGIS_OAUTH_APP_ID=<your-client-id>
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com
VITE_APP_NAME=ArcGIS Assistant Demo
```

### 5. Hub config pointing at the RAG (once)

Copy the example and edit the copy:

```bash
cp mcp-hub.config.example.json mcp-hub.config.json
```

Both `mcp-hub.config.json` and `mcp-hub.config.local.json` are git-ignored, so your path and key stay on your machine. The hub reads `mcp-hub.config.local.json` first if it exists, which is handy for a personal override. The `ta5500` entry should end up like this:

```json
{
  "port": 8808,
  "servers": [
    {
      "id": "ta5500",
      "label": "TA5500 RAG (תוכנית המתאר)",
      "transport": "stdio",
      "command": "node",
      "args": ["/home/<you>/systematics-project/ta5500-rag/mcp/server.mjs"],
      "env": { "RAG_BASE_URL": "http://localhost:8000", "RAG_API_KEY": "" },
      "enabled": true
    }
  ]
}
```

- Set `enabled` to `true` (the example ships disabled because its path is a placeholder).
- `args` must be the **absolute Linux path** to `server.mjs` on your machine (`realpath ~/systematics-project/ta5500-rag/mcp/server.mjs` prints it). A Windows path such as `C:/...` does not work inside WSL.
- `RAG_API_KEY`: empty if you did not set one in step 1, otherwise the same value.
- Keep the server id `ta5500`: tool names are namespaced by it (`ta5500__search_plan`).
- Never commit either config file. If you add a server that others need, add a placeholder version of it to `mcp-hub.config.example.json`.

### 6. Run (two terminals, every session)

Terminal 1, the MCP hub (restarts itself when hub code changes):

```bash
cd ~/systematics-project/ArcGIS-JavaScript-AI-Component-main/ArcGIS-JavaScript-AI-Component-main
npm run hub:dev
```

Terminal 2, the app over plain HTTP on localhost:

```bash
cd ~/systematics-project/ArcGIS-JavaScript-AI-Component-main/ArcGIS-JavaScript-AI-Component-main
VITE_DEV_HTTPS=false VITE_DEV_HOST=localhost npm run dev
```

The two variables are needed because the dev config defaults to HTTPS with a certificate from a Windows path and to the host `hilar-lap.stltd.co.il` (see `vite.config.ts`). To avoid typing them every time, add `VITE_DEV_HTTPS=false` and `VITE_DEV_HOST=localhost` to `.env.local`.

Open `http://localhost:5173`, sign in, and load the TA5500 WebMap (the demo id under [Using The App](#using-the-app)). WSL forwards `localhost` to the Windows browser automatically.

### 7. Check each link of the chain

If the assistant does not answer from the plan, check the links in order. The first one that fails is the problem.

```bash
# RAG service
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/health          # 200

# Hub: expect "runningCount":1 and "toolCount":4
curl -s http://127.0.0.1:8808/health

# Hub → MCP wrapper → RAG, without the assistant: prints Hebrew plan text with citations
curl -s -X POST http://127.0.0.1:8808/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ta5500__search_plan","arguments":{"question":"מה ההוראות לאזור 703?"}}}' | head -c 600
```

In the browser, the console shows which agent handled each question ("Executing registered agent: …"), and the network tab shows `tools/call` requests to `/api/mcp` when the RAG was used.

### Stopping

- App and hub: `Ctrl+C` in each terminal.
- RAG: `cd ~/systematics-project/ta5500-rag && docker compose down` (or leave it running; it idles cheaply).

### Troubleshooting the dev stack

| Symptom | Cause / fix |
|---|---|
| Vite exits at startup with `ENOENT ... server.cert` | Start it with `VITE_DEV_HTTPS=false` (step 6). |
| Sign-in redirects fail | The OAuth credential's redirect URLs must include exactly `http://localhost:5173`. |
| `docker: command not found` in WSL | Turn on WSL integration for your distro in Docker Desktop, then reopen the shell. |
| RAG `/health` stays 503 | The embedder is still downloading or loading the model; `docker compose logs -f embedder`. If HuggingFace is blocked, see `docker-compose.override.example.yml` in the RAG repo. |
| Hub `toolCount` is 0 or `ta5500` is not running | `enabled` is still `false`, the `args` path in your hub config is wrong, or step 2 (`npm install` in `mcp/`) was skipped. The hub terminal prints the error. |
| `search_plan` returns HTTP 401 | `RAG_API_KEY` in the hub config does not match the RAG's `.env`. |
| `search_plan` returns 503 | The embedder is down or cold; wait and retry, or restart it with `docker compose restart embedder`. |

## TA5500 Assistant (Tel Aviv master plan)

When the loaded WebMap contains the TA5500 plan layers (planning-areas layer 122), the app enters **TA5500 mode** and registers three extra agents. Plan answers need the RAG stack running (see [Full Dev Stack](#full-dev-stack-app--mcp-hub--ta5500-rag-linux--wsl)); without it the Plan agent replies "שירות תוכנית המתאר אינו זמין כרגע. נסו שוב בעוד מספר דקות." (`PLAN_SERVICE_UNAVAILABLE` in `src/ta5500/ragClient.ts`) and leaves the map as it is.

| Agent id | Chosen when the request is about | Does |
|---|---|---|
| `ta5500-plan` | what the plan says or allows ("מה מותר לבנות באזור 105?", "מה אומר סעיף 4.3?"), and follow-ups or clearing the focus ("ומה לגבי מגורים שם?", "נקה מיקוד") | Answers from the plan with citations, focuses the map on the named place and highlights the relevant layers |
| `ta5500-map` | a map action on the plan map ("קח אותי לרמת אביב", "הצג רק אזורי מגורים", "תסתיר את שכבת המוקדים", "אפס את המפה") | Go to a place, show/filter/hide whole layers, reset. Hiding only part of a layer is declined |
| `ta5500-scope` | a place outside Tel Aviv-Yafo or an unrelated topic | Replies that the assistant only covers the Tel Aviv master plan |

Other agents (data exploration, layer creation, MCP passthrough, help) stay available; the passthrough agent does not take plan questions in TA5500 mode.

**Focus.** A plan answer sets the map focus (a place plus highlighted layers). A chip "מיקוד: …" with an X appears in the assistant panel while a focus is active. The focus is cleared by the chip, by asking ("נקה מיקוד", "אפס את המפה"), or by "שיחה חדשה"; clearing restores layer visibility and filters.

**Routing trace.** Open the app with `?mode=edit`: the chat shows "Executing registered agent: <name>" for each request, so you can see which agent was picked. The trace prints the agent's name, not its id:

| Name in the trace | Agent id |
|---|---|
| TA5500 Plan | `ta5500-plan` |
| TA5500 Map | `ta5500-map` |
| Out of scope | `ta5500-scope` |
| All Capabilities | `all-capabilities-agent` |
| Create Feature Layer | `create-feature-layer-agent` |
| Manage Feature Layer Features | `manage-feature-layer-agent` |
| Add Layer to Map | `add-layer-to-map-agent` |
| MCP Hub (the hub's server name) | `mcp-passthrough-agent` |
| (SDK built-in data exploration) | not defined in `src/`; confirm the name and id from the trace on the first run |

**Routing test set.** `docs/routing-questions.yml` lists Hebrew requests with the expected agent. Run it by hand after every agent-description change (including the examples inside `src/ta5500/prompts.ts`) and every `@arcgis/*` upgrade; the header of the file explains how and what to record. Add the team's own wording under `# team questions`.

**Manual end-to-end checklist** (TA5500 map, RAG running):

- [ ] The four focus cases of spec §5.3 step 4 (area code, sub-area, special street, free-text place).
- [ ] A neighborhood name ("רמת אביב").
- [ ] A follow-up that depends on the focus ("ומה לגבי מגורים שם?").
- [ ] Clear the focus by the chip, and by text ("נקה מיקוד").
- [ ] A place outside Tel Aviv (Haifa, Paris): scope reply, map unchanged.
- [ ] A neighbouring city inside the Tel Aviv bounding box: "קח אותי לרמת גן" and "מה מותר לבנות בגבעתיים?" are declined as outside Tel Aviv-Yafo, map unchanged.
- [ ] An area code that is not in the plan: "מה מותר לבנות באזור 999?" answers city-wide and says "אזור 999 אינו מופיע בתוכנית."; "תתמקד על אזור 610" says the same and leaves the map unchanged.
- [ ] An unrelated topic (weather): scope reply.
- [ ] RAG down (`docker compose stop service` in `ta5500-rag`): Hebrew unavailable message, focus untouched; then `docker compose start service`.

**Unit tests.** `npm test` runs the Node tests for the agent runtime and the pure TA5500 modules (no browser needed); `npm run typecheck:test` type-checks them.

## Local Tests

This workspace includes a local-only test harness in `tests/`.

- The directory is intentionally listed in `.gitignore` so ad hoc validation stays local.
- The tests exercise the extracted pure MCP core logic used by the app, not browser-only ArcGIS component rendering.
- Run them with:

```bash
npm run test:local
```

What the local tests currently cover:

- MCP endpoint normalization and hub server URL resolution
- MCP tool prompt construction
- JSON and fenced-JSON parsing
- geometry hint extraction from structured MCP payloads and plain text
- source-backed geometry derivation for points, extents, and countries

## Using The App

1. Sign in with ArcGIS.
2. Load a WebMap by item ID, or create a new map.
3. Ask map questions, run MCP-backed prompts, or create/manage hosted layers.

Demo WebMap ID:

```text
814f668511874bdb8ee3e49b515e8e5a
```

Example prompts:

**Map & navigation**
- `what layers are in this webmap?`
- `navigate me to baalbek`
- `zoom to the extent of the Streets layer`

**Create Feature Layer**
- `create a point layer named Sites with fields: Name:string, Category:string, Status:string`
- `create a polygon layer called Flood Zones with a Description field`
- `make a new polyline layer named Roads with fields: Road_Name:string, Speed_Limit:integer`

**Manage Feature Layer (add / update / delete features)**
- `add a point at the Eiffel Tower to the Sites layer`
- `add a feature to the last created layer at Central Park, New York`
- `delete all features named "Test" from the Sites layer`
- `update the feature named "HQ" in the Sites layer — set Status to Active`

**Add Layer to Map**
- `add the Utrecht Parks layer to the map`
- `load the layer with item id 3e2f1ab4c8d94567890abcdef1234567`
- `add this layer to the map: https://services.arcgis.com/your-org/arcgis/rest/services/MyService/FeatureServer/0`


## MCP Hub

The local hub in `hub/server.ts` aggregates multiple MCP servers behind one endpoint.

You can add servers in two ways from the MCP manager:

- Command-based `stdio` servers such as `npx`, `node`, `python`, or `uvx`
- Direct HTTP MCP server URLs

Example remote bridge via `mcp-remote`:

```text
Command:   npx
Arguments: mcp-remote https://your-remote-mcp-server.com/mcp
```

The hub runs on port `8808` by default and is proxied through Vite at `/api/mcp` during development.

### Connecting the TA5500 RAG (Tel Aviv master plan)

The RAG lives in its own repo (`ta5500-rag`). It exposes an HTTP service, and the `mcp/` folder there is an MCP (stdio) wrapper around it. The existing MCP passthrough agent discovers the tools from the hub.

Step-by-step setup, including running the RAG: see [Full Dev Stack: App + MCP Hub + TA5500 RAG](#full-dev-stack-app--mcp-hub--ta5500-rag-linux--wsl). The hub should list four tools: `search_plan`, `get_plan_contents`, `get_plan_locations`, `get_plan_chunk`.

Tips:
- Ask about the plan explicitly, for example "מה ההוראות בתוכנית תא/5500 לאזור 102א' דרום גלילות?". Questions that only mention a planning area can be routed to the map's data-exploration agent instead.
- Check that it is the MCP agent that answered: the browser's network tab should show `tools/call` requests to `/api/mcp`.
- Known issue: one test question ended with "The MCP Hub server did not return a response". The cause is not known yet.
- `mcp-hub.config.json` holds your path and the API key. It is git-ignored; do not commit it.

## Assistant Notes

- The assistant stays available even on empty maps.
- Map-aware built-in tools wait until the map is ready and assistant data has been prepared.
- Empty maps still support MCP and custom assistant workflows.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in fails | Check `VITE_ARCGIS_OAUTH_APP_ID` and redirect URLs |
| Map will not load | Verify the WebMap ID and sharing permissions |
| MCP tools are unavailable | Confirm you opened a second terminal, changed into the repo folder, and started `npm run hub` or `npm run hub:dev` |
| Feature layer creation fails | Verify the account can create hosted feature layers |
| Map-aware answers are weak | Refresh assistant data for the current map |

## URL Parameters

The only supported URL parameter is `?mode=edit`.

Use it when you want the wider assistant panel and the theme editor controls:

```text
http://localhost:5173/?mode=edit
```

In edit mode you can customise:

- Header title, subtitle, and font
- Header and chat panel background colors and borders
- Chat panel title and text colors

All changes are saved to `localStorage` and survive page refreshes. Use the **Cancel** button in the theme editor to revert to the values from when you opened the dialog.

## Architecture

The app is structured as a thin React orchestrator (`App.tsx`) wiring together focused hook and component modules:

| Layer | Files |
|---|---|
| Hooks | `useAuth`, `useWebMap`, `useAssistantSetup`, `useTheme` |
| Components | `AppHeader`, `AssistantPanel`, `MapView`, `AccountMenu`, `SignInScreen`, `MapPickerScreen`, `SignOutDialog`, `ChangeMapDialog`, `NewMapDialog`, `ThemeEditorDialog` |
| Agents | `McpPassthroughAgent`, `mcpAgentCore`, `AddLayerToMapAgent`, `CreateFeatureLayerAgent`, `ManageFeatureLayerAgent` |
| Utils | `mcpGeoRenderer`, `arcgisMcp`, `arcgisOnline`, `featureLayerEdits`, `agentHelpers`, `mcpZodSchema`, `assistantStyler` |

### MCP Geo Pipeline

When an MCP tool call returns results, the pipeline:

1. Runs a **single** LLM call (`extractAndSelectGeoEntities`) to extract all geocodable place names from a compact digest of all source records.
2. Matches each place name directly to the source articles/records that mention it.
3. Builds popup context from matched records (specific article title, description, and URL) rather than regex-matching against the raw JSON corpus — so "Tyre" shows the 2 articles about Tyre while "Lebanon" gracefully falls back to prose rather than repeating all 10 articles.

## Copilot Agent Team

The `.github/agents/` directory contains a specialist agent team for VS Code Copilot:

| Agent | When to use |
|---|---|
| `feature-orchestrator` | End-to-end feature delivery (PLAN → BUILD → TEST → SHIP) |
| `arcgis-calcite` | Calcite Design System and ArcGIS 5.0 web components |
| `mcp` | MCP hub, passthrough agent, geo renderer |
| `testing` | Code quality, slot validation, accessibility, JS correctness |
| `docs` | README and inline documentation |
| `github-manager` | Branch naming, commits, PRs |
| `typescript` | Type errors, generics, Zod schemas |
| `react-architect` | Component extraction, hooks, project structure |
| `html` | Semantic HTML, accessibility, slot composition |
| `code-security` | OWASP checks, secret detection, security audits |

