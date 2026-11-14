# Plan-aware assistant for the תא/5500 map

Status: draft for review · 2026-11-14 · base: branch `merge-fork` (`origin/main` + `fork/main`, ArcGIS packages 5.1.27)

Related: RAG repo `~/systematics-project/ta5500-rag` (README, `docs/polygon-focus-plan.md`, `models.yml` `gis_codes`).

## 1. Intent

The app's AI assistant runs on the Tel Aviv master plan map (תא/5500). Every user request is one of three kinds, and the assistant must tell them apart:

1. **A question about the plan** ("what does the plan say / allow / require …", with or without a place). The assistant answers from the plan text (the ta5500 RAG) with clause and page citations, **and** shows the answer on the map: it focuses on the place, if one was named, and highlights the layers and features the answer is about.
2. **A request to act on the map** (navigate, show or hide layers, filter, count). The assistant does it, **as long as it concerns Tel Aviv-Yafo and the plan's content**.
3. **Anything else** (places outside Tel Aviv, topics the plan and map do not cover). The assistant declines briefly and says what it can do.

The observed failure that started this work: asked about business/commercial areas in planning area 610, the assistant neither focused on 610 nor showed the relevant layers. The design must solve the general problem, not that one case: the 610 business question is one test among many.

## 2. Current state (verified 2026-11-14)

### App
- `<arcgis-assistant>` from `@arcgis/ai-components` **5.1.27** (Esri, closed source, beta, npm). Built-in agents rendered in `AssistantPanel.tsx`: help, navigation, data-exploration. Custom agents registered in `useAssistantSetup.ts`: CreateFeatureLayer, ManageFeatureLayer, AddLayerToMap, AllCapabilities, McpPassthrough.
- The RAG is reachable only through the generic `McpPassthroughAgent` (hub server `ta5500`, tools `ta5500__search_plan`, `__get_plan_contents`, `__get_plan_locations`, `__get_plan_chunk`). Its description says "external, non-map questions", so it competes with the map agents for plan questions about places.
- After an MCP answer the app extracts place names and geocodes them with World Geocoder (`mcpGeoRenderer.ts`). "אזור תכנון 610" cannot be geocoded, and nothing links an answer to the TA5500 layers. This is the root cause of the 610 failure.
- The built-in navigation agent geocodes any place in the world and goes there; nothing limits the assistant to Tel Aviv.

### SDK 5.1 orchestration (read from the installed package)
- The orchestrator is **step-by-step**: each step an LLM picks the single best next agent from the registered agents' `{id, name, description}`, writes an `assignedTask`, and says whether a follow-up step is likely. Max 3 steps per user turn; it stops when the same agent would run twice in a row. Router rule: "Base the choice on the registered agent descriptions." If no agent applies it may return none.
- Agents receive `agentExecutionContext` = `{ userRequest, assignedTask, messages, priorSteps, sharedState }` and should return `outputMessage`, `summary`, `status` (`success`/`failed`) and optionally `sharedStatePatch`. Helpers: `createAgentRuntimeState()`, `createAgentRuntimeStateWithSharedState()` from `@arcgis/ai-components/utils`. Shared state persists across turns until a new conversation; `priorSteps` keep the last 5. An agent's `outputMessage` is cut to 4,000 characters in history.
- Models are Esri-hosted (portal credential). We control our agents' names, descriptions and prompts, and which agents are registered; we cannot change the router or the built-in agents' prompts.
- Built-in data-exploration tools choose layers by semantic search over layer and field names. They cannot know that zone code 332 is plan section 3.3.2, so plan-driven highlighting is our own code.
- `view.constraints.geometry` (MapView, 5.x) limits interactive navigation and `goTo()` to an extent or polygon.

### Breaking issue from the 5.1 upgrade
The fork bumped the packages to 5.1.27 but left the custom agents on the 5.0 state shape: their graphs read `state.messages`, while 5.1 invokes agents with `agentExecutionContext` only. Reading the code (not yet run), the custom agents receive no user text and return no `status`. `npx tsc --noEmit` reports one error (`McpPassthroughAgent.ts:821`, `Timeout` vs `number`). Fixed first (§5.0).

### RAG (ta5500-rag)
- `POST /v1/search` returns structured `location` (areas, subareas, zone_types, entities), `hits` (citation, pages, via, heading_path) and a Hebrew `context` block. `GET /v1/locations` returns area codes, sub-areas, entities, zone types and `gis_codes` (GIS layer code ↔ plan section).
- The MCP `search_plan` tool returns **only the text**. The hub already passes a whole `tools/call` result through, so adding `structuredContent` reaches the app.

## 3. Goals, non-goals, anti-goals

Goals
1. The router reliably separates plan questions, map requests and out-of-scope requests.
2. Plan answers come only from the RAG, in Hebrew, with the RAG's citations and pages; they say when the plan has no answer or the match is low.
3. Every plan answer that concerns mapped plan content is shown on the map: focus on the named place, highlight the layers and features the answer cites, hide what is irrelevant.
4. Map requests about Tel Aviv and plan content are carried out; requests outside Tel Aviv or outside the plan are declined.
5. Follow-ups work ("ומה לגבי מגורים שם?", "תראה רק את המוקדים") using the stored focus; the user can clear the focus in one action.

Non-goals (v1)
- Drawing, selecting or uploading a polygon as a focus (polygon-focus plan F3/F6). The focus object (§5.4) accepts a geometry from any source, so this can be added later.
- Changing RAG retrieval, chunking or the embedding model.
- Production hosting of the RAG or hub.

Anti-goals
- The map shows layers or features the cited answer does not talk about, or the LLM invents layer ids, codes or SQL.
- A plan question answered from the model's own knowledge without RAG text.
- The assistant navigates outside Tel Aviv or acts on content unrelated to the plan.
- The map left in a state the user cannot undo.
- Patching `node_modules` or relying on `@internal` SDK APIs.

## 4. Constraints
- Hebrew/RTL UI, gender-neutral wording; new user-facing strings in Hebrew.
- Pin `@arcgis/*` and `@esri/calcite-components` to exact versions (`~5.1.27` → `5.1.27`). Re-run the routing test set (§6) after any upgrade.
- Pure logic (request validation, code resolution, layer matching, scope checks) in framework-free modules testable by the local tsx harness, as with `mcpAgentCore.ts`.
- TA5500 layers are identified by **service name + layerId** found in the loaded map's layer URLs, never by title (the map repeats one sublayer under many titles) and never by a hard-coded org URL. Layer ids and fields per `polygon-focus-plan.md`; the builder confirms them against the real map on first run.

## 5. Design

### 5.0 Prerequisite: migrate custom agents to the 5.1 contract
Every custom agent: state from `agentRuntimeChannels()` (`src/agents/agentRuntime.ts`, same channels as the SDK's `createAgentRuntimeStateWithSharedState()`, testable in Node) plus its own channels; read the request from `agentExecutionContext.assignedTask` (fallback `userRequest`) and history from `agentExecutionContext.messages`; return `status` and a one-line `summary`. Fix the tsc error. Verify each agent by hand once.

### 5.1 TA5500 mode
On map load, scan `map.allLayers` for the TA5500 layers (§5.6). If the planning-areas layer (122) is found, the app is in **TA5500 mode**:
- the agent set in §5.2 is registered;
- `view.constraints.geometry` is set to the union extent of layer 122, slightly expanded (Tel Aviv-Yafo), as a backstop against navigating elsewhere.

On any other map, the app behaves as today (minus the 5.1 fix).

### 5.2 Agents in TA5500 mode

| Agent | Owns | Status |
|---|---|---|
| **Plan agent** (`PlanAgent.ts`) | Questions about what the plan says, with or without a place; refining or clearing a plan focus | New |
| **Map agent** (`Ta5500MapAgent.ts`) | Map actions within Tel Aviv: go to a planning area / sub-area / street / neighborhood / address; show, hide or filter plan layers by plan concept ("הצג אזורי תעסוקה", "תסתיר את המוקדים"); reset the map | New; replaces the built-in navigation agent in TA5500 mode |
| Data exploration (built-in) | Counts, statistics and attribute questions on the map's layers ("כמה מוקדי תעסוקה יש?") | Unchanged; on this map its layers are all plan layers |
| **Scope agent** (`ScopeAgent.ts`) | Requests about places outside Tel Aviv-Yafo or topics unrelated to the plan and the map: replies with a short Hebrew decline and what the assistant can do | New |
| Help (built-in) | "מה אתה יודע לעשות?" | Unchanged |
| McpPassthrough | Other MCP servers | `ta5500__*` tools hidden from it; stays on (§7) |
| Feature-layer agents, AllCapabilities | As today | Stay on (§7) |

The Plan agent handles "plan + place" itself instead of chaining agents, so the router only decides between plan, map action and out of scope.

Descriptions are part of the deliverable. Drafts (English for the router, Hebrew cue words; tuned with the test set):

- **Plan agent:** "Answers questions about the Tel Aviv master plan תא/5500 (תוכנית המתאר) from the plan document: what the plan allows, requires or designates — building rights, רח"ק, heights, land uses, zone types (אזורי ייעוד), planning areas (אזור תכנון, e.g. 610, 703, 101ה), streets with special provisions, table 5.4, clauses (סעיף 3.3.2), development policy (פיתוח, תעסוקה, מגורים, מוסדות ציבור, שטחים פתוחים). It always shows the answer on the map: focuses on the named place and highlights the relevant plan layers. While a plan focus is active it also changes what is shown in it and clears it (נקה מיקוד). Use for: 'מה מותר לבנות באזור 610?', 'מה תוכנית הפיתוח העסקי ברמת אביב?', 'מה אומר סעיף 4.3?', 'ומה לגבי מגורים שם?'. Do NOT use for map actions that do not ask what the plan says (navigate, show/hide layers, count features)."
- **Map agent:** "Performs map actions on the Tel Aviv-Yafo master plan map: go to a planning area, sub-area, street, neighborhood or address in Tel Aviv-Yafo; show, hide or filter the plan layers (zone types, development foci, planning areas, special streets); reset the map. Use for: 'תתמקד על אזור 703', 'קח אותי לרמת אביב', 'הצג רק אזורי מגורים', 'תסתיר את שכבת המוקדים', 'אפס את המפה'. Do NOT use for questions about what the plan says or allows (Plan agent), counts or statistics (data exploration), or places outside Tel Aviv-Yafo."
- **Scope agent:** "Use when the request is about a place outside Tel Aviv-Yafo (another city or country) or a topic unrelated to the Tel Aviv master plan and its map (news, weather, general knowledge). Replies that the assistant only works on the Tel Aviv-Yafo master plan."
- **McpPassthrough:** append "Do NOT use for questions about the Tel Aviv master plan תא/5500."

### 5.3 Plan agent flow
1. **Resolve** (one structured `invokeToolPrompt` call with a Zod schema): a standalone Hebrew question (resolving "שם/זה" from history and the stored focus), candidate `areas`, `entities`, `zone_types`, `headings`, and `intent: "answer" | "refine_focus" | "clear_focus"`. Every value is validated against `GET /v1/locations` (cached per session); unknown values are dropped. The LLM proposes, code validates. A place that is not a plan code (a neighborhood such as "רמת אביב") is geocoded with a Tel Aviv check (§5.5) and turned into planning areas by intersecting layer 122.
2. **Search** `ta5500__search_plan` with the validated filters plus topic overrides (§5.6). Needs `structuredContent` (§5.7).
3. **Answer** (one structured LLM call): Hebrew answer text **and the list of sections / table 5.4 records it cited**. Rules: answer only from the context; cite with the given citation and page; table 5.4 overrides the general chapters; say clearly when the plan has no answer; state uncertainty on `התאמה נמוכה`; if `focus_more` is listed, answer first and offer the rest.
4. **Show on the map** (deterministic code, no LLM):
   1. **Place geometry** (if a place was resolved): layer 122 (`NumEzorTihnun`) for an area, 145 (`mis_ezor`) for a sub-area, 146 (`mis_ezor`) for a street; union if several.
   2. **Candidates** (layer, codes): reverse `gis_codes` from the sections the answer **cited** (not every hit), plus topic overrides.
   3. **Keep** candidates with matching features: `queryFeatureCount({ where: code IN (…), geometry?, spatialRelationship: "intersects" })` > 0. Skipped layers are named in the reply.
   4. **Apply**, by case:
      - place + candidates: every map instance of each kept layer gets `layerView.filter = new FeatureFilter({ where, geometry, spatialRelationship: "intersects" })` and `visible = true`; other operational layers hidden (previous visibility stored); place outline drawn; `goTo` the place.
      - place, no candidates: show the zones layer (128) filtered to the place, hide the rest, outline, `goTo` the place.
      - no place + candidates: show the kept layers with `featureEffect` (matching features emphasized, others dimmed), hide unrelated layers, `goTo` the extent of the matching features.
      - no place, no candidates (e.g. a general procedure clause): map unchanged.
   5. Add one Hebrew line to the reply saying what is shown ("מוצגים באזור 610: אזורי תעסוקה, מוקד תעסוקה חדש").
5. **Return** `status`, `summary`, `sharedStatePatch.ta5500Focus` (§5.4).

`refine_focus` re-runs step 4 against the stored place with the newly resolved topic, searching the RAG again when the topic is new. `clear_focus` resets (§5.4).

Failures: RAG or hub down → say the plan service is unavailable, no guessing, `status: "failed"`. Map step fails → keep the text answer and say the map could not be updated.

### 5.4 Focus state and reset
`ta5500Focus = { place: {kind, codes, label} | null, geometry | null, layers: [{layerKey, where}], previousVisibility }`, in shared state and in an app-side store (needed to restore the map). A new plan focus replaces the old one.

Reset restores visibility, clears `layerView.filter` and `featureEffect` on the affected layers (also undoing the built-in data-exploration agent's filters), removes the outline. Triggers: "נקה מיקוד" / "אפס את המפה"; a Hebrew chip in the assistant panel, "מיקוד: אזור 610 ✕", shown while a focus is active; a new conversation.

### 5.5 Scope rules (Tel Aviv and the plan)
- **Places**: plan codes are in scope by definition. Free-text places are geocoded with World Geocoder limited to the Tel Aviv extent (`searchExtent`); a result outside the layer-122 union is out of scope. The Map and Plan agents decline such requests themselves even when the router sent them there (the router can misroute; the scope check cannot).
- **Topics**: map actions are in scope when they act on the TA5500 layers or on navigation inside Tel Aviv. Plan questions are in scope when the RAG returns anything above `התאמה נמוכה`; on a low match the Plan agent says the plan does not seem to cover it, without guessing.
- `view.constraints.geometry` (§5.1) is the backstop.

### 5.6 Configuration (`src/config/ta5500Layers.ts`)
- Layer table: key (`areas`, `zones`, `foci`, `spaces`, `streets`, `employment`, … matching the RAG's `gis_codes` layer names), service name, layerId, code field, display field. Matched against the loaded map's layer URLs (§4).
- Topic overrides: topic words → plan filters, for topics the RAG maps poorly. Initial entry: `פיתוח עסקי / תעסוקה / מסחר` → `zone_types` 3.3 (all employment types) and 3.4.1 (mixed), foci 335. More entries come from the routing test set; the list stays short.

### 5.7 RAG repo change (additive)
`search_plan` also returns MCP `structuredContent`: the response's `location`, `band`, and per hit `citation`, `pages`, `via`, `heading_path` (no chunk text). Existing callers unaffected.

## 6. Testing
- **Routing test set** (`tests/routing-questions.yml`, local harness): Hebrew requests labelled `plan`, `plan+place`, `map`, `out_of_scope`, with the expected agent; includes refinements and clears. Run by hand after every description change and SDK upgrade, reading the "Executing registered agent" trace. Start with ~25 requests, at least half supplied by the team in users' wording.
- **Unit tests** (tsx, Node): request validation against a `/v1/locations` fixture, reverse `gis_codes`, override merge, where-clause building, scope check, focus-state reducer.
- **Manual end-to-end** on the TA5500 map: the four cases of §5.3 step 4; a neighborhood name; a follow-up; clear by chip and by text; a place outside Tel Aviv; an unrelated topic; RAG down.

## 7. Decisions and open items

Decided with the user: start from this repo (now including the fork's merge); the general rule in §1 (plan question → citations + map highlight; map request → do it if it concerns Tel Aviv and the plan; otherwise decline); hide layers with no features in the area; with a place but no matching topic, show the zones layer clipped to the place; prompts and descriptions are part of the work.

My calls (review):
- One Plan agent handles plan + place instead of chaining agents; it also owns refining and clearing the focus.
- Map layers come from the sections the answer cited, plus a short override list.
- A new Map agent replaces the built-in navigation agent in TA5500 mode, because the built-in one cannot be limited to Tel Aviv; a Scope agent handles out-of-scope requests explicitly.
- TA5500 mode is detected from the loaded map; no hard-coded web map id or org URLs.
- Relation to `polygon-focus-plan.md`: the app-side focus store mentioned in the RAG README is not in any branch of this repo, so this design builds it. It supersedes F7: the Plan agent owns the `ta5500__*` tools. In v1 a plan search sends validated `areas`/`entities` plus override `zone_types`; intersect-derived `focus_notes` are deferred with the polygon work.
- Polygon drawing deferred.

Non-plan agents (create/manage feature layer, add layer to map, MCP passthrough for other servers) stay registered in TA5500 mode for now (user decision). Registration goes through one list in `useAssistantSetup` so any of them can be switched off in TA5500 mode with a one-line change if they cause misroutes; the routing test set includes a few requests aimed at them to watch for this.

Open:
1. Real user requests for the routing test set.
2. Code field of the employment layer (126).
3. `RAG_API_KEY` is committed in `mcp-hub.config.json` on `origin/main` and the file is no longer git-ignored: rotate the key and restore the ignore rule before merging.
