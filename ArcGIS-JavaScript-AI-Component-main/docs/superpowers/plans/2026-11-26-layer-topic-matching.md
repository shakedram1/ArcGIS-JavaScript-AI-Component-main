# Layer Topic Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Show the infrastructure" (or any topic that names a layer group, or describes layers loosely) puts the right plan layers on the map immediately, from either the Plan or the Map agent, with no need to type exact layer titles.

**Architecture:** Two layers of matching, both validated against the live catalog (`listCatalog`), so nothing outside the plan is ever drawn. (1) A deterministic fallback in `matchCatalog`: when no layer title is named but a topic word names a drawing group, return that group's layers. (2) For the Map agent only, when (1) finds nothing for a show/filter request, a second LLM call picks layers from the numbered catalog (group + title) and returns indexes, which code range-checks.

**Tech Stack:** TypeScript, Zod, `invokeStructuredPrompt` (`@arcgis/ai-components/utils/index.js`), `node:test` via `tsx`.

**Spec:** conversation of 2026-11-26 (no design doc). Related: `docs/superpowers/specs/2026-11-17-map-interaction-design.md`.

## Global Constraints

- `src/ta5500/catalog.ts` and `prompts.ts` stay pure: no `@arcgis/*` imports, no DOM (CLAUDE.md, TA5500 mode).
- All user-facing strings in Hebrew, RTL-safe.
- Code validates the LLM: layers come only from `listCatalog(view)` entries, never from LLM text.
- Existing behavior must not change: a request that names a layer title (whole or lead), or a layer plus a drawing, resolves exactly as today (`catalog.test.ts` stays green).
- `hide` does not use the catalog (unchanged, out of scope).
- Tests: `npm test`; type-check: `npx tsc --noEmit`.
- After changing any agent description or prompt, re-run `docs/routing-questions.yml` by hand.

## Review Focus

- Generic words ("ייעוד", "עיצוב", "אזור") in a plain plan question must not trigger a group match and focus layers.
- A group word plus a specific layer title ("קווי תשתית") returns only that layer, as today.
- Layers shared by several groups ("גבול התכנית", "אזור תכנון ומספרו", "שמות רחובות עירוניים") are not included by a group-level match, so "תשתיות" does not draw the plan boundary five times or ask which drawing.
- The real map title "נקודות תשתית חמשל מים וביוב" has a typo ("חמשל"); the user's "חשמל" must still work through the group match and the LLM pick.
- LLM returns empty, duplicate or out-of-range indexes → falls back to `NO_TOPIC_NOTE`, no crash, nothing drawn.
- The second LLM call fails or is aborted → reply is the existing `failureReply`, same as the first call.

---

### Task 1: Group-level fallback in `matchCatalog`

**Files:**
- Modify: `src/ta5500/catalog.ts` (`matchCatalog`, new `GROUP_TOPIC_WORDS`)
- Test: `src/ta5500/__tests__/catalog.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry`, `CatalogMatch`, `hasWord`, `normalizePlanText`, `groupLabel` (same file / `layers.ts`).
- Produces: `matchCatalog(text, entries): CatalogMatch` now also returns, when no layer title matched and a topic word names a group, `layers` = that group's layers whose title exists in only one group. Signature unchanged. Both agents already call it (`Ta5500MapAgent.ts:154`, `PlanAgent.ts:243`).

- [ ] **Step 1: Write failing tests** in `catalog.test.ts`, using the existing `INVENTORY`:
  - `matchCatalog("תציג לי את התשתיות", INVENTORY)` → `titles(...)` equals exactly the five infra-only layers: `קווים מאזורי ייעוד`, `נקודות תשתית חמשל מים וביוב`, `קווי תשתית`, `פוליגוני תשתיות עירוניות`, `מתקנים הנדסיים ימיים ונחלים`, all `|סביבה ותשתיות`, and `ambiguous` is `[]`.
  - `"תדליק שכבות הקשורות לתשתיות באיזור הזה"` → same five.
  - `"הצג את התחבורה"` → the transport-only layers (`מוקדי תחבורה`, `רשת תחבורה מטרופולינית`, `פוליגונים תחבורה`, `אזורי יעוד - דרך מהירה, ים ונחלים`).
  - `"הצג קווי תשתית"` → only `קווי תשתית|סביבה ותשתיות` (title match wins).
  - `"מה הייעוד של האזור?"` and `"איזה עיצוב יש שם?"` → `layers` and `ambiguous` both `[]` (generic words).
- [ ] **Step 2: Run** `npx tsx --test src/ta5500/__tests__/catalog.test.ts` → the new tests FAIL, old ones pass.
- [ ] **Step 3: Implement.** Add `GROUP_TOPIC_WORDS: Record<string, string[]>` (group label → words): `סביבה ותשתיות`: `תשתית`, `סביבה`; `תחבורה וניידות`: `תחבורה`, `ניידות`. Not `ייעוד` and not `עיצוב` (too generic). In `matchCatalog`, at the `if (!kept.length) return out;` point, instead of returning, try the fallback: for each group whose topic words satisfy `hasWord(n, normalizePlanText(word))`, push the group's entries whose title appears in exactly one group. Words are matched after `normalizePlanText` (so `תשתיות` → `תשתית`).
- [ ] **Step 4: Run** the same command → all PASS. Then `npm test` → 0 fail.
- [ ] **Step 5: Commit** `git add src/ta5500/catalog.ts src/ta5500/__tests__/catalog.test.ts && git commit -m "Match plan layer groups by topic word (תשתיות, תחבורה)"`

### Task 2: Catalog pick prompt and validator (pure)

**Files:**
- Modify: `src/ta5500/catalog.ts` (new `catalogForPrompt`, `entriesFromPicks`), `src/ta5500/prompts.ts` (new `MAP_LAYER_PICK_PROMPT`)
- Test: `src/ta5500/__tests__/catalog.test.ts`, `src/ta5500/__tests__/prompts.test.ts`

**Interfaces:**
- Produces:
  - `catalogForPrompt(entries: CatalogEntry[]): string`: one line per entry, `"<n>. <groupLabel> | <title>"`, `n` starting at 1, in map order.
  - `entriesFromPicks(picks: number[], entries: CatalogEntry[]): CatalogEntry[]`: keeps only integers in `1..entries.length`, de-duplicated, in ascending order, mapped to entries.
  - `MAP_LAYER_PICK_PROMPT: string` with inputs `{request}` (conversation via `conversationText`), `{topic}`, `{catalog}`. Tells the LLM: return the numbers of the layers that answer the topic or the conversation's subject (infrastructure, transport, …); skip the shared base layers (plan boundary, planning-area number, street names) unless the user asked for them; return `[]` when nothing fits; never invent numbers.
- [ ] **Step 1: Failing tests:** `catalogForPrompt` first line for `INVENTORY` is `1. אזורי ייעוד | גבול התכנית`; `entriesFromPicks([3, 3, 0, 999, 1.5, 2], INVENTORY)` returns entries 2 and 3 (indexes 1 and 2); `entriesFromPicks([], …)` is `[]`. In `prompts.test.ts`: the prompt contains `{catalog}`, `{topic}` and `{request}`.
- [ ] **Step 2: Run** both test files → FAIL.
- [ ] **Step 3: Implement** the two functions and the prompt constant.
- [ ] **Step 4: Run** both files → PASS.
- [ ] **Step 5: Commit** `git commit -am "Add catalog pick prompt and index validator"`

### Task 3: Map agent uses the LLM pick as a second chance

**Files:**
- Modify: `src/agents/Ta5500MapAgent.ts` (around lines 151-157)
- No unit test (needs the MapView); verified in Task 5.

**Interfaces:**
- Consumes: `catalogForPrompt`, `entriesFromPicks`, `MAP_LAYER_PICK_PROMPT`, `matchCatalog`, `listCatalog`, `conversationText`, `invokeStructuredPrompt`.
- Produces: no new exports. When `r.action` is `show` or `filter`, a view exists, `matchCatalog(topicText, entries)` returned no layers and no ambiguous, `topicLayers(topicText, loc)` is also empty, and `topicText` is non-empty, call `invokeStructuredPrompt` with schema `z.object({ layers: z.array(z.number().int()) })`, `temperature: 0`, then set `catalog = { layers: entriesFromPicks(layers, entries), ambiguous: [] }`.

- [ ] **Step 1:** Make the lookup order explicit: catalog match → `topicLayers` → LLM pick. The LLM pick runs only if both earlier steps are empty, so requests that work today cost no extra call.
- [ ] **Step 2:** The pick call runs inside the existing `try`/failure handling so a failure returns `failureReply(err, TAG)` like the first call (an abort is not swallowed).
- [ ] **Step 3:** `npx tsc --noEmit` → no errors; `npm test` → 0 fail.
- [ ] **Step 4: Commit** `git commit -am "Map agent: pick plan layers from the catalog when the topic names none"`

### Task 4: Routing text and routing set

**Files:**
- Modify: `src/ta5500/prompts.ts` (`MAP_AGENT_DESCRIPTION`), `docs/routing-questions.yml`

- [ ] **Step 1:** In `MAP_AGENT_DESCRIPTION`, add infrastructure and transport layers to the list of layers it shows, and the example `'תדליק שכבות של תשתיות'`. Keep the "Do NOT use" sentence.
- [ ] **Step 2:** Add to `docs/routing-questions.yml`, in the file's existing entry format: `'תדליק שכבות רלוונטיות הקשורות לתשתיות באיזור הזה'` with `after:` the planning-area question, `expect: ta5500-map`; and `'הצג את התחבורה על המפה'`, `expect: ta5500-map`. Results `pending`.
- [ ] **Step 3:** `npm test` → `prompts.test.ts` still passes (update any description assertion that quotes the old text).
- [ ] **Step 4: Commit** `git commit -am "Describe infrastructure and transport layers in the map agent"`

### Task 5: Manual check in the app

- [ ] **Step 1:** Start `npm run hub` (with the `ta5500` server enabled) and `npm run dev`, open `?mode=edit`.
- [ ] **Step 2:** Replay your conversation: ask about area 301, then "ומה התכנון שם מבחינת תשתיות? תוכל להציג לי על המפה?" and then "תדליק שכבות רלוונטיות הקשורות לתשתיות באיזור הזה". Expected: the five infrastructure layers are drawn for 301 both times, no "לא נמצאה שכבה".
- [ ] **Step 3:** Also try "הצג את התחבורה", "הצג שכבות של סביבה", and "מה הייעוד של אזור 301?" (must not draw extra layers). Record results in `docs/routing-questions.yml`.

---

**Not in this plan (deliberately):** carrying the *topic* across turns when a request names no layer at all ("תציג את זה"), `hide` for catalog layers, and routing "show on the map" away from the Plan agent. Task 1 fixes the Plan agent's case because it already calls `matchCatalog`. They can be added if the manual check shows they're needed.
