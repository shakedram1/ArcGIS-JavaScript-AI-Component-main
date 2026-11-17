# Map Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The TA5500 Map and Plan agents know the map's layer groups (the plan's 5 drawings), ask the user when a layer or a place name is ambiguous, show whole layers at their extent, and reset the map to its startup state.

**Architecture:** A pure layer catalog (`src/ta5500/catalog.ts`) matches request text against (group, layer title) entries read from the live map; a pure place-name matcher in `planFlow.ts` finds planning areas by name. Agents turn ambiguity into a Hebrew question and leave the map unchanged; the next user turn answers it through the conversation history. `applyFocus` gains whole layers (by uid); `resetFocus` restores a baseline captured when TA5500 mode starts (`src/ta5500/baseline.ts`).

**Tech Stack:** TypeScript, React 18, ArcGIS Maps SDK 5.1 (`@arcgis/core`), LangGraph web, Zod, `node:test` via tsx.

**Spec:** [docs/superpowers/specs/2026-11-17-map-interaction-design.md](../specs/2026-11-17-map-interaction-design.md)

## Global Constraints

- User-facing strings are Hebrew, gender-neutral; layouts RTL-safe (CLAUDE.md).
- Pure modules in `src/ta5500/` (`catalog.ts`, `baseline.ts`, `planFlow.ts`, `focus.ts`, `prompts.ts`) import nothing from `@arcgis/*` at runtime; only `mapFocus.ts` touches the MapView.
- Agents read the request with `readAgentRequest()` and return through `agentResult()`; a question to the user is `ok: true` with a summary ending "do not retry".
- After changing any agent description, add/re-run entries in `docs/routing-questions.yml`.
- Verification for every task: `npm test`, `npx tsc --noEmit`, `npm run typecheck:test` all clean.
- Never geocode the plan's own name or the city (already enforced by `placeTextStep`).

## Review Focus

1. A chosen layer whose **parent group is hidden** at startup must still appear: its hidden ancestors are made visible and recorded for reset — test in Task 3 (`ancestorsToShow`).
2. An **answer to the clarification that names a group lacking the layer** ("מוקדי פיתוח בתחבורה") asks again with the valid groups — test in Task 2.
3. **Reset with no baseline** (capture failed, map not ready) behaves as today and does not throw; layers added after startup are untouched — test in Task 6 (`visibilityChanges`).
4. **Layers the user toggled by hand** in the LayerList are restored by reset — test in Task 6.
5. A **place name that matches one area and also exists elsewhere in Israel** ("הצפון הישן") is resolved from the plan, never geocoded — test in Task 1.

---

### Task 0: Commit the plan-name fix

**Files:**
- Modify: `src/agents/PlanAgent.ts:169`, `src/agents/Ta5500MapAgent.ts:162` (remove the two diagnostic `console.info` lines)
- Already changed: `src/ta5500/planFlow.ts`, `src/ta5500/__tests__/planFlow.test.ts`, `.gitignore`

- [ ] **Step 1:** Delete the `console.info("ta5500-plan: OUTSIDE decision …")` and `console.info("ta5500-map: OUTSIDE decision …")` lines.
- [ ] **Step 2:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: all pass.
- [ ] **Step 3: Commit**

```bash
git add .gitignore src/ta5500/planFlow.ts src/ta5500/__tests__/planFlow.test.ts src/agents/PlanAgent.ts src/agents/Ta5500MapAgent.ts docs/superpowers/specs/2026-11-17-map-interaction-design.md docs/superpowers/plans/2026-11-17-map-interaction.md
git commit -m "fix(ta5500): the plan's name or the city is not a place to geocode"
```

### Task 1: Planning areas by name; ask when a name matches several

**Files:**
- Modify: `src/ta5500/planFlow.ts` (`placeTextStep`, new `placesByName`), `src/ta5500/prompts.ts` (new `whichAreaQuestion`, `RESOLVE_PROMPT` rule)
- Modify: `src/agents/PlanAgent.ts` (resolve node), `src/agents/Ta5500MapAgent.ts` (`resolvePlace`, `mapStep` call)
- Test: `src/ta5500/__tests__/planFlow.test.ts`, `src/ta5500/__tests__/prompts.test.ts`

**Interfaces:**
- Produces: `placesByName(text: string, loc: PlanLocations): Place[]`; `PlaceTextStep` gains `{ kind: "ambiguous"; options: Place[] }`; `whichAreaQuestion(text: string, options: Place[]): string`; `MapStep` gains `"ask_place"`; `mapStep` input gains `ambiguousPlace?: boolean`.

- [ ] **Step 1: Write the failing tests** (planFlow.test.ts)

```ts
test("placesByName: areas first, else sub-areas; whole words; quotes ignored", () => {
  assert.deepEqual(placesByName("רמת אביב", loc).map((p) => p.codes[0]), ["102", "103", "104", "106"]);
  assert.deepEqual(placesByName("הצפון הישן", loc).map((p) => p.codes[0]), ["301"]);
  assert.deepEqual(placesByName("שדה דב", loc).map((p) => p.codes[0]), ["101"]);
  assert.deepEqual(placesByName("רובע שדה דב", loc), [{ kind: "subarea", codes: ["101ו"], label: "אזור 101ו – רובע שדה דב" }]);
  assert.deepEqual(placesByName("רמת אביב ג'", loc).map((p) => p.codes[0]), ["102"]);
  assert.deepEqual(placesByName("דיזנגוף 50", loc), []);
});

test("placeTextStep: a name of one plan area is coded, of several is ambiguous", () => {
  assert.equal((placeTextStep("הצפון הישן", loc) as { place: Place }).place.codes[0], "301");
  assert.equal((placeTextStep("רובע שדה דב", loc) as { place: Place }).place.codes[0], "101ו");
  const amb = placeTextStep("רמת אביב", loc);
  assert.equal(amb.kind, "ambiguous");
  assert.equal((amb as { options: Place[] }).options.length, 4);
  assert.deepEqual(placeTextStep("דיזנגוף 50", loc), { kind: "geocode" });
});

test("mapStep: an ambiguous place is asked before anything else but reset", () => {
  assert.equal(mapStep("show", { placeText: "רמת אביב", place: null, layers: new Map(), ambiguousPlace: true }), "ask_place");
  assert.equal(mapStep("reset", { placeText: "רמת אביב", place: null, layers: new Map(), ambiguousPlace: true }), "reset");
});
```

In the two existing tests that assert `placeTextStep("רמת אביב", loc)` is `{ kind: "geocode" }`, change the input to `"דיזנגוף 50"`.

prompts.test.ts:

```ts
test("whichAreaQuestion lists the options and asks", () => {
  const q = whichAreaQuestion("רמת אביב", [
    { kind: "area", codes: ["102"], label: "אזור 102 – רמת אביב ג'" },
    { kind: "area", codes: ["106"], label: "אזור 106 – רמת אביב א'" },
  ]);
  assert.equal(q, "\"רמת אביב\" מתאים לכמה אזורי תכנון: אזור 102 – רמת אביב ג'; אזור 106 – רמת אביב א'. לאיזה מהם הכוונה?");
  assert.ok(RESOLVE_PROMPT.includes("which planning area"));
});
```

- [ ] **Step 2:** Run `npm test`. Expected: the new tests FAIL (`placesByName` / `whichAreaQuestion` not exported).
- [ ] **Step 3: Implement**
  - `placesByName` in `planFlow.ts`: normalize both sides by removing `'"׳״` and collapsing spaces; an area matches when `hasWord(name, text)`; return one `Place` per matching area (`kind: "area"`, label via `areaLabel`) in `loc.areas` order; if no area matches, the same over `loc.subareas` (`kind: "subarea"`).
  - `placeTextStep`: after the `coded` and `isWholePlanOrCity` checks and before `not_in_plan`/`geocode`: one name match → `coded`, several → `ambiguous`.
  - `whichAreaQuestion` in `prompts.ts`, exact copy from the test.
  - `RESOLVE_PROMPT` rule: `- If the assistant's last message asked which planning area was meant and the latest request answers it, write the question again for the chosen area and put its code in areas.` Add the same sense to `MAP_RESOLVE_PROMPT` (put the chosen code in place, keep the original action).
  - `mapStep`: after `not_in_plan`, `if (s.ambiguousPlace) return "ask_place";`.
  - Map agent: `Resolved` gains `{ ambiguous: Place[] }`; `resolvePlace` returns it for `step.kind === "ambiguous"`; `case "ask_place"` returns `agentResult({ output: whichAreaQuestion(placeText, options), ok: true, summary: "asked the user which planning area; waiting for the answer; do not retry" })`.
  - Plan agent resolve: for `step.kind === "ambiguous"` return `{ done: true, ...agentResult(<same output and summary>) }`.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ta5500): find planning areas by name and ask when a name matches several`

### Task 2: Layer catalog (pure)

**Files:**
- Create: `src/ta5500/catalog.ts`
- Create: `src/ta5500/__tests__/catalog.test.ts` (the inventory from spec §3 as a fixture array `INVENTORY: CatalogEntry[]`, uids `"<group index>-<layer index>"`, group titles with " 5500")

**Interfaces:**
- Produces:
  - `type CatalogEntry = { uid: string; title: string; group: string }`
  - `type CatalogMatch = { layers: CatalogEntry[]; ambiguous: { title: string; groups: string[] }[] }`
  - `normalizePlanText(s: string): string`
  - `groupLabel(group: string): string` — the group title without "5500" (e.g. "עיצוב עירוני")
  - `matchCatalog(text: string | null | undefined, entries: CatalogEntry[]): CatalogMatch`

- [ ] **Step 1: Write the failing tests**

```ts
const titles = (m: CatalogMatch) => m.layers.map((e) => `${e.title}|${groupLabel(e.group)}`);

test("normalizePlanText: spelling variants, plan name and quotes", () => {
  assert.equal(normalizePlanText('גבולות התוכנית תא/5500 באיזור יעוד'), "גבול התכנית באזור ייעוד");
});

test("matchCatalog: a layer in several groups and no group named → ambiguous", () => {
  const m = matchCatalog("תציג לי את גבולות התוכנית", INVENTORY);
  assert.deepEqual(m.layers, []);
  assert.deepEqual(m.ambiguous, [{ title: "גבול התכנית", groups: ["אזורי ייעוד", "עיצוב עירוני", "אזורי ומרחבי תכנון", "סביבה ותשתיות", "תחבורה וניידות"] }]);
  assert.deepEqual(matchCatalog("תציג לי את מוקדי הפיתוח", INVENTORY).ambiguous, [{ title: "מוקדי פיתוח ושימוש עירוניים", groups: ["אזורי ייעוד", "עיצוב עירוני"] }]);
});

test("matchCatalog: a named group picks one layer", () => {
  assert.deepEqual(titles(matchCatalog("אילו צירי תכנון יש באיזור ייעוד 5500 באזור הצפון הישן?", INVENTORY)), ["צירי תכנון וקווי תיחום|אזורי ייעוד"]);
  assert.deepEqual(titles(matchCatalog("גבול התכנית עיצוב עירוני", INVENTORY)), ["גבול התכנית|עיצוב עירוני"]);
  assert.deepEqual(titles(matchCatalog("גבול התכנית של התחבורה", INVENTORY)), ["גבול התכנית|תחבורה וניידות"]);
});

test("matchCatalog: a named group that lacks the layer asks again with the valid groups", () => {
  assert.deepEqual(matchCatalog("מוקדי פיתוח בתחבורה", INVENTORY).ambiguous, [{ title: "מוקדי פיתוח ושימוש עירוניים", groups: ["אזורי ייעוד", "עיצוב עירוני"] }]);
});

test("matchCatalog: unique layers, longest title wins, no match", () => {
  assert.deepEqual(titles(matchCatalog("הצג מדרגות גובה בינוי", INVENTORY)), ["מדרגות גובה בינוי|עיצוב עירוני"]);
  assert.deepEqual(titles(matchCatalog("מוקדי תחבורה כללי", INVENTORY)), ["מוקדי תחבורה כללי|אזורי ייעוד"]);
  assert.deepEqual(titles(matchCatalog("מוקדי תחבורה", INVENTORY)), ["מוקדי תחבורה|תחבורה וניידות"]);
  assert.deepEqual(matchCatalog("אזורי מגורים", INVENTORY), { layers: [], ambiguous: [] });
  assert.deepEqual(matchCatalog(null, INVENTORY), { layers: [], ambiguous: [] });
});
```

- [ ] **Step 2:** Run `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `catalog.ts`**
  - `normalizePlanText`: drop `תא\s*\/?\s*` before 5500 and every "5500"; drop `"'׳״`; word-level `איזור→אזור`, `תוכנית→תכנית`, `יעוד→ייעוד` (only where not already `ייעוד`), `גבולות→גבול`; collapse whitespace; trim.
  - A title matches when `hasWord(n, T)` or, if the title has a word starting with "ו" after its first two words, `hasWord(n, lead)` where `lead` is the words before it (≥ 2 words; e.g. "צירי תכנון", "מוקדי פיתוח"). Drop a matched title contained in a longer matched title.
  - Group detection runs on the text with the matched title spans removed. A group is named by `hasWord` of its `groupLabel` (normalized) or an alias: `GROUP_ALIASES = { "אזורי ייעוד": ["אזור ייעוד", "ייעוד"], "עיצוב עירוני": ["עיצוב"], "סביבה ותשתיות": ["סביבה", "תשתיות"], "תחבורה וניידות": ["תחבורה", "ניידות"] }`.
  - Per matched title: entries with that title, filtered to named groups; filtered to one → `layers`; otherwise (none named, or the filter emptied it) → `ambiguous` with all its groups' labels in entry order.
  - Reuse `hasWord` from `layers.ts`.
- [ ] **Step 4:** Run `npm test && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ta5500): layer catalog matching by title and drawing`

### Task 3: Whole layers on the map

**Files:**
- Modify: `src/ta5500/focus.ts` (`planFocus`, `FocusState`, new `ancestorsToShow`)
- Modify: `src/ta5500/mapFocus.ts` (new `listCatalog`, `applyFocus`, `hideLayers` and the empty state get `wholeLayers: []`)
- Test: `src/ta5500/__tests__/focus.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry` (Task 2).
- Produces:
  - `planFocus(place, candidates, wholeLayerUids: string[] = []): { case: FocusCase; layers: Map<LayerKey, string[]>; wholeLayerUids: string[] }`
  - `FocusState.wholeLayers: { uid: string; title: string }[]` (required)
  - `ancestorsToShow(chain: { uid: string; visible: boolean }[]): string[]` — uids in the chain (parent first … root last) that are hidden
  - `listCatalog(view: MapView): CatalogEntry[]` — feature layers whose parent's title contains "5500"; `{ uid, title: layer.title, group: parent.title }`
  - `applyFocus(view, plan: { case; layers; wholeLayerUids?: string[] }, place, geometry)` — unchanged signature otherwise

- [ ] **Step 1: Write the failing tests**

```ts
test("planFocus: whole layers count as a topic", () => {
  assert.deepEqual(planFocus(null, new Map(), ["u1"]), { case: "topic_only", layers: new Map(), wholeLayerUids: ["u1"] });
  assert.equal(planFocus({ kind: "area", codes: ["301"], label: "x" }, new Map(), ["u1"]).case, "place_topic");
  assert.deepEqual(planFocus(null, new Map()).wholeLayerUids, []);
});

test("ancestorsToShow: only the hidden ones", () => {
  assert.deepEqual(ancestorsToShow([{ uid: "g", visible: false }, { uid: "root", visible: true }]), ["g"]);
  assert.deepEqual(ancestorsToShow([]), []);
});
```

- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `planFocus`: whole layers make the case `place_topic` / `topic_only` like candidates; `place_only` only when both are empty.
  - `applyFocus`: whole-layer targets are found by uid among `featureLayers(view)` with `where "1=1"`; they are kept visible like keyed targets and filtered by the place geometry when there is a place. For every kept target, `ancestorsToShow` over its `parent` chain (stop at the map); set those visible and record them in `previousVisibility` (first value wins). For `topic_only`, the go-to extent also unions each whole layer's `queryExtent({ where: "1=1" })`. `state.wholeLayers` lists `{ uid, title }`; `label` = `focusLabel(place, [...keyed labels, ...whole titles])`.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ta5500): focus can show whole catalog layers and their hidden groups`

### Task 4: Map agent uses the catalog and asks which drawing

**Files:**
- Modify: `src/ta5500/planFlow.ts` (`mapStep`, `MapStep`), `src/ta5500/prompts.ts` (`whichGroupQuestion`, `MAP_RESOLVE_PROMPT`), `src/agents/Ta5500MapAgent.ts`
- Test: `src/ta5500/__tests__/planFlow.test.ts`, `src/ta5500/__tests__/prompts.test.ts`

**Interfaces:**
- Consumes: `matchCatalog`, `listCatalog`, `planFocus(…, wholeLayerUids)`.
- Produces: `MapStep` gains `"ask_layer"`; `mapStep` input gains `ambiguousLayers?: boolean; wholeLayers?: number`; `whichGroupQuestion(ambiguous: { title: string; groups: string[] }[]): string`.

- [ ] **Step 1: Write the failing tests**

```ts
test("mapStep: ambiguous layers are asked for show/filter; whole layers focus", () => {
  const base = { placeText: "", place: null, layers: new Map() };
  assert.equal(mapStep("show", { ...base, ambiguousLayers: true }), "ask_layer");
  assert.equal(mapStep("filter", { ...base, ambiguousLayers: true }), "ask_layer");
  assert.equal(mapStep("show", { ...base, wholeLayers: 1 }), "focus");
  assert.equal(mapStep("show", base), "no_topic");
});
```

prompts.test.ts:

```ts
test("whichGroupQuestion names the layer and the drawings", () => {
  assert.equal(
    whichGroupQuestion([{ title: "מוקדי פיתוח ושימוש עירוניים", groups: ["אזורי ייעוד", "עיצוב עירוני"] }]),
    'השכבה "מוקדי פיתוח ושימוש עירוניים" מופיעה בכמה תשריטים: אזורי ייעוד, עיצוב עירוני. מאיזה תשריט להציג אותה?',
  );
  assert.ok(MAP_RESOLVE_PROMPT.includes("תשריט"));
  assert.ok(MAP_RESOLVE_PROMPT.includes("never a place"));
});
```

- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `mapStep`: after `ask_place`, for `show`/`filter`: `ambiguousLayers` → `ask_layer`; focus when `layers.size || wholeLayers || place`.
  - `whichGroupQuestion`: one line per ambiguous title (copy from the test), joined with `\n`.
  - `MAP_RESOLVE_PROMPT`: add the example "תציג לי את גבולות התוכנית" → show, topic "גבול התכנית", place null; rule `- The plan itself (תא/5500, התוכנית, תוכנית המתאר) and the city (תל אביב-יפו) are never a place.`; rule `- If the assistant's last message asked from which drawing (תשריט) to show a layer and the latest request answers it, set action "show" and topic to the layer title followed by the chosen drawing (for example "גבול התכנית עיצוב עירוני").`
  - Agent: `const catalog = view ? matchCatalog(topicText, listCatalog(view)) : { layers: [], ambiguous: [] }`; when `catalog.layers.length || catalog.ambiguous.length` the keyed `layers` is an empty map (catalog wins), else `topicLayers` as today. `case "ask_layer"` → `agentResult({ output: whichGroupQuestion(catalog.ambiguous), ok: true, summary: "asked the user which drawing; waiting for the answer; do not retry" })`. In `case "focus"`, pass `catalog.layers.map((e) => e.uid)` to `planFocus` and add the whole-layer titles to the shown line.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ta5500): map agent shows catalog layers and asks which drawing`

### Task 5: Plan agent uses unambiguous catalog layers

**Files:**
- Modify: `src/ta5500/planFlow.ts` (new `planCatalogUids`), `src/agents/PlanAgent.ts` (resolve stores the uids in a new `wholeLayerUids` channel; focus passes them to `planFocus`)
- Test: `src/ta5500/__tests__/planFlow.test.ts`

**Interfaces:**
- Consumes: `CatalogMatch`, `planFocus(…, wholeLayerUids)`.
- Produces: `planCatalogUids(match: CatalogMatch): string[]` — uids of `match.layers` only; ambiguous titles are ignored.

- [ ] **Step 1: Write the failing test**

```ts
test("planCatalogUids: only layers that resolved to one drawing", () => {
  const e = { uid: "1-5", title: "צירי תכנון וקווי תיחום", group: "אזורי ייעוד 5500" };
  assert.deepEqual(planCatalogUids({ layers: [e], ambiguous: [{ title: "גבול התכנית", groups: ["a", "b"] }] }), ["1-5"]);
  assert.deepEqual(planCatalogUids({ layers: [], ambiguous: [] }), []);
});
```

- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `planCatalogUids`; in the resolve node match the user's request text (`request`, not the rewritten question) with `matchCatalog(request, listCatalog(view))` when a view exists; in the focus node `planFocus(place, candidates, s.wholeLayerUids)` (both calls), and include whole-layer titles in `shownLine`.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ta5500): plan agent shows layers named with their drawing`

### Task 6: Reset to the startup state

**Files:**
- Create: `src/ta5500/baseline.ts`, `src/ta5500/__tests__/baseline.test.ts`
- Modify: `src/ta5500/mapFocus.ts` (`captureBaseline`, `resetFocus`), `src/hooks/useTa5500Mode.ts`, `src/ta5500/prompts.ts` (`FOCUS_CLEARED_REPLY`)

**Interfaces:**
- Produces:
  - `type MapBaseline = { visibility: Record<string, boolean>; viewpointJson: unknown | null }`
  - `baselineStore: { get(): MapBaseline | null; set(b: MapBaseline): void; clear(): void }`
  - `visibilityChanges(baseline: Record<string, boolean>, current: { uid: string; visible: boolean }[]): { uid: string; visible: boolean }[]`
  - `captureBaseline(view: MapView): void` (mapFocus)
  - `FOCUS_CLEARED_REPLY = "המפה חזרה למצב ההתחלתי."`

- [ ] **Step 1: Write the failing tests**

```ts
test("visibilityChanges: restores what differs, ignores layers added later", () => {
  const base = { a: true, b: false, g: true };
  assert.deepEqual(
    visibilityChanges(base, [{ uid: "a", visible: false }, { uid: "b", visible: false }, { uid: "g", visible: true }, { uid: "new", visible: true }]),
    [{ uid: "a", visible: true }],
  );
  assert.deepEqual(visibilityChanges({}, [{ uid: "a", visible: false }]), []);
});

test("baselineStore: set, get, clear", () => {
  baselineStore.set({ visibility: { a: true }, viewpointJson: null });
  assert.deepEqual(baselineStore.get(), { visibility: { a: true }, viewpointJson: null });
  baselineStore.clear();
  assert.equal(baselineStore.get(), null);
});
```

Update the `FOCUS_CLEARED_REPLY` assertion in prompts.test.ts if one checks its text.

- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `captureBaseline`: visibility of every layer in `view.map.allLayers` (group layers included) by uid; `viewpointJson` = `(view.map as WebMap).initialViewProperties?.viewpoint ?? view.viewpoint`, as JSON.
  - `resetFocus`: after `restoreMap`, apply `visibilityChanges(baseline.visibility, …allLayers)`; then `await view.goTo(Viewpoint.fromJSON(viewpointJson))` when present. No baseline → today's behaviour.
  - `useTa5500Mode`: `captureBaseline(view)` right after `rememberAuthoredEffects(view)`; `baselineStore.clear()` in the cleanup next to `focusStore.clear()`.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ta5500): reset returns the map to its startup state`

### Task 7: Plan agent changes the map only when relevant; routing set; scenario run

**Files:**
- Modify: `src/ta5500/prompts.ts` (`PLAN_AGENT_DESCRIPTION`), `docs/routing-questions.yml`
- Test: `src/ta5500/__tests__/prompts.test.ts`, `src/ta5500/__tests__/planLogic.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// prompts.test.ts
test("plan description: the map changes only for a place or a layer", () => {
  assert.ok(!PLAN_AGENT_DESCRIPTION.includes("always shows"));
  assert.ok(PLAN_AGENT_DESCRIPTION.includes("text-only answer leaves the map unchanged"));
});
// planLogic.test.ts
test("a text-only section has no map layers (section 4.5)", () => {
  assert.equal(layersForSections(["4.5"], loc.gis_codes).size, 0);
});
```

- [ ] **Step 2:** Run `npm test`. Expected: the description test FAILS (the 4.5 test may already pass; it pins the behaviour).
- [ ] **Step 3:** Replace "It always shows the answer on the map: focuses on the named place and highlights the relevant plan layers." with "When the answer is about a place or a plan layer it also shows it on the map (focuses on the place, highlights the relevant layers); a text-only answer leaves the map unchanged." Add the 11 scenarios of spec §5 to `docs/routing-questions.yml` (`expect`: 1, 3, 10 → ta5500-map; 2, 4, 5, 7, 8, 9, 11 → ta5500-plan; 6 → ta5500-scope; follow-ups "של עיצוב עירוני" after 1 and "102" after 11 with `after:`), `result: pending`.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit && npm run typecheck:test`. Expected: PASS.
- [ ] **Step 5: Manual scenario run** (dev stack, TA5500 map, `?mode=edit`, fresh chat per scenario). The console line `ta5500 catalog: 34 layers in 5 groups` (logged by `useTa5500Mode` with `console.debug` right after `captureBaseline`; add it in Task 6) confirms the catalog matches spec §3. Run spec §5 scenarios 1–11 and the two follow-ups; record pass/fail in `docs/routing-questions.yml`.
- [ ] **Step 6: Commit** — `docs+feat(ta5500): plan agent maps only place/layer answers; routing scenarios`
