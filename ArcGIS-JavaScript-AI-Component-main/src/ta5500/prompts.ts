// Agent descriptions (what the orchestrator router reads), LLM prompt templates and user-facing Hebrew copy
// for TA5500 mode. Pure module: no runtime imports.
//
// Prompt templates are LangChain f-string templates (the SDK builds them with `fromTemplate`):
// `{name}` is an input variable, literal braces must be written `{{` / `}}`.

// ---------- Router descriptions (spec §5.2) ----------

export const PLAN_AGENT_DESCRIPTION =
  `Answers questions about the Tel Aviv master plan תא/5500 (תוכנית המתאר) from the plan document: what the plan allows, requires or designates — building rights, רח"ק, heights, land uses, zone types (אזורי ייעוד), planning areas (אזור תכנון, e.g. 610, 703, 101ה), streets with special provisions, table 5.4, clauses (סעיף 3.3.2), development policy (פיתוח, תעסוקה, מגורים, מוסדות ציבור, שטחים פתוחים). It always shows the answer on the map: focuses on the named place and highlights the relevant plan layers. While a plan focus is active it also changes what is shown in it and clears it (נקה מיקוד). Use for: 'מה מותר לבנות באזור 610?', 'מה תוכנית הפיתוח העסקי ברמת אביב?', 'מה אומר סעיף 4.3?', 'ומה לגבי מגורים שם?'. Do NOT use for map actions that do not ask what the plan says (navigate, show/hide layers, count features).`;

export const MAP_AGENT_DESCRIPTION =
  `Performs map actions on the Tel Aviv-Yafo master plan map: go to a planning area, sub-area, street, neighborhood or address in Tel Aviv-Yafo; show, hide or filter the plan layers (zone types, development foci, planning areas, special streets); reset the map. Use for: 'תתמקד על אזור 703', 'קח אותי לרמת אביב', 'הצג רק אזורי מגורים', 'תסתיר את שכבת המוקדים', 'אפס את המפה'. Do NOT use for questions about what the plan says or allows (Plan agent), counts or statistics (data exploration), or places outside Tel Aviv-Yafo.`;

// Spec §5.2 draft plus a closing "Do NOT use" sentence (every description states its negative space).
export const SCOPE_AGENT_DESCRIPTION =
  `Use when the request is about a place outside Tel Aviv-Yafo (another city or country) or a topic unrelated to the Tel Aviv master plan and its map (news, weather, general knowledge). Replies that the assistant only works on the Tel Aviv-Yafo master plan. Do NOT use for questions about the Tel Aviv master plan תא/5500 or for map actions on places inside Tel Aviv-Yafo.`;

/** Appended to the McpPassthrough agent's description in TA5500 mode. */
export const MCP_NOT_PLAN_SUFFIX = `Do NOT use for questions about the Tel Aviv master plan תא/5500.`;

// ---------- Prompt templates ----------

/** Plan agent, step 1 (spec §5.3). Inputs: {request} (latest request with recent history), {currentFocus}. */
export const RESOLVE_PROMPT = `You prepare a user's request about the Tel Aviv-Yafo master plan תא/5500 (תוכנית המתאר) for a search in the plan document.

The conversation so far, ending with the latest request:
{request}

The plan focus currently shown on the map (or "none"):
{currentFocus}

Produce:
1. question: one standalone question in Hebrew that can be understood without the conversation. Resolve references such as "שם", "זה", "באזור הזה", "ומה לגבי" from the earlier messages and from the current focus (for example, if the focus is planning area 610 and the request is "ומה לגבי מגורים שם?", write "מה קובעת התוכנית לגבי מגורים באזור 610?"). Keep the user's meaning; do not add topics.
2. areas: planning area codes (אזור תכנון) written in the request or the resolved question, exactly as written (for example "610", "703", "101ה"). Empty if none.
3. entities: other plan codes or named plan entities written there (sub-areas, special streets, development foci), exactly as written. Empty if none.
4. zone_types: zone type ids (אזורי ייעוד, for example "3.3.2") only when written explicitly. Empty if none.
5. headings: plan section or clause numbers (סעיף, for example "4.3") or "5.4" for table 5.4, only when written explicitly. Empty if none.
6. place: a free-text place that is not a plan code (a neighborhood, street or address, for example "רמת אביב"), as written; null if none.
7. intent:
   - "answer": the user asks what the plan says, allows, requires or designates.
   - "refine_focus": a plan focus is active and the user only wants to change what is shown in it (for example "הצג רק את המגורים שם") without asking what the plan says.
   - "clear_focus": the user asks to clear the focus or reset the map (for example "נקה מיקוד", "אפס את המפה").

Rules:
- Never invent codes, area numbers, zone type ids or section numbers. Copy only values that appear in the conversation or in the current focus; when unsure, leave the field empty. The values are checked against the plan afterwards.
- When the request names no place and refers back to one ("שם", "באזור הזה"), take the place from the current focus or the earlier messages.
- Write the question in Hebrew, in gender-neutral wording.`;

/** Plan agent, step 3 (spec §5.3). Inputs: {question}, {context} (numbered plan excerpts with citation and page). */
export const ANSWER_PROMPT = `You answer questions about the Tel Aviv-Yafo master plan תא/5500 (תוכנית המתאר) for planners and residents.

Question:
{question}

Context from the plan document (numbered items, each with its citation and page):
{context}

Rules:
- Answer ONLY from the context above. Do not use outside knowledge and do not guess.
- Cite every statement with the citation and page given in the item it comes from (for example "(סעיף 3.3.2, עמ' 41)").
- Where table 5.4 (the planning-area table) and the general chapters differ, table 5.4 applies to that area; say so.
- If the context does not answer the question, say clearly that the plan, as retrieved, does not answer it. Do not fill the gap.
- If the context is marked as a low match (התאמה נמוכה), say that the plan does not seem to cover the question directly and present only what the items support.
- If the context lists further topics or areas (focus_more), answer the question first and then offer to expand on them.
- Never invent codes, area numbers, section numbers, page numbers or figures that are not in the context.
- Write the answer in Hebrew, concise and factual, in gender-neutral wording (address the reader with impersonal or plural forms, for example "ניתן", "אפשר", "יש לבדוק").

Output:
- answer: the Hebrew answer text.
- usedItems: the 1-based numbers of the context items the answer actually relies on and cites. Leave out items that were not used. Empty if the context does not answer the question.`;

/** Map agent (spec §5.2 / §5.5). Inputs: {request} (latest request with recent history), {currentFocus}. */
export const MAP_RESOLVE_PROMPT = `You turn a map request on the Tel Aviv-Yafo master plan map into one map action.

The conversation so far, ending with the latest request:
{request}

The plan focus currently shown on the map (or "none"):
{currentFocus}

Produce:
1. action, one of:
   - "go_to": move the map to a place (for example "תתמקד על אזור 703", "קח אותי לרמת אביב").
   - "show": show plan layers or plan topics (for example "הצג אזורי תעסוקה").
   - "hide": hide plan layers or plan topics (for example "תסתיר את שכבת המוקדים").
   - "filter": show only part of a layer (for example "הצג רק אזורי מגורים").
   - "reset": clear the focus and restore the map (for example "אפס את המפה", "נקה מיקוד").
2. place: the place the action applies to, as written: a planning area code (for example "610", "101ה"), a sub-area, a street, a neighborhood or an address. Resolve "שם" or "באזור הזה" from the earlier messages or the current focus. Null if no place is involved.
3. topic: the plan layer or plan concept the action applies to, in the user's words (for example "אזורי תעסוקה", "מוקדים", "רחובות מיוחדים"). Null if none.

Rules:
- Never invent codes, area numbers or places. Copy only what appears in the conversation or the current focus; leave a field null when unsure.
- Do not judge whether the place is in Tel Aviv-Yafo; that is checked afterwards.`;

// ---------- User-facing Hebrew copy ----------

export const SCOPE_REPLY =
  'כאן אפשר לקבל מידע רק על תוכנית המתאר תא/5500 ועל מפת תל אביב-יפו. אפשר לשאול למשל: "מה מותר לבנות באזור 610?" או "הצג את אזורי התעסוקה ברמת אביב".';

export const NO_PLACE_NOTE = "לא זיהיתי את המקום שציינת, ולכן המפה לא שונתה.";

export const OUTSIDE_TA_REPLY = "המקום שציינת נמצא מחוץ לתל אביב-יפו, וכאן אפשר לקבל מידע רק על תוכנית המתאר של העיר.";

export const MAP_FAILED_NOTE = "לא הצלחתי לעדכן את המפה.";

export const FOCUS_CLEARED_REPLY = "המיקוד נוקה והמפה חזרה למצבה הקודם.";

export const REQUEST_FAILED_REPLY = "לא ניתן היה לעבד את הבקשה כרגע. נסו שוב.";

/** Map agent: a show/filter/hide topic that matches no plan layer or topic, and no place to act on. */
export const NO_TOPIC_REPLY = "לא נמצאו בתוכנית שכבה או נושא מתאימים לבקשה, ולכן המפה לא שונתה.";

/** Map agent: the topic matched nothing in the plan, but the place was shown. */
export const NO_TOPIC_NOTE = "לא נמצאה בתוכנית שכבה מתאימה לנושא שצוין.";

/** Map agent: a newer map request replaced this one before it was applied. */
export const MAP_SUPERSEDED_REPLY = "התקבלה בקשת מפה חדשה יותר, ולכן הבקשה הזו לא הוחלה.";

/** Map agent, hide: the topic only names some types inside a layer (for example "אזורי מגורים"). */
export const HIDE_PARTIAL_REPLY =
  'אין אפשרות להסתיר רק חלק משכבה, ולכן המפה לא שונתה. אפשר לבקש במקום זאת להציג רק את הסוגים הרצויים, למשל "הצג רק אזורי תעסוקה".';

/** Map agent, hide: the code-level part of a mixed topic that was not hidden. */
export function hidePartialNote(layerLabels: string[]): string {
  return layerLabels.length ? `אין אפשרות להסתיר רק חלק משכבה, ולכן לא הוסתרו סוגים בתוך: ${layerLabels.join(", ")}.` : "";
}

/** Map agent, hide with a place: hiding applies to the whole map, not only to the place. */
export function hideWholeMapNote(placeLabel: string): string {
  return `ההסתרה חלה על כל המפה, ולא רק על ${placeLabel}.`;
}

/** Map agent, go_to: goToLine("אזור 610") → "המפה הועברה אל אזור 610." */
export function goToLine(placeLabel: string): string {
  return `המפה הועברה אל ${placeLabel}.`;
}

/** Map agent, hide: hiddenLine(["מוקדי פיתוח ושימוש עירוניים"]) → "הוסתרו במפה: מוקדי פיתוח ושימוש עירוניים." */
export function hiddenLine(layerLabels: string[]): string {
  return layerLabels.length ? `הוסתרו במפה: ${layerLabels.join(", ")}.` : "";
}

/**
 * The line added to a reply saying what the map shows (spec §5.3 step 4.5).
 * shownLine("אזור 610", ["אזורי ייעוד"], ["תעסוקה"]) → "מוצגים באזור 610: אזורי ייעוד. לא נמצאו באזור: תעסוקה."
 * shownLine(null, ["מוקדים"], []) → "מוצגים במפה: מוקדים."
 * With nothing shown, only the skipped sentence is returned; with neither, "".
 */
export function shownLine(placeLabel: string | null, layerLabels: string[], skipped: string[]): string {
  const parts: string[] = [];
  if (layerLabels.length > 0) parts.push(`מוצגים ${placeLabel ? `ב${placeLabel}` : "במפה"}: ${layerLabels.join(", ")}.`);
  if (skipped.length > 0) parts.push(`לא נמצאו ${placeLabel ? "באזור" : "במפה"}: ${skipped.join(", ")}.`);
  return parts.join(" ");
}
