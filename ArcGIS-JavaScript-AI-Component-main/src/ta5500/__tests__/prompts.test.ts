import test from "node:test";
import assert from "node:assert/strict";
import * as prompts from "../prompts";
import {
  ANSWER_PROMPT,
  MAP_AGENT_DESCRIPTION,
  MAP_FAILED_NOTE,
  MAP_RESOLVE_PROMPT,
  MCP_NOT_PLAN_SUFFIX,
  NO_PLACE_NOTE,
  OUTSIDE_TA_REPLY,
  PLAN_AGENT_DESCRIPTION,
  RESOLVE_PROMPT,
  SCOPE_AGENT_DESCRIPTION,
  SCOPE_REPLY,
  shownLine,
  FOCUS_CLEARED_REPLY,
  HIDE_PARTIAL_REPLY,
  hidePartialNote,
  hideWholeMapNote,
  goToLine,
  hiddenLine,
  MAP_SUPERSEDED_REPLY,
  NO_TOPIC_NOTE,
  NO_TOPIC_REPLY,
  REQUEST_FAILED_REPLY,
  PLAN_NO_PLACE_NOTE,
  PLAN_NO_PLACE_MAP_UNCHANGED_NOTE,
  notInPlanNote,
  inPlace,
  whichAreaQuestion,
  whichGroupQuestion,
} from "../prompts";

test("descriptions are non-empty and say when not to use the agent", () => {
  for (const d of [PLAN_AGENT_DESCRIPTION, MAP_AGENT_DESCRIPTION, SCOPE_AGENT_DESCRIPTION, MCP_NOT_PLAN_SUFFIX]) {
    assert.ok(d.trim().length > 0);
    assert.ok(d.includes("Do NOT use"), d);
  }
  assert.ok(PLAN_AGENT_DESCRIPTION.includes("תא/5500"));
  assert.ok(PLAN_AGENT_DESCRIPTION.includes("105"));
  assert.ok(MCP_NOT_PLAN_SUFFIX.includes("תא/5500"));
});

// LangChain f-string templates: `{name}` is a variable, `{{` / `}}` are literal braces.
function placeholders(template: string): string[] {
  const stripped = template.replace(/\{\{|\}\}/g, "");
  const rest = stripped.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
  assert.ok(!rest.includes("{") && !rest.includes("}"), "stray unescaped brace");
  return [...new Set([...stripped.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
}

test("prompt placeholders are exactly the expected input variables", () => {
  assert.deepEqual(placeholders(RESOLVE_PROMPT), ["currentFocus", "request"]);
  assert.deepEqual(placeholders(ANSWER_PROMPT), ["context", "question"]);
  assert.deepEqual(placeholders(MAP_RESOLVE_PROMPT), ["currentFocus", "request"]);
});

test("prompts carry the key rules", () => {
  assert.match(RESOLVE_PROMPT, /refine_focus/);
  assert.match(RESOLVE_PROMPT, /clear_focus/);
  assert.match(RESOLVE_PROMPT, /invent/i);
  assert.match(ANSWER_PROMPT, /usedItems/);
  assert.match(ANSWER_PROMPT, /ONLY/);
  assert.match(ANSWER_PROMPT, /gender-neutral/);
  for (const a of ["go_to", "show", "hide", "filter", "reset"]) assert.ok(MAP_RESOLVE_PROMPT.includes(a), a);
});

test("Hebrew copy is verbatim", () => {
  assert.equal(
    SCOPE_REPLY,
    'כאן אפשר לקבל מידע רק על תוכנית המתאר תא/5500 ועל מפת תל אביב-יפו. אפשר לשאול למשל: "מה מותר לבנות באזור 105?" או "הצג את אזורי התעסוקה ברמת אביב".',
  );
  assert.equal(NO_PLACE_NOTE, "לא זיהיתי את המקום שציינת, ולכן המפה לא שונתה.");
  assert.equal(OUTSIDE_TA_REPLY, "המקום שציינת נמצא מחוץ לתל אביב-יפו, וכאן אפשר לקבל מידע רק על תוכנית המתאר של העיר.");
  assert.equal(MAP_FAILED_NOTE, "לא הצלחתי לעדכן את המפה.");
});

test("shownLine", () => {
  assert.equal(shownLine("אזור 105", ["אזורי ייעוד"], ["תעסוקה"]), "מוצגים באזור 105: אזורי ייעוד. לא נמצאו באזור: תעסוקה.");
  assert.equal(shownLine(null, ["מוקדי פיתוח ושימוש עירוניים"], []), "מוצגים במפה: מוקדי פיתוח ושימוש עירוניים.");
  assert.equal(
    shownLine("אזור 105", ["אזורי ייעוד", "מוקדי פיתוח ושימוש עירוניים"], []),
    "מוצגים באזור 105: אזורי ייעוד, מוקדי פיתוח ושימוש עירוניים.",
  );
  assert.equal(shownLine("אזור 105", [], ["תעסוקה", "מגורים"]), "לא נמצאו באזור: תעסוקה, מגורים.");
  assert.equal(shownLine(null, [], ["תעסוקה"]), "לא נמצאו במפה: תעסוקה.");
  assert.equal(shownLine(null, [], []), "");
});

test("no exported Hebrew string uses gendered first person", () => {
  for (const [name, value] of Object.entries(prompts)) {
    if (typeof value === "string") assert.ok(!value.includes("אני עובד"), name);
  }
});

test("Map agent copy", () => {
  assert.equal(FOCUS_CLEARED_REPLY, "המיקוד נוקה והמפה חזרה למצבה הקודם.");
  assert.equal(REQUEST_FAILED_REPLY, "לא ניתן היה לעבד את הבקשה כרגע. נסו שוב.");
  assert.equal(NO_TOPIC_REPLY, "לא נמצאו בתוכנית שכבה או נושא מתאימים לבקשה, ולכן המפה לא שונתה.");
  assert.equal(NO_TOPIC_NOTE, "לא נמצאה בתוכנית שכבה מתאימה לנושא שצוין.");
  assert.equal(MAP_SUPERSEDED_REPLY, "התקבלה בקשת מפה חדשה יותר, ולכן הבקשה הזו לא הוחלה.");
  assert.equal(goToLine("אזור 105"), "המפה הועברה אל אזור 105.");
  assert.equal(hiddenLine(["מוקדי פיתוח ושימוש עירוניים"]), "הוסתרו במפה: מוקדי פיתוח ושימוש עירוניים.");
  assert.equal(hiddenLine([]), "");
});

test("hide copy", () => {
  assert.equal(
    HIDE_PARTIAL_REPLY,
    'אין אפשרות להסתיר רק חלק משכבה, ולכן המפה לא שונתה. אפשר לבקש במקום זאת להציג רק את הסוגים הרצויים, למשל "הצג רק אזורי תעסוקה".',
  );
  assert.equal(hidePartialNote(["אזורי ייעוד"]), "אין אפשרות להסתיר רק חלק משכבה, ולכן לא הוסתרו סוגים בתוך: אזורי ייעוד.");
  assert.equal(hidePartialNote([]), "");
  assert.equal(hideWholeMapNote("אזור 105"), "ההסתרה חלה על כל המפה, ולא רק על אזור 105.");
});

test("Plan agent place notes and not-in-plan note", () => {
  assert.equal(PLAN_NO_PLACE_NOTE, "לא זיהיתי את המקום שציינת, ולכן התשובה והמפה מתייחסות לכל העיר.");
  assert.equal(PLAN_NO_PLACE_MAP_UNCHANGED_NOTE, "לא זיהיתי את המקום שציינת, ולכן התשובה מתייחסת לכל העיר והמפה לא שונתה.");
  assert.equal(notInPlanNote("999"), "אזור 999 אינו מופיע בתוכנית.");
});

test("inPlace / shownLine drop the definite article after ב", () => {
  assert.equal(inPlace("הקריה"), "בקריה");
  assert.equal(inPlace("אזור 105"), "באזור 105");
  assert.equal(inPlace("רמת אביב"), "ברמת אביב");
  assert.equal(shownLine("הקריה", ["אזורי ייעוד"], []), "מוצגים בקריה: אזורי ייעוד.");
});

test("user-facing copy and examples never use area 610 (not in the plan)", () => {
  for (const [name, value] of Object.entries(prompts)) {
    if (typeof value === "string") assert.ok(!value.includes("610"), name);
  }
});

test("whichAreaQuestion lists the options and asks", () => {
  const q = whichAreaQuestion("רמת אביב", [
    { kind: "area", codes: ["102"], label: "אזור 102 – רמת אביב ג'" },
    { kind: "area", codes: ["106"], label: "אזור 106 – רמת אביב א'" },
  ]);
  assert.equal(q, "\"רמת אביב\" מתאים לכמה אזורי תכנון: אזור 102 – רמת אביב ג'; אזור 106 – רמת אביב א'. לאיזה מהם הכוונה?");
  assert.ok(RESOLVE_PROMPT.includes("which planning area"));
});

test("whichGroupQuestion names the layer and the drawings", () => {
  assert.equal(
    whichGroupQuestion([{ title: "מוקדי פיתוח ושימוש עירוניים", groups: ["אזורי ייעוד", "עיצוב עירוני"] }]),
    'השכבה "מוקדי פיתוח ושימוש עירוניים" מופיעה בכמה תשריטים: אזורי ייעוד, עיצוב עירוני. מאיזה תשריט להציג אותה?',
  );
  assert.ok(MAP_RESOLVE_PROMPT.includes("תשריט"));
  assert.ok(MAP_RESOLVE_PROMPT.includes("never a place"));
});
