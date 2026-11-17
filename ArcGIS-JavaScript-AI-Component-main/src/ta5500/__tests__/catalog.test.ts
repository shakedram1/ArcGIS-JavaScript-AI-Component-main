import test from "node:test";
import assert from "node:assert/strict";
import { groupLabel, matchCatalog, normalizePlanText, type CatalogEntry, type CatalogMatch } from "../catalog";

// The map's layers as the LayerList shows them (spec §3), group by group.
const GROUPS: [string, string[]][] = [
  ["אזורי ייעוד 5500", ["גבול התכנית", "אזור תכנון ומספרו", "מוקדי תחבורה כללי", "מוקדי פיתוח ושימוש עירוניים", "צירי תכנון וקווי תיחום", "ייעודי תעסוקה וקירוי", "אזורי ייעוד תכנוניים"]],
  ["עיצוב עירוני 5500", ["גבול התכנית", "אזור תכנון ומספרו", "מוקדי פיתוח ושימוש עירוניים", "צירי תכנון וקווי תיחום", "עיצוב עירוני פוליגוני", "מדרגות גובה בינוי", "אזורים ללא גובה"]],
  ["אזורי ומרחבי תכנון 5500", ["שמות רחובות עירוניים", "גבול התכנית", "צירי תכנון וקווי תיחום", "אזור תכנון ומספרו", "מרחבי תכנון", "הוראות רחוב מיוחדות"]],
  ["סביבה ותשתיות 5500", ["שמות רחובות עירוניים", "קווים מאזורי ייעוד", "גבול התכנית", "אזור תכנון ומספרו", "נקודות תשתית חמשל מים וביוב", "קווי תשתית", "פוליגוני תשתיות עירוניות", "מתקנים הנדסיים ימיים ונחלים"]],
  ["תחבורה וניידות 5500", ["שמות רחובות עירוניים", "גבול התכנית", "מוקדי תחבורה", "רשת תחבורה מטרופולינית", "פוליגונים תחבורה", "אזורי יעוד - דרך מהירה, ים ונחלים"]],
];
const INVENTORY: CatalogEntry[] = GROUPS.flatMap(([group, titles], g) => titles.map((title, i) => ({ uid: `${g}-${i}`, title, group })));

const titles = (m: CatalogMatch) => m.layers.map((e) => `${e.title}|${groupLabel(e.group)}`);

test("inventory fixture has the 34 layers of spec §3", () => {
  assert.equal(INVENTORY.length, 34);
});

test("normalizePlanText: spelling variants, plan name and quotes", () => {
  assert.equal(normalizePlanText("גבולות התוכנית תא/5500 באיזור יעוד"), "גבול התכנית באזור ייעוד");
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

test("matchCatalog: 'אזור תכנון 105' is a place phrase, not the layer 'אזור תכנון ומספרו'", () => {
  assert.deepEqual(matchCatalog("מה מותר לבנות באזור תכנון 105", INVENTORY), { layers: [], ambiguous: [] });
});

test("matchCatalog: a layer that exists in one group resolves even when another group is named", () => {
  assert.deepEqual(titles(matchCatalog("מדרגות גובה בינוי בתחבורה", INVENTORY)), ["מדרגות גובה בינוי|עיצוב עירוני"]);
});

test("matchCatalog: every drawing the question offers can be chosen (even 'אזורי ומרחבי תכנון', which contains a layer title)", () => {
  for (const g of ["אזורי ייעוד", "עיצוב עירוני", "אזורי ומרחבי תכנון", "סביבה ותשתיות", "תחבורה וניידות"]) {
    const m = matchCatalog(`גבול התכנית ${g}`, INVENTORY);
    assert.deepEqual(titles(m), [`גבול התכנית|${g}`], g);
    assert.deepEqual(m.ambiguous, [], g);
  }
  assert.deepEqual(titles(matchCatalog("גבול התכנית אזורי תכנון", INVENTORY)), ["גבול התכנית|אזורי ומרחבי תכנון"]);
  // The layer "מרחבי תכנון" alone is still that layer.
  assert.deepEqual(titles(matchCatalog("הצג מרחבי תכנון", INVENTORY)), ["מרחבי תכנון|אזורי ומרחבי תכנון"]);
});

test("matchCatalog: 'תשתיות' and 'תשתית' are the same word (קווי תשתיות → the layer קווי תשתית)", () => {
  for (const q of ["תציג לי עכשיו קווי תשתיות", "סליחה תציג לי קווי תשתית", "הצג את קווי התשתיות"]) {
    assert.deepEqual(titles(matchCatalog(q, INVENTORY)), ["קווי תשתית|סביבה ותשתיות"], q);
  }
  // the drawing "סביבה ותשתיות" is still named by either spelling
  assert.deepEqual(titles(matchCatalog("גבול התכנית של התשתיות", INVENTORY)), ["גבול התכנית|סביבה ותשתיות"]);
});
