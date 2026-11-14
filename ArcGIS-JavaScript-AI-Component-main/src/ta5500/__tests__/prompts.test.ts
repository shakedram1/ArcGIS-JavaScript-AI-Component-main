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
} from "../prompts";

test("descriptions are non-empty and say when not to use the agent", () => {
  for (const d of [PLAN_AGENT_DESCRIPTION, MAP_AGENT_DESCRIPTION, SCOPE_AGENT_DESCRIPTION, MCP_NOT_PLAN_SUFFIX]) {
    assert.ok(d.trim().length > 0);
    assert.ok(d.includes("Do NOT use"), d);
  }
  assert.ok(PLAN_AGENT_DESCRIPTION.includes("תא/5500"));
  assert.ok(PLAN_AGENT_DESCRIPTION.includes("610"));
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
    'כאן אפשר לקבל מידע רק על תוכנית המתאר תא/5500 ועל מפת תל אביב-יפו. אפשר לשאול למשל: "מה מותר לבנות באזור 610?" או "הצג את אזורי התעסוקה ברמת אביב".',
  );
  assert.equal(NO_PLACE_NOTE, "לא זיהיתי את המקום שציינת, ולכן המפה לא שונתה.");
  assert.equal(OUTSIDE_TA_REPLY, "המקום שציינת נמצא מחוץ לתל אביב-יפו, וכאן אפשר לקבל מידע רק על תוכנית המתאר של העיר.");
  assert.equal(MAP_FAILED_NOTE, "לא הצלחתי לעדכן את המפה.");
});

test("shownLine", () => {
  assert.equal(shownLine("אזור 610", ["אזורי ייעוד"], ["תעסוקה"]), "מוצגים באזור 610: אזורי ייעוד. לא נמצאו באזור: תעסוקה.");
  assert.equal(shownLine(null, ["מוקדי פיתוח ושימוש עירוניים"], []), "מוצגים במפה: מוקדי פיתוח ושימוש עירוניים.");
  assert.equal(
    shownLine("אזור 610", ["אזורי ייעוד", "מוקדי פיתוח ושימוש עירוניים"], []),
    "מוצגים באזור 610: אזורי ייעוד, מוקדי פיתוח ושימוש עירוניים.",
  );
  assert.equal(shownLine("אזור 610", [], ["תעסוקה", "מגורים"]), "לא נמצאו באזור: תעסוקה, מגורים.");
  assert.equal(shownLine(null, [], ["תעסוקה"]), "לא נמצאו במפה: תעסוקה.");
  assert.equal(shownLine(null, [], []), "");
});

test("no exported Hebrew string uses gendered first person", () => {
  for (const [name, value] of Object.entries(prompts)) {
    if (typeof value === "string") assert.ok(!value.includes("אני עובד"), name);
  }
});
