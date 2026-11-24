// Agent descriptions (what the orchestrator router reads), LLM prompt templates and user-facing Hebrew copy
// for TA5500 mode. Pure module: no runtime imports.
//
// Prompt templates are LangChain f-string templates (the SDK builds them with `fromTemplate`):
// `{name}` is an input variable, literal braces must be written `{{` / `}}`.

import type { Place } from "./focus";

// ---------- Router descriptions (spec §5.2) ----------

export const PLAN_AGENT_DESCRIPTION =
  `Answers questions about the Tel Aviv master plan תא/5500 (תוכנית המתאר) from the plan document, including questions about a drawn polygon and its filter. Also handles requests to show or navigate to plan provisions in the instructions PDF. Use for 'מה הוראות התכנית לפוליגון?', 'מה מותר לבנות באזור 105?', 'מה אומר סעיף 4.3?', 'הצג את סעיף 4.3', 'גלול לסעיף על גובה מבנים', and 'ומה לגבי מגורים שם?'. When an answer is about a place or plan layer it may also focus relevant map layers; a text-only answer leaves the map unchanged. While a plan focus is active it also changes what is shown in it and clears it (נקה מיקוד). Do NOT use for map actions that do not ask what the plan says (navigate the map, show/hide layers, count features).`;

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
1. question: one standalone question in Hebrew that can be understood without the conversation. Resolve references such as "שם", "זה", "באזור הזה", "ומה לגבי" from the earlier messages and from the current focus (for example, if the focus is planning area 105 and the request is "ומה לגבי מגורים שם?", write "מה קובעת התוכנית לגבי מגורים באזור 105?"). Keep the user's meaning; do not add topics.
2. areas: planning area codes (אזור תכנון) written in the request or the resolved question, exactly as written (for example "105", "703", "101ה"). Empty if none.
3. entities: other plan codes or named plan entities written there (sub-areas, special streets, development foci), exactly as written. Empty if none.
4. zone_types: zone type ids (אזורי ייעוד, for example "3.3.2") only when written explicitly. Empty if none.
5. headings: plan section or clause numbers (סעיף, for example "4.3") or "5.4" for table 5.4, only when written explicitly. Empty if none.
6. place: a free-text place that is not a plan code (a neighborhood, street or address, for example "רמת אביב"), as written; null if none.
7. intent:
   - "answer": the user asks what the plan says, allows, requires or designates.
   - "pdf_clause": the user only asks to show or navigate to an explicitly numbered clause in the instructions PDF.
   - "pdf_topic": the user only asks to show or navigate to a provision by topic, without an explicit clause number.
   - "polygon_only": the user only asks to enable or disable use of the drawn polygon as a search filter.
   - "refine_focus": a plan focus is active and the user only wants to change what is shown in it (for example "הצג רק את המגורים שם") without asking what the plan says.
   - "clear_focus": the user asks to clear the focus or reset the map (for example "נקה מיקוד", "אפס את המפה").
8. pdfClause: for pdf_clause, the exact clause number written in the latest request (e.g. "3.3.2"), otherwise null.
9. polygonAction: "enable" if the user explicitly asks to use the drawn polygon or asks a question about it; "disable" if explicitly asking to stop using it; otherwise "none".

Rules:
- Never invent codes, area numbers, zone type ids or section numbers. Copy only values that appear in the conversation or in the current focus; when unsure, leave the field empty. The values are checked against the plan afterwards.
- "מה אומר סעיף 4.3?" asks for an answer, while "הצג את סעיף 4.3" requests only PDF navigation. "הצג את הסעיף על גובה מבנים" requests PDF navigation by topic. If the user asks both what a provision says and to show it, use "answer".
- A drawn polygon is not a named place; do not put "פוליגון" or "polygon" in place. Its filters are applied separately.
- When the request names no place and refers back to one ("שם", "באזור הזה"), take the place from the current focus or the earlier messages.
- If the assistant's last message asked which planning area was meant and the latest request answers it, write the question again for the chosen area and put its code in areas.
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
2. place: the place the action applies to, as written: a planning area code (for example "105", "101ה"), a sub-area, a street, a neighborhood or an address. Resolve "שם" or "באזור הזה" from the earlier messages or the current focus. Null if no place is involved.
3. topic: the plan layer or plan concept the action applies to, in the user's words (for example "אזורי תעסוקה", "מוקדים", "רחובות מיוחדים", "גבול התכנית"). "הגבולות של התוכנית" ("show the plan's boundaries") is action "show" with topic "גבול התכנית". Null if none.

Rules:
- Never invent codes, area numbers or places. Copy only what appears in the conversation or the current focus; leave a field null when unsure.
- The plan itself (תא/5500, התוכנית, תוכנית המתאר) and the city (תל אביב-יפו) are never a place: leave place null.
- If the assistant's last message asked from which drawing (תשריט) to show a layer and the latest request answers it, set action "show" and topic to the layer title followed by the chosen drawing (for example "גבול התכנית עיצוב עירוני").
- Do not judge whether the place is in Tel Aviv-Yafo; that is checked afterwards.
- If the assistant's last message asked which planning area was meant and the latest request answers it, put the chosen area code in place and keep the original action and topic.`;

// ---------- User-facing Hebrew copy ----------

export const SCOPE_REPLY =
  'כאן אפשר לקבל מידע רק על תוכנית המתאר תא/5500 ועל מפת תל אביב-יפו. אפשר לשאול למשל: "מה מותר לבנות באזור 105?" או "הצג את אזורי התעסוקה ברמת אביב".';

/** Map agent: a named place that was not identified (the map is unchanged). */
export const NO_PLACE_NOTE = "לא זיהיתי את המקום שציינת, ולכן המפה לא שונתה.";

/** Plan agent: a named place that was not identified; the answer and the map focus are city-wide. */
export const PLAN_NO_PLACE_NOTE = "לא זיהיתי את המקום שציינת, ולכן התשובה והמפה מתייחסות לכל העיר.";

/** Plan agent: a named place that was not identified; the answer is city-wide and the map was not changed. */
export const PLAN_NO_PLACE_MAP_UNCHANGED_NOTE = "לא זיהיתי את המקום שציינת, ולכן התשובה מתייחסת לכל העיר והמפה לא שונתה.";

/** A planning-area code that is not in the plan: notInPlanNote("999") → "אזור 999 אינו מופיע בתוכנית." */
export function notInPlanNote(code: string): string {
  return `אזור ${code} אינו מופיע בתוכנית.`;
}

/** A place name that matches several planning areas: ask which one; the map is unchanged. */
export function whichAreaQuestion(text: string, options: Place[]): string {
  return `"${text}" מתאים לכמה אזורי תכנון: ${options.map((o) => o.label).join("; ")}. לאיזה מהם הכוונה?`;
}

/** A layer that exists in several of the plan's drawings (תשריטים): ask which one; the map is unchanged. */
export function whichGroupQuestion(ambiguous: { title: string; groups: string[] }[]): string {
  return ambiguous.map((a) => `השכבה "${a.title}" מופיעה בכמה תשריטים: ${a.groups.join(", ")}. מאיזה תשריט להציג אותה?`).join("\n");
}

export const OUTSIDE_TA_REPLY = "המקום שציינת נמצא מחוץ לתל אביב-יפו, וכאן אפשר לקבל מידע רק על תוכנית המתאר של העיר.";

export const MAP_FAILED_NOTE = "לא הצלחתי לעדכן את המפה.";

export const FOCUS_CLEARED_REPLY = "המפה חזרה למצב ההתחלתי.";

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

/** Map agent, go_to: goToLine("אזור 105") → "המפה הועברה אל אזור 105." */
export function goToLine(placeLabel: string): string {
  return `המפה הועברה אל ${placeLabel}.`;
}

/** Map agent, hide: hiddenLine(["מוקדי פיתוח ושימוש עירוניים"]) → "הוסתרו במפה: מוקדי פיתוח ושימוש עירוניים." */
export function hiddenLine(layerLabels: string[]): string {
  return layerLabels.length ? `הוסתרו במפה: ${layerLabels.join(", ")}.` : "";
}

/**
 * "ב" + a place label; a label that starts with the definite article "ה" drops it, as in Hebrew
 * ("הקריה" → "בקריה", "אזור 105" → "באזור 105").
 */
export function inPlace(placeLabel: string): string {
  return placeLabel.startsWith("ה") ? `ב${placeLabel.slice(1)}` : `ב${placeLabel}`;
}

/**
 * The line added to a reply saying what the map shows (spec §5.3 step 4.5).
 * shownLine("אזור 105", ["אזורי ייעוד"], ["תעסוקה"]) → "מוצגים באזור 105: אזורי ייעוד. לא נמצאו באזור: תעסוקה."
 * shownLine("הקריה", ["אזורי ייעוד"], []) → "מוצגים בקריה: אזורי ייעוד."
 * shownLine(null, ["מוקדים"], []) → "מוצגים במפה: מוקדים."
 * With nothing shown, only the skipped sentence is returned; with neither, "".
 */
export function shownLine(placeLabel: string | null, layerLabels: string[], skipped: string[]): string {
  const parts: string[] = [];
  if (layerLabels.length > 0) parts.push(`מוצגים ${placeLabel ? inPlace(placeLabel) : "במפה"}: ${layerLabels.join(", ")}.`);
  if (skipped.length > 0) parts.push(`לא נמצאו ${placeLabel ? "באזור" : "במפה"}: ${skipped.join(", ")}.`);
  return parts.join(" ");
}
