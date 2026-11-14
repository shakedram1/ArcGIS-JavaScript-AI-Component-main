# Plan-aware Assistant (תא/5500) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant tells plan questions from map actions and out-of-scope requests; plan answers come from the ta5500 RAG with citations and are shown on the map; map actions stay inside Tel Aviv-Yafo and the plan.

**Architecture:** Custom agents move to the SDK 5.1 agent contract. Three new agents (Plan, Map, Scope) are registered when the loaded web map contains the TA5500 layers. All decisions that must be exact (filter validation, GIS-code mapping, where clauses, scope checks, focus state) are pure TypeScript modules under `src/ta5500/`, tested in Node; ArcGIS calls live in one browser-only module (`mapFocus.ts`). The RAG's MCP `search_plan` gains `structuredContent` so the app gets citations and detected locations as data.

**Tech Stack:** React 18, Vite, `@arcgis/core` / `@arcgis/ai-components` 5.1.27, LangGraph (`@langchain/langgraph/web`), Zod 4, `node:test` via `tsx --test`; RAG side: Node MCP server (`@modelcontextprotocol/sdk` 1.32).

**Spec:** `docs/superpowers/specs/2026-11-14-plan-aware-assistant-design.md`

Paths below are relative to the app folder `ArcGIS-JavaScript-AI-Component-main/` unless they start with `ta5500-rag/` (the sibling RAG repo, `~/systematics-project/ta5500-rag`). Git commands for the app run from that folder; for the RAG from `ta5500-rag/`.

## Global Constraints

- Hebrew/RTL UI, gender-neutral wording; every new user-facing string is Hebrew.
- `@arcgis/ai-components`, `@arcgis/coding-components`, `@arcgis/core`, `@arcgis/map-components` pinned to exactly `5.1.27`; `@esri/calcite-components` pinned to the currently installed exact version (read it from `node_modules/@esri/calcite-components/package.json`).
- No edits under `node_modules`; no use of SDK exports marked `@internal` (`NavigationAgent`, `DataExplorationAgent`, `createChatModel`, `AgentWithContext`, …).
- TA5500 layers are identified by service name starting with `TA5500_` plus `layerId`, never by layer title, never by a hard-coded org URL.
- Pure modules (`src/ta5500/*.ts` except `mapFocus.ts`, `src/agents/agentRuntime.ts`) import no `@arcgis/*` runtime code and no DOM, so `tsx --test` runs them in Node. Type-only imports are fine.
- LLMs propose, code validates: every area, entity, zone type, heading, layer id and code that reaches a RAG call or a map filter comes from `/v1/locations`, `gis_codes` or the layer config, never verbatim from model output.
- Never commit `mcp-hub.config.json` or `mcp-hub.config.local.json`.

## Review Focus

1. **A question whose place cannot be resolved** ("מה מותר לבנות ליד הבית שלי?"): the Plan agent answers from the plan without a focus and says it could not identify the place, instead of focusing somewhere arbitrary. Test in Task 5 (`validateRequest` drops unknown places) and manual case in Task 13.
2. **RAG or hub down mid-conversation:** the Plan agent replies with a Hebrew "the plan service is unavailable" message and `status: "failed"`, and leaves the existing map focus untouched. Test in Task 3 (`parseSearchPlanResult` on an `isError` result) and manual case in Task 13.
3. **A cited section with no GIS mapping** (a chapter 4 procedure clause): no layers change; the map stays as it was unless a place was named. Test in Task 6 (`planFocus` case `none`).
4. **A layer present several times in the map under different titles:** every instance gets the same filter, and reset restores each instance's own previous visibility. Test in Task 4 (`findTa5500Layers` returns all instances) and Task 6 (`focusStore` keeps visibility per layer uid).
5. **A string-typed code field vs. a numeric one:** where clauses quote codes only for string fields; a mismatch would silently match nothing. Test in Task 6 (`buildCodeWhere`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/agents/agentRuntime.ts` (new, pure) | 5.1 agent state channels; read the request from a run; build a result |
| `src/utils/mcpClient.ts` (new) | JSON-RPC client for the hub, extracted from `McpPassthroughAgent.ts` |
| `src/ta5500/types.ts` (new, pure) | Shared types for RAG data, layers, focus |
| `src/ta5500/ragClient.ts` (new) | `searchPlan`, `getPlanLocations` (cached) over `mcpClient`; result parsing |
| `src/ta5500/layers.ts` (new, pure) | Layer table, topic overrides, URL → layer matching |
| `src/ta5500/planLogic.ts` (new, pure) | Validate filters, cited sections, reverse `gis_codes`, overrides, scope extent check |
| `src/ta5500/focus.ts` (new, pure) | Focus planning (cases), where clauses, focus store |
| `src/ta5500/mapFocus.ts` (new, browser) | ArcGIS: find layers, place geometry, feature counts, apply/reset focus, geocode in Tel Aviv |
| `src/ta5500/prompts.ts` (new, pure) | Agent descriptions, prompt texts, Hebrew copy |
| `src/agents/PlanAgent.ts`, `Ta5500MapAgent.ts`, `ScopeAgent.ts` (new) | The three agents |
| `src/hooks/useTa5500Mode.ts` (new) | Detect TA5500 mode, set view constraints |
| `src/components/FocusChip.tsx` (new) | "מיקוד: … ✕" chip |
| `src/ta5500/__tests__/*.test.ts`, `src/agents/__tests__/*.test.ts` (new) | Node tests |
| `docs/routing-questions.yml` (new) | Routing test set (committed; `tests/` stays git-ignored) |
| Modified | the 5 existing custom agents, `useAssistantSetup.ts`, `AssistantPanel.tsx`, `package.json`, `tsconfig.json`, README, spec |
| `ta5500-rag/mcp/server.mjs` (modified) | `structuredContent` on `search_plan` |

Decision recorded here (differs from spec §5.0 wording): agents build their state from our own `agentRuntimeChannels()` (same channel names and semantics as the SDK's `createAgentRuntimeStateWithSharedState()`), because the SDK's utils module cannot load in Node and the contract must be testable. Task 1 updates the spec line.

---

### Task 1: Test runner and the 5.1 agent runtime contract

**Files:**
- Create: `src/agents/agentRuntime.ts`, `src/agents/__tests__/agentRuntime.test.ts`
- Modify: `package.json` (scripts), `tsconfig.json`, `docs/superpowers/specs/2026-11-14-plan-aware-assistant-design.md` (§5.0 line)

**Interfaces:**
- Produces:
  - `agentRuntimeChannels()` → object of LangGraph `Annotation` channels: `agentExecutionContext` (last value wins), `outputMessage` (string, appended with blank line), `summary` (string, last wins), `status` (`"success" | "failed" | "unknown" | undefined`, last wins), `sharedStatePatch` (object, shallow-merged). Spread into `Annotation.Root({ ...agentRuntimeChannels(), ...own })`.
  - `readAgentRequest(state: { agentExecutionContext?: Partial<AgentRunContext> }): { request: string; userRequest: string; messages: BaseMessage[]; sharedState: Record<string, { value: unknown }> }` — `request` = trimmed `assignedTask`, else `userRequest`, else last human message text; `messages` defaults to `[]`.
  - `agentResult(p: { output: string; summary?: string; ok: boolean; sharedStatePatch?: Record<string, { value: unknown }> })` → `{ outputMessage, summary, status, sharedStatePatch? }` (`summary` defaults to the first 120 chars of `output`).
  - `type AgentRunContext = { userRequest: string; assignedTask: string; messages: BaseMessage[]; priorSteps: unknown[]; sharedState: Record<string, { value: unknown }> }`.

- [ ] **Step 1: Add the runner.** `package.json` scripts: `"test": "tsx --test src/agents/__tests__/*.test.ts src/ta5500/__tests__/*.test.ts"`. `tsconfig.json`: add `"exclude": ["src/**/__tests__/**"]` (test files use Node types that the app config does not load).

- [ ] **Step 2: Write the failing tests** in `src/agents/__tests__/agentRuntime.test.ts`:
  - `"graph node sees the 5.1 request"` — build `new StateGraph(Annotation.Root({ ...agentRuntimeChannels() }))` with one node that returns `agentResult({ output: readAgentRequest(state).request, ok: true })`; invoke it with exactly what the 5.1 orchestrator sends: `{ agentExecutionContext: { userRequest: "אילו נקודות תשתית מתוכננות בנאות אפקה?", assignedTask: "", messages: [], priorSteps: [], sharedState: {} } }`; assert `out.outputMessage === "אילו נקודות תשתית מתוכננות בנאות אפקה?"` and `out.status === "success"`.
  - `"assignedTask wins over userRequest"` — `assignedTask: "t1"`, `userRequest: "u"` → `request === "t1"`.
  - `"falls back to last human message"` — no task/request, `messages: [new HumanMessage("a"), new AIMessage("b"), new HumanMessage("c")]` → `"c"`.
  - `"agentResult failed"` — `agentResult({ output: "x", ok: false }).status === "failed"`, `summary === "x"`.

- [ ] **Step 3: Run** `npm test`. Expected: FAIL, `agentRuntime` module not found.

- [ ] **Step 4: Implement `src/agents/agentRuntime.ts`** with the interfaces above (imports from `@langchain/langgraph/web` and `@langchain/core/messages` only).

- [ ] **Step 5: Run** `npm test`. Expected: 4 pass, 0 fail.

- [ ] **Step 6: Update spec §5.0** first sentence to: "state from `agentRuntimeChannels()` (`src/agents/agentRuntime.ts`, same channels as the SDK's `createAgentRuntimeStateWithSharedState()`, testable in Node) plus its own channels".

- [ ] **Step 7: Commit** `git add package.json tsconfig.json src/agents/agentRuntime.ts src/agents/__tests__ docs/superpowers/specs && git commit -m "feat(agents): 5.1 agent runtime contract helpers and node test runner"`

### Task 2: Migrate the existing custom agents to 5.1; pin versions

**Files:**
- Modify: `src/agents/McpPassthroughAgent.ts`, `CreateFeatureLayerAgent.ts`, `ManageFeatureLayerAgent.ts`, `AddLayerToMapAgent.ts`, `AllCapabilitiesAgent.ts`, `src/utils/agentHelpers.ts` (`extractLastUserText`), `package.json`

**Interfaces:**
- Consumes: `agentRuntimeChannels`, `readAgentRequest`, `agentResult` (Task 1).

- [ ] **Step 1: Migrate each agent.** State = `Annotation.Root({ ...agentRuntimeChannels(), ...existingOwnChannels })` with the agent's own `messages` channel kept only where the agent loops over tool messages (McpPassthrough), seeded in its first node from `readAgentRequest(state).messages`. User text comes from `readAgentRequest(state).request` (replacing `extractLastUserText` / `extractLastHumanMessageText` reads of `state.messages`). Every terminal return goes through `agentResult` (`ok: false` on the existing error/early-exit paths, e.g. discovery errors, "Awaiting clarification" stays `ok: true`).
- [ ] **Step 2: Fix** the tsc error at `McpPassthroughAgent.ts:821` by typing the timer as `ReturnType<typeof setTimeout>`.
- [ ] **Step 3: Pin versions** in `package.json` (Global Constraints), run `npm install`, confirm `package-lock.json` changed only in those entries' specifiers.
- [ ] **Step 4: Verify** `npx tsc --noEmit` → no output; `npm test` → all pass.
- [ ] **Step 5: Manual check** (dev stack per README): ask "אילו נקודות תשתית מתוכננות בנאות אפקה?" → the answer is plan text (no "how can I help?"); ask "what layers are in this webmap?" → still works; "create a point layer named Sites" → the CreateFeatureLayer agent asks or creates as before.
- [ ] **Step 6: Commit** `git commit -am "fix(agents): migrate custom agents to the 5.1 agent contract; pin ArcGIS versions"`

### Task 3: MCP client, RAG client and `structuredContent`

**Files:**
- Create: `src/utils/mcpClient.ts`, `src/ta5500/types.ts`, `src/ta5500/ragClient.ts`, `src/ta5500/__tests__/ragClient.test.ts`, `src/ta5500/__tests__/fixtures/locations.json`, `src/ta5500/__tests__/fixtures/search-610.json`
- Modify: `src/agents/McpPassthroughAgent.ts` (import from `mcpClient`), `ta5500-rag/mcp/server.mjs`

**Interfaces:**
- Produces (`mcpClient.ts`, moved code, same behaviour and timeouts): `mcpRequest(endpointUrl, method, params?, timeoutMs?)`, `ensureInitialized(endpointUrl)`, `listMcpTools(endpointUrl): Promise<McpToolDef[]>`, `callMcpTool(endpointUrl, name, args): Promise<string>`, `callMcpToolRaw(endpointUrl, name, args): Promise<McpToolResult>`, `clearMcpCaches(endpointUrl)`, `type McpToolResult = { content?: unknown; structuredContent?: unknown; isError?: boolean }`.
- Produces (`types.ts`): `PlanLocations = { areas: {code: string; name: string}[]; subareas: {code: string; area: string; name: string}[]; entities: {code: string; type: string; label: string; areas: string[]}[]; zone_types: {id: string; title: string; category: string}[]; zone_categories: {id: string; title: string}[]; gis_codes: GisCode[] }`; `GisCode = { layer: string; code: string; key: "zone_types" | "headings"; value: string; note?: string }`; `PlanHit = { citation: string; pages: string; via: string; heading_path: string }`; `PlanSearchResult = { text: string; band: "high" | "medium" | "low"; location: { areas: string[]; subareas: string[]; zone_types: string[]; entities: string[] }; hits: PlanHit[] }`; `PlanFilters = { areas?: string[]; entities?: string[]; zone_types?: string[]; headings?: string[] }`.
- Produces (`ragClient.ts`): `parseSearchPlanResult(r: McpToolResult): PlanSearchResult` (throws `PlanServiceError` with the Hebrew message `"שירות תוכנית המתאר אינו זמין כרגע. נסו שוב בעוד מספר דקות."` when `isError` or no text), `searchPlan(endpointUrl, question: string, filters: PlanFilters): Promise<PlanSearchResult>` (calls `ta5500__search_plan`), `getPlanLocations(endpointUrl): Promise<PlanLocations>` (calls `ta5500__get_plan_locations`, cached for the session), `class PlanServiceError extends Error`.

- [ ] **Step 1 (RAG): add `structuredContent`** to the `search_plan` success return in `ta5500-rag/mcp/server.mjs`: `{ band: r.band, location: { areas, subareas, zone_types, entities } from r.location, hits: r.hits.map(h => ({ citation: h.citation, pages: <page_start>-<page_end> or single, via: h.via, heading_path: h.heading_path })) }`. No `outputSchema` (keeps existing callers valid).
- [ ] **Step 2 (RAG): verify through the hub** (restart `npm run hub:dev`): the README step-7 curl with `| python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(sorted(r['structuredContent']), len(r['structuredContent']['hits']))"` prints `['band', 'hits', 'location'] <n>` with n > 0. Commit in `ta5500-rag`: `git commit -am "mcp: search_plan returns structuredContent (location, band, hit citations)"`.
- [ ] **Step 3: Save fixtures**: `fixtures/locations.json` = the JSON text of `ta5500__get_plan_locations` via the hub; `fixtures/search-610.json` = the full `result` of `ta5500__search_plan` with `{"question":"מה תוכנית הפיתוח העסקי באזור 610?"}`.
- [ ] **Step 4: Write failing tests** `ragClient.test.ts`: `"parses structured search"` (fixture → `band` in `["high","medium","low"]`, `location.areas` includes `"610"`, `hits.length > 0`, `text` starts with `"רמת התאמה"`); `"isError throws PlanServiceError"` (`{ isError: true, content: [{type:"text", text:"x"}] }` → throws, message is the Hebrew text above).
- [ ] **Step 5: Run** `npm test` → FAIL (module missing).
- [ ] **Step 6: Implement** `mcpClient.ts` (move, do not rewrite, the helpers from `McpPassthroughAgent.ts` lines 226–420 with their caches; McpPassthrough imports them), `types.ts`, `ragClient.ts`.
- [ ] **Step 7: Run** `npm test` → pass; `npx tsc --noEmit` → clean; the McpPassthrough manual check from Task 2 step 5 still answers.
- [ ] **Step 8: Commit** `git add src && git commit -m "feat(ta5500): MCP client module and RAG client with structured search results"`

### Task 4: TA5500 layer configuration and matching

**Files:**
- Create: `src/ta5500/layers.ts`, `src/ta5500/__tests__/layers.test.ts`

**Interfaces:**
- Produces:
  - `type LayerKey = "areas" | "zones" | "foci" | "spaces" | "streets" | "employment"`.
  - `TA5500_LAYERS: Record<LayerKey, { layerId: number; codeFields: string[]; displayField?: string; label: string }>` with values: `areas` 122 `["NumEzorTihnun"]` "אזורי תכנון"; `zones` 128 `["EzorYeudCode"]` display `EzorYeud` "אזורי ייעוד"; `foci` 124 `["TypeCode"]` display `TypeName` "מוקדי פיתוח ושימוש עירוניים"; `spaces` 145 `["mis_ezor"]` display `shem_ezor` "מרחבי תכנון"; `streets` 146 `["mis_ezor"]` display `shem_ezor` "הוראות רחוב מיוחדות"; `employment` 126 `["TypeCode2", "TypeCode"]` "תעסוקה". (`codeFields`: the first field that exists on the layer is used — this settles spec open item 2 at runtime.)
  - `TOPIC_OVERRIDES: { words: string[]; filters: PlanFilters }[]` with one entry: words `["פיתוח עסקי", "פיתוח כלכלי", "תעסוקה", "מסחר", "מסחרי", "עסקים"]` → `{ zone_types: ["3.3", "3.4.1"] }`.
  - `matchTa5500LayerUrl(url: string): { layerKey: LayerKey; layerId: number } | null` — decodes the URL, requires a path segment `services/TA5500_<anything>/(FeatureServer|MapServer)/<id>` and `<id>` in `TA5500_LAYERS`.
  - `matchTopicOverrides(text: string): PlanFilters` — merges the filters of every entry with a word contained in `text` (Hebrew prefixes ו/ה/ב/ל/מ/ש allowed before the word).
  - `type MapLayerLike = { uid: string; url?: string | null; layerId?: number | null; type: string }` and `findTa5500Layers(layers: MapLayerLike[]): Map<LayerKey, MapLayerLike[]>` (uses `url` + `layerId` if `url` has no trailing id).

- [ ] **Step 1: Failing tests** `layers.test.ts`:
  - `matchTa5500LayerUrl("https://services3.arcgis.com/abc/arcgis/rest/services/TA5500_%D7%A4%D7%95%D7%9C%D7%999%D7%92%D7%95%D7%A0%D7%99%D7%9D1/FeatureServer/122")` → `{ layerKey: "areas", layerId: 122 }`; same service with `/999` → `null`; `.../services/Other/FeatureServer/122` → `null`.
  - `findTa5500Layers` with two instances (`uid` "a", "b") of 128 and one of 124 → `zones` has 2 entries, `foci` 1.
  - `matchTopicOverrides("מה תוכנית הפיתוח העסקי באזור 610?")` → `{ zone_types: ["3.3", "3.4.1"] }`; `matchTopicOverrides("מה מותר לבנות באזור 610?")` → `{}`; `"ובמסחר"` matches.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** `layers.ts`.
- [ ] **Step 4: Run** `npm test` → pass.
- [ ] **Step 5: Commit** `git add src/ta5500 && git commit -m "feat(ta5500): layer config, URL matching and topic overrides"`

### Task 5: Request validation, cited sections and reverse `gis_codes`

**Files:**
- Create: `src/ta5500/planLogic.ts`, `src/ta5500/__tests__/planLogic.test.ts`

**Interfaces:**
- Consumes: `PlanLocations`, `PlanFilters`, `PlanHit`, `PlanSearchResult`, `GisCode` (Task 3), `LayerKey`, `TA5500_LAYERS` (Task 4).
- Produces:
  - `validateRequest(c: PlanFilters, loc: PlanLocations): { filters: PlanFilters; dropped: string[] }` — keeps areas that are area or sub-area codes (normalizing `"101 ה'"`, `"ה101"`, `"101-ה"` to `"101ה"`), entities whose code or label matches an entity, zone types that are a zone-type id, category id or exact title (title → id), headings that look like `\d+(\.\d+)*(\([^)]+\))*`; everything else into `dropped`.
  - `citedSections(result: PlanSearchResult, citedIndexes: number[]): string[]` — for each 1-based index, the section ids parsed from the hit citation (`סעיף 3.3.2(ב)` → `3.3.2`; `סעיפים 3.10, 3.11` → both; `סעיף 4.7.1(ב)-(ג)` → `4.7.1`); if any cited hit's citation starts with `טבלה 5.4`, add `result.location.zone_types`. Deduplicated, order kept.
  - `layersForSections(sections: string[], gis: GisCode[]): Map<LayerKey, string[]>` — a `gis_codes` entry matches a section when `value === section`, or `section` starts with `value + "("`, or `value` starts with `section + "."` (a cited category covers its types). Entries whose `layer` is not a `LayerKey` are ignored. Codes deduplicated.
  - `isInsideExtent(p: { x: number; y: number }, e: { xmin: number; ymin: number; xmax: number; ymax: number }): boolean`.

- [ ] **Step 1: Failing tests** (`planLogic.test.ts`, using `fixtures/locations.json`):
  - `validateRequest({ areas: ["610", "999", "101 ה'"], zone_types: ["אזור מעורב", "3.3"], headings: ["4.3", "abc"] }, loc)` → `filters` `{ areas: ["610", "101ה"], zone_types: ["3.4.1", "3.3"], headings: ["4.3"] }`, `dropped` contains `"999"` and `"abc"`.
  - `layersForSections(["3.3.2(ב)"], gis)` → `zones: ["332"]`, `employment: ["3321","3322","3323"]`.
  - `layersForSections(["3.3"], gis)` → `zones` ⊇ `["332","333","334"]`, `foci` ⊇ `["335"]`.
  - `layersForSections(["4.3"], gis)` → empty map (Review Focus 3).
  - `citedSections` on `fixtures/search-610.json` with `[1]` → non-empty, every id matches `/^\d+(\.\d+)*$/`.
  - `isInsideExtent({x:5,y:5},{xmin:0,ymin:0,xmax:10,ymax:10})` true; `{x:11,y:5}` false.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** `planLogic.ts`.
- [ ] **Step 4: Run** `npm test` → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(ta5500): request validation, cited sections and reverse gis_codes"`

### Task 6: Focus planning, where clauses and focus store

**Files:**
- Create: `src/ta5500/focus.ts`, `src/ta5500/__tests__/focus.test.ts`

**Interfaces:**
- Consumes: `LayerKey`, `TA5500_LAYERS` (Task 4).
- Produces:
  - `type Place = { kind: "area" | "subarea" | "street" | "geocoded"; codes: string[]; label: string }`.
  - `type FocusCase = "place_topic" | "place_only" | "topic_only" | "none"`; `planFocus(place: Place | null, candidates: Map<LayerKey, string[]>): { case: FocusCase; layers: Map<LayerKey, string[]> }` — `place_only` returns `layers = { zones: [] }` meaning "zones layer, all codes" (spec: show zones clipped to the place).
  - `buildCodeWhere(field: string, fieldType: "string" | "number", codes: string[]): string` — `[]` → `"1=1"`; string → `EzorYeudCode IN ('332','333')` with `'` doubled; number → `TypeCode IN (335)`, non-numeric codes dropped; if nothing remains → `"1=0"`.
  - `type FocusState = { place: Place | null; geometryJson: unknown | null; layers: { layerKey: LayerKey; where: string }[]; previousVisibility: Record<string, boolean>; label: string }` (keys of `previousVisibility` are layer `uid`s).
  - `focusStore`: `get(): FocusState | null`, `set(s: FocusState): void`, `clear(): FocusState | null` (returns the cleared state), `subscribe(fn: (s: FocusState | null) => void): () => void`.
  - `focusLabel(place: Place | null, layerLabels: string[]): string` → `"מיקוד: אזור 610"`, `"מיקוד: אזורי תעסוקה"` when no place, `"מיקוד: רמת אביב"` for geocoded.

- [ ] **Step 1: Failing tests** `focus.test.ts`:
  - `planFocus({kind:"area",codes:["610"],label:"אזור 610"}, new Map([["zones",["332"]]])).case === "place_topic"`; with empty map → `"place_only"` and `layers.get("zones")` deep-equals `[]`; `planFocus(null, new Map([["foci",["335"]]])).case === "topic_only"`; `planFocus(null, new Map()).case === "none"`.
  - `buildCodeWhere("EzorYeudCode","string",["332","3'3"]) === "EzorYeudCode IN ('332','3''3')"`; `buildCodeWhere("TypeCode","number",["335","x"]) === "TypeCode IN (335)"`; `buildCodeWhere("TypeCode","number",["x"]) === "1=0"`; `buildCodeWhere("f","string",[]) === "1=1"`.
  - store: `set` then `clear()` returns the state and `get()` is `null`; a subscriber is called on `set` and on `clear`; `previousVisibility` keeps two different uids of the same layer (Review Focus 4).
  - `focusLabel({kind:"area",codes:["610"],label:"אזור 610"}, []) === "מיקוד: אזור 610"`.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** `focus.ts`.
- [ ] **Step 4: Run** `npm test` → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(ta5500): focus planning, where clauses and focus store"`

### Task 7: ArcGIS focus operations (`mapFocus.ts`)

**Files:**
- Create: `src/ta5500/mapFocus.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces (all take the `MapView` from `document.querySelector("#main-map").view`, following the existing pattern in `featureLayerEdits.ts`):
  - `getView(): __esri.MapView | null`.
  - `listTa5500Layers(view): Map<LayerKey, __esri.FeatureLayer[]>` (via `findTa5500Layers` over `view.map.allLayers` of type `feature`).
  - `codeFieldOf(layer): { name: string; type: "string" | "number" } | null` (first of `TA5500_LAYERS[key].codeFields` present in `layer.fields`).
  - `resolvePlaceGeometry(view, place: Place): Promise<__esri.Polygon | null>` — layer per kind (`area`→`areas`, `subarea`→`spaces`, `street`→`streets`), `queryFeatures({ where: buildCodeWhere(...), returnGeometry: true, outSpatialReference: view.spatialReference })`, union with `unionOperator`; `geocoded` places carry their geometry already (see `geocodeInTelAviv`).
  - `geocodeInTelAviv(view, text: string): Promise<{ place: Place; geometry: __esri.Polygon | __esri.Extent } | { outside: true } | null>` — World Geocoder `addressToLocations` with `searchExtent` = `telAvivExtent(view)`; first candidate's `location` outside `telAvivExtent` (via `isInsideExtent`) → `{ outside: true }`; inside → planning areas intersecting the candidate extent (query layer 122) become `place.codes`, `kind: "geocoded"`.
  - `telAvivExtent(view): __esri.Extent | null` — union of `fullExtent` of the `areas` layer instances, projected to the view SR.
  - `keepLayersWithFeatures(view, layers: Map<LayerKey, string[]>, geometry: __esri.Geometry | null): Promise<{ kept: Map<LayerKey, string[]>; skipped: LayerKey[] }>` — `queryFeatureCount` with the code where clause and the geometry (`spatialRelationship: "intersects"`) on the first instance of each key.
  - `applyFocus(view, plan: { case: FocusCase; layers: Map<LayerKey, string[]> }, place: Place | null, geometry: __esri.Geometry | null): Promise<FocusState>` — per spec §5.3 step 4.4: place cases use `layerView.filter = new FeatureFilter({ where, geometry, spatialRelationship: "intersects" })` on every instance, outline graphic in a `GraphicsLayer` with id `ta5500-focus-outline` (listMode `hide`), `view.goTo(geometry.extent.expand(1.2))`; `topic_only` uses `layer.featureEffect = new FeatureEffect({ filter: new FeatureFilter({ where }), excludedEffect: "grayscale(100%) opacity(35%)" })` and `goTo` the `queryExtent` of matches; all non-kept TA5500 and other operational feature layers get `visible = false` with their previous value stored by `uid`. Calls `focusStore.set`. Clears any previous focus first.
  - `resetFocus(view): Promise<void>` — from `focusStore.clear()`: restore visibility by uid, set `layerView.filter = null` and `featureEffect = null` on all TA5500 instances, remove the outline layer.

- [ ] **Step 1: Implement** `mapFocus.ts` (browser-only; no Node test).
- [ ] **Step 2: Type-check** `npx tsc --noEmit` → clean.
- [ ] **Step 3: Manual check** with the dev stack on the TA5500 map, from the browser console after `const m = await import("/src/ta5500/mapFocus.ts")`:
  - `const v = m.getView(); m.listTa5500Layers(v)` → a Map with at least `areas`, `zones`, `foci`; note in the commit message which field `codeFieldOf` picked for `employment`.
  - `await m.applyFocus(v, { case: "place_topic", layers: new Map([["zones", ["332","333","334"]]]) }, { kind: "area", codes: ["610"], label: "אזור 610" }, await m.resolvePlaceGeometry(v, { kind: "area", codes: ["610"], label: "אזור 610" }))` → map zooms to 610, outline drawn, only zone features inside 610 shown, other layers hidden.
  - `await m.resetFocus(v)` → every layer back to its previous visibility, no outline, no filters.
  - `await m.geocodeInTelAviv(v, "פריז")` → `{ outside: true }`; `"רמת אביב"` → a place with ≥ 1 area code.
- [ ] **Step 4: Commit** `git commit -m "feat(ta5500): map focus operations (filter, highlight, outline, reset, geocode in Tel Aviv)"`

### Task 8: Descriptions, prompts and Hebrew copy

**Files:**
- Create: `src/ta5500/prompts.ts`, `src/ta5500/__tests__/prompts.test.ts`

**Interfaces:**
- Produces: `PLAN_AGENT_DESCRIPTION`, `MAP_AGENT_DESCRIPTION`, `SCOPE_AGENT_DESCRIPTION`, `MCP_NOT_PLAN_SUFFIX` (the four texts in spec §5.2, verbatim); `RESOLVE_PROMPT` (instructions for the resolve call: produce a standalone Hebrew question resolving references from history and from `{currentFocus}`; extract candidate areas / entities / zone types / headings / free-text place; intent `answer | refine_focus | clear_focus`; never invent codes); `ANSWER_PROMPT` (spec §5.3 step 3 rules; inputs `{question}`, `{context}`; output Hebrew answer plus the 1-based numbers of the context items used); `MAP_RESOLVE_PROMPT` (action `go_to | show | hide | filter | reset`, place text, topic text); `SCOPE_REPLY = "אני עובד רק על תוכנית המתאר תא/5500 ועל מפת תל אביב-יפו. אפשר לשאול למשל: \"מה מותר לבנות באזור 610?\" או \"הצג את אזורי התעסוקה ברמת אביב\"."`; `NO_PLACE_NOTE = "לא זיהיתי את המקום שציינת, ולכן המפה לא שונתה."`; `OUTSIDE_TA_REPLY = "המקום שציינת נמצא מחוץ לתל אביב-יפו, ואני עובד רק על תוכנית המתאר של העיר."`; `MAP_FAILED_NOTE = "לא הצלחתי לעדכן את המפה."`; `shownLine(placeLabel: string | null, layerLabels: string[], skipped: string[]): string` → e.g. `"מוצגים באזור 610: אזורי ייעוד, מוקדי פיתוח ושימוש עירוניים. לא נמצאו באזור: תעסוקה."`.

- [ ] **Step 1: Failing test** `prompts.test.ts`: each description is non-empty, contains `"Do NOT use"`; `PLAN_AGENT_DESCRIPTION` contains `"תא/5500"` and `"610"`; `shownLine("אזור 610", ["אזורי ייעוד"], ["תעסוקה"])` equals `"מוצגים באזור 610: אזורי ייעוד. לא נמצאו באזור: תעסוקה."`; `shownLine(null, ["מוקדי פיתוח ושימוש עירוניים"], [])` equals `"מוצגים במפה: מוקדי פיתוח ושימוש עירוניים."`.
- [ ] **Step 2: Run** `npm test` → FAIL. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `git commit -m "feat(ta5500): agent descriptions, prompts and Hebrew copy"`

### Task 9: Plan agent

**Files:**
- Create: `src/agents/PlanAgent.ts`

**Interfaces:**
- Consumes: Tasks 1, 3–8; `invokeStructuredPrompt` from `@arcgis/ai-components/utils/index.js`.
- Produces: `registerPlanAgent(assistant: HTMLElement, ctx: { baseUrl: string }): void` (agent id `ta5500-plan`, name `"TA5500 Plan"`, description `PLAN_AGENT_DESCRIPTION`; DOM registration identical to the existing agents).

Graph: `resolve → search → answer → focus → END`, `clear_focus` short-circuits `resolve → END` after `resetFocus`. Node contracts:
- `resolve`: `invokeStructuredPrompt({ promptText: RESOLVE_PROMPT, messages: readAgentRequest(state).messages, inputVariables: { request, currentFocus: focusStore.get()?.label ?? "none" }, schema: z.object({ question: z.string(), areas: z.array(z.string()), entities: z.array(z.string()), zone_types: z.array(z.string()), headings: z.array(z.string()), placeText: z.string().nullable(), intent: z.enum(["answer","refine_focus","clear_focus"]) }) })`; then `validateRequest` with `getPlanLocations`; merge `matchTopicOverrides(question)`; place = first validated area/sub-area/street entity, else `geocodeInTelAviv(placeText)` (outside → reply `OUTSIDE_TA_REPLY`, `ok: true`, stop), else the stored focus place when `intent === "refine_focus"`, else `null` (if `placeText` was given → append `NO_PLACE_NOTE`).
- `search`: `searchPlan(baseUrl, question, filters)`; `PlanServiceError` → `agentResult({ output: err.message, ok: false })`, focus untouched.
- `answer`: `invokeStructuredPrompt({ promptText: ANSWER_PROMPT, inputVariables: { question, context: result.text }, schema: z.object({ answer: z.string(), usedItems: z.array(z.number().int().positive()) }) })`.
- `focus`: `layersForSections(citedSections(result, usedItems), locations.gis_codes)` merged with the override zone types through `layersForSections(overrideFilters.zone_types ?? [], locations.gis_codes)` (an override category such as `3.3` covers its types); `planFocus` → `keepLayersWithFeatures` → `applyFocus` (skip when case `none`); errors → append `MAP_FAILED_NOTE`, keep the answer. Output = `answer + "\n\n" + shownLine(...)`. Return `agentResult({ output, ok: true, summary: "<placeLabel|no place>; layers: <keys>", sharedStatePatch: { ta5500Focus: { value: { label, layers } } } })`.

- [ ] **Step 1: Implement** `PlanAgent.ts`; register it in Task 11 (not yet).
- [ ] **Step 2: Type-check** `npx tsc --noEmit` → clean; `npm test` → pass.
- [ ] **Step 3: Commit** `git commit -m "feat(agents): TA5500 Plan agent (resolve, search, answer, focus)"`

### Task 10: Map agent and Scope agent

**Files:**
- Create: `src/agents/Ta5500MapAgent.ts`, `src/agents/ScopeAgent.ts`

**Interfaces:**
- Consumes: Tasks 1, 4–8.
- Produces: `registerTa5500MapAgent(assistant, ctx: { baseUrl: string })` (id `ta5500-map`, name `"TA5500 Map"`); `registerScopeAgent(assistant)` (id `ta5500-scope`, name `"Out of scope"`).

Map agent: one `invokeStructuredPrompt` with `MAP_RESOLVE_PROMPT` and schema `{ action: enum(go_to, show, hide, filter, reset), placeText: string|null, topicText: string|null }`; place resolution exactly as in the Plan agent (codes first via `validateRequest` on the text, then `geocodeInTelAviv`; outside → `OUTSIDE_TA_REPLY`); topic → `validateRequest({ zone_types: [topicText] }, await getPlanLocations(baseUrl))` merged with `matchTopicOverrides(topicText)` → `layersForSections(zoneTypes, locations.gis_codes)`. `go_to` = `goTo` the place geometry (no filters); `show`/`filter` = `applyFocus` with `planFocus(place, layers)`; `hide` = set `visible = false` on the matched TA5500 instances; `reset` = `resetFocus`. Reply in Hebrew stating what was done (`shownLine` for show/filter).

Scope agent: no LLM call; returns `agentResult({ output: SCOPE_REPLY, ok: true })`.

- [ ] **Step 1: Implement** both files.
- [ ] **Step 2: Type-check** → clean; `npm test` → pass.
- [ ] **Step 3: Commit** `git commit -m "feat(agents): TA5500 Map agent and out-of-scope agent"`

### Task 11: TA5500 mode, registration and routing wiring

**Files:**
- Create: `src/hooks/useTa5500Mode.ts`
- Modify: `src/hooks/useAssistantSetup.ts`, `src/components/AssistantPanel.tsx`, `src/App.tsx`, `src/agents/McpPassthroughAgent.ts`

**Interfaces:**
- Consumes: `listTa5500Layers`, `telAvivExtent`, `getView` (Task 7); the register functions (Tasks 9–10).
- Produces: `useTa5500Mode(isMapReady: boolean, webMapId: string): boolean` — true when `listTa5500Layers(view).get("areas")?.length`; on true sets `view.constraints.geometry = telAvivExtent(view).expand(1.3)`; on false/unmount sets it back to `null`.

- [ ] **Step 1: `useAssistantSetup`** takes `isTa5500: boolean`; agents are registered from one array `const registrations = [...]` with an `enabled` flag per entry, so any agent can be switched off in TA5500 mode by flipping one flag (spec §7). In TA5500 mode add Plan, Map, Scope; the existing custom agents stay enabled.
- [ ] **Step 2: `McpPassthroughAgent`**: filter out tools whose server id is `ta5500` when building its tool list and description; append `MCP_NOT_PLAN_SUFFIX` to its description.
- [ ] **Step 3: `AssistantPanel`**: render `<arcgis-assistant-navigation-agent>` only when `!isTa5500`; set `logEnabled` on the assistant element when the URL has `?mode=edit` (shows "Executing registered agent: …" in the chat for routing tests). `App.tsx` passes `isTa5500` from the hook.
- [ ] **Step 4: Type-check** → clean. **Manual:** on the TA5500 map, the console shows the three agents registered and the navigation agent absent; panning far away from Tel Aviv is blocked; on another web map nothing changes.
- [ ] **Step 5: Commit** `git commit -m "feat(ta5500): TA5500 mode detection, agent registration and routing wiring"`

### Task 12: Focus chip and reset on new conversation

**Files:**
- Create: `src/components/FocusChip.tsx`
- Modify: `src/components/AssistantPanel.tsx`, `src/main.tsx` + `src/types/custom-elements.d.ts` (only if a new Calcite element is used; use `calcite-chip`, closable)

**Interfaces:**
- Consumes: `focusStore` (Task 6), `resetFocus`, `getView` (Task 7).
- Produces: `<FocusChip />` — subscribes to `focusStore`; renders nothing when `null`; otherwise a closable `calcite-chip` with the state's `label`; closing calls `resetFocus(getView())`.

- [ ] **Step 1: Implement** `FocusChip`, place it above the assistant in `AssistantPanel`; `handleNewChat` also calls `resetFocus`.
- [ ] **Step 2: Type-check** → clean. **Manual:** after a plan question with a place the chip shows "מיקוד: אזור 610"; ✕ restores the map; "שיחה חדשה" restores the map and hides the chip; RTL layout correct.
- [ ] **Step 3: Commit** `git commit -m "feat(ui): focus chip and reset on new conversation"`

### Task 13: Routing test set, end-to-end check, docs

**Files:**
- Create: `docs/routing-questions.yml`
- Modify: `README.md` (TA5500 section: what the three agents do, how to run the routing set with `?mode=edit`, remove the "generic how can I help" troubleshooting row), spec §6 (routing set path `docs/routing-questions.yml`), `CLAUDE.md` (agents section: 5.1 contract via `agentRuntime.ts`, `src/ta5500/`, `npm test`)

- [ ] **Step 1: Write `docs/routing-questions.yml`** — entries `{ q, kind: plan | plan+place | map | out_of_scope | other_agent, expect: <agent id or built-in name> }`, at least 25, including: "מה תוכנית הפיתוח העסקי באזור 610?" (plan+place → ta5500-plan), "אילו נקודות תשתית מתוכננות בנאות אפקה?" (plan+place), "מה מותר לבנות באזור 610?" (plan+place), "מה אומר סעיף 4.3?" (plan), "ומה לגבי מגורים שם?" after a 610 question (plan+place refine), "נקה מיקוד" (ta5500-plan), "קח אותי לרמת אביב" (ta5500-map), "הצג רק אזורי מגורים" (ta5500-map), "אפס את המפה" (ta5500-map), "כמה מוקדי תעסוקה יש במפה?" (data exploration), "נווט לפריז" (ta5500-scope or ta5500-map declining), "מה מזג האוויר היום?" (ta5500-scope), "create a point layer named Sites" (other_agent), a question about a place the RAG cannot place, and a question whose answer cites only chapter 4. Leave a `# team questions` block for the users' own wording (spec open item 1).
- [ ] **Step 2: Run the set by hand** on the TA5500 map with `?mode=edit`; record pass/fail per entry in the YAML (`result:` field). Adjust only descriptions/prompts in `prompts.ts` for failures; re-run until all `plan`, `plan+place`, `map` and `out_of_scope` entries pass.
- [ ] **Step 3: Manual end-to-end** (spec §6): the four focus cases; a neighborhood name; a follow-up; clear by chip and by text; a place outside Tel Aviv; an unrelated topic; RAG down (`docker compose stop service` in `ta5500-rag`) → Hebrew unavailable message and focus untouched; then `docker compose start service`.
- [ ] **Step 4: Update README, spec §6 path, CLAUDE.md** as listed above.
- [ ] **Step 5: Verify** `npm test` → all pass; `npx tsc --noEmit` → clean; `npm run build` → succeeds.
- [ ] **Step 6: Commit** `git add docs README.md CLAUDE.md && git commit -m "docs: routing test set, TA5500 assistant usage, contributor notes"`
