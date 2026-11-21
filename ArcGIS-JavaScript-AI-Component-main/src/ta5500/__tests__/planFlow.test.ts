import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { parseSearchPlanResult, PlanServiceError, PLAN_SERVICE_UNAVAILABLE } from "../ragClient";
import { REQUEST_FAILED_REPLY, PLAN_NO_PLACE_NOTE, PLAN_NO_PLACE_MAP_UNCHANGED_NOTE } from "../prompts";
import type { LayerKey } from "../layers";
import { validateRequest } from "../planLogic";
import {
  answerContext,
  areaShapedCode,
  candidateLayers,
  mapFailedSummary,
  missingPlaceGeometry,
  PLAN_SERVICE_DOWN_SUMMARY,
  planPlaceNote,
  placeTextStep,
  placesByName,
  planCatalogUids,
  planViewerHits,
  REQUEST_FAILED_SUMMARY,
  unplannedAreaCode,
  useStoredPlace,
  composeOutput,
  conversationText,
  failureReply,
  focusSummary,
  hideReply,
  hideTargets,
  mapStep,
  placeFromText,
  topicLayers,
  mergeFilters,
  placeFromFilters,
  placeSearchFilters,
} from "../planFlow";
import type { PlanLocations } from "../types";
import type { Place } from "../focus";

const fixtureJson = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const loc: PlanLocations = JSON.parse(fixtureJson("locations.json").content[0].text);
const searchResult = () => parseSearchPlanResult(fixtureJson("search-plan.json"));

test("conversationText keeps user/assistant turns, drops tool turns, ends with the request", () => {
  const msgs = [
    new HumanMessage("מה מותר לבנות באזור 105?"),
    new AIMessage({ content: "", tool_calls: [{ id: "1", name: "x", args: {} }] }),
    new ToolMessage({ content: "raw", tool_call_id: "1" }),
    new AIMessage("באזור 105 ..."),
  ];
  assert.equal(
    conversationText(msgs, "ומה לגבי מגורים שם?"),
    "User: מה מותר לבנות באזור 105?\nAssistant: באזור 105 ...\nUser: ומה לגבי מגורים שם?",
  );
  // The request already last in the history is not repeated.
  assert.equal(conversationText([new HumanMessage("שאלה")], "שאלה"), "User: שאלה");
  assert.equal(conversationText(undefined, "שאלה"), "User: שאלה");
  assert.equal(conversationText([], "a", 8).split("\n").length, 1);
});

test("mergeFilters unions and drops empty lists", () => {
  assert.deepEqual(mergeFilters({ areas: ["105"], zone_types: [] }, { areas: ["105", "106"], zone_types: ["3.3"] }), {
    areas: ["105", "106"],
    zone_types: ["3.3"],
  });
});

test("placeFromFilters: area, sub-area, street entity, none", () => {
  assert.deepEqual(placeFromFilters({ areas: ["105"] }, loc), { kind: "area", codes: ["105"], label: "אזור 105 – אפקה" });
  assert.deepEqual(placeFromFilters({ areas: ["105", "101ה", "106"] }, loc)?.codes, ["105", "106"]);
  assert.equal(placeFromFilters({ areas: ["105", "106"] }, loc)?.label, "אזורים 105, 106");
  const sub = placeFromFilters({ areas: ["101א"] }, loc);
  assert.deepEqual(sub, { kind: "subarea", codes: ["101א"], label: "אזור 101א – צומת גלילות" });
  const street = placeFromFilters(validateRequest({ entities: ["ר-11"] }, loc).filters, loc);
  assert.deepEqual(street, { kind: "street", codes: ["ר-11"], label: "רחוב חיים לבנון (ר-11)" });
  assert.equal(placeFromFilters({ zone_types: ["3.3"] }, loc), null);
  assert.equal(placeFromFilters({}, loc), null);
});

test("placeSearchFilters validates stored or geocoded place codes", () => {
  assert.deepEqual(placeSearchFilters({ kind: "geocoded", codes: ["102", "999"], label: "רמת אביב" }, loc), { areas: ["102"] });
  assert.deepEqual(placeSearchFilters({ kind: "street", codes: ["ר-11"], label: "x" }, loc), { entities: ["ר-11"] });
});

test("answerContext passes the RAG text with its band line; adds one only when missing", () => {
  const r = searchResult();
  assert.equal(answerContext(r), r.text);
  assert.ok(answerContext(r).startsWith("רמת התאמה: התאמה גבוהה"));
  assert.ok(answerContext({ ...r, text: "[1] x", band: "low" }).startsWith("רמת התאמה: התאמה נמוכה\n\n[1] x"));
});

test("planViewerHits preserves ranked structured IDs and supports the legacy text marker", () => {
  const result = searchResult();
  const hit = result.hits[0];
  assert.deepEqual(planViewerHits({
    ...result,
    hits: [{ ...hit, chunk_id: "4.3" }, { ...hit, chunk_id: undefined }, { ...hit, chunk_id: "5.4[5]" }],
  }), [{ id: "4.3" }, { id: "5.4[5]" }]);
  assert.deepEqual(planViewerHits({
    ...result,
    hits: [],
    text: 'context\n<!--ta5500-hits:[{"id":"4.3","p":65,"s":0.75}]-->',
  }), [{ id: "4.3", p: 65, s: 0.75 }]);
  assert.deepEqual(planViewerHits({ ...result, hits: [], text: "no hits" }), []);
});

test("candidateLayers merges cited sections with override zone types", () => {
  const r = searchResult();
  const none = candidateLayers(r, [], [], loc);
  assert.equal(none.size, 0);
  const withOverride = candidateLayers(r, [], ["3.3"], loc);
  assert.ok(withOverride.size > 0);
  const cited = candidateLayers(r, [2], [], loc); // [2] is סעיף 3.3
  assert.deepEqual([...cited.keys()].sort(), [...withOverride.keys()].sort());
});

test("composeOutput and focusSummary", () => {
  assert.equal(composeOutput("תשובה", "מוצגים במפה: x.", "", null, "הערה"), "תשובה\n\nמוצגים במפה: x.\n\nהערה");
  assert.equal(focusSummary(null, []), "no place; layers: none");
  assert.equal(focusSummary({ kind: "area", codes: ["105"], label: "אזור 105" }, ["zones", "foci"]), "אזור 105; layers: zones, foci");
});

test("failureReply: plan-service message, else the generic reply", () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const e = new PlanServiceError("down");
    // Only a plan-service outage is "failed", and its summary tells the orchestrator not to retry.
    assert.deepEqual(failureReply(e, "t"), { output: e.message, ok: false, summary: PLAN_SERVICE_DOWN_SUMMARY });
    assert.equal(e.message, PLAN_SERVICE_UNAVAILABLE);
    assert.equal(e.message, "שירות תוכנית המתאר אינו זמין כרגע. נסו שוב בעוד מספר דקות.");
    assert.match(PLAN_SERVICE_DOWN_SUMMARY, /do not retry/);
    // Any other error: reported to the user, ok (no re-route to an agent that cannot ground the answer).
    assert.deepEqual(failureReply(new Error("x"), "t"), { output: REQUEST_FAILED_REPLY, ok: true, summary: REQUEST_FAILED_SUMMARY });
    assert.match(REQUEST_FAILED_SUMMARY, /do not retry/);
  } finally {
    console.warn = warn;
  }
});

test("placeFromText: plan codes and entities only", () => {
  assert.deepEqual(placeFromText("105", loc), { kind: "area", codes: ["105"], label: "אזור 105 – אפקה" });
  assert.equal(placeFromText("101א", loc)?.kind, "subarea");
  assert.deepEqual(placeFromText("ר-11", loc)?.codes, ["ר-11"]);
  assert.equal(placeFromText("רמת אביב", loc), null);
  assert.equal(placeFromText("9999", loc), null);
  assert.equal(placeFromText(null, loc), null);
  assert.equal(placeFromText("  ", loc), null);
});

test("topicLayers: plan data, overrides and layer names only", () => {
  // Zone category by title and by its core word.
  assert.deepEqual(topicLayers("אזורי מגורים", loc).get("zones"), ["322", "323", "324", "325"]);
  assert.deepEqual(topicLayers("מגורים", loc).get("zones"), ["322", "323", "324", "325"]);
  // Exact zone type id / title (validateRequest).
  assert.deepEqual([...topicLayers("3.3.5", loc)], [["foci", ["335"]]]);
  assert.deepEqual([...topicLayers("מוקד תעסוקה חדש", loc)], [["foci", ["335"]]]);
  // Topic override (תעסוקה → 3.3, 3.4.1) plus the employment layer named by its label (whole layer).
  const emp = topicLayers("אזורי תעסוקה", loc);
  assert.ok(emp.get("zones")?.includes("332") && emp.get("zones")?.includes("341"));
  assert.deepEqual(emp.get("employment"), []);
  // Whole layers by name, with Hebrew prefixes.
  assert.deepEqual([...topicLayers("שכבת המוקדים", loc)], [["foci", []]]);
  assert.deepEqual([...topicLayers("רחובות מיוחדים", loc)], [["streets", []]]);
  // Not in the plan.
  assert.equal(topicLayers("מזג אוויר", loc).size, 0);
  assert.equal(topicLayers("בתי קפה", loc).size, 0);
  assert.equal(topicLayers(null, loc).size, 0);
  assert.equal(topicLayers("", loc).size, 0);
});

test("mapStep: never acts on things not in the plan", () => {
  const place = { kind: "area" as const, codes: ["105"], label: "אזור 105" };
  const some = new Map<LayerKey, string[]>([["foci", []]]);
  const none = new Map<LayerKey, string[]>();
  assert.equal(mapStep("reset", { placeText: null, place: null, layers: none }), "reset");
  assert.equal(mapStep("hide", { placeText: null, place: null, layers: some }), "hide");
  assert.equal(mapStep("hide", { placeText: "105", place, layers: none }), "no_topic");
  assert.equal(mapStep("go_to", { placeText: "חיפה", place: null, layers: none, outside: true }), "outside");
  assert.equal(mapStep("show", { placeText: "חיפה", place: null, layers: some, outside: true }), "outside");
  assert.equal(mapStep("reset", { placeText: "חיפה", place: null, layers: none, outside: true }), "reset");
  assert.equal(mapStep("go_to", { placeText: "105", place, layers: none }), "go_to");
  assert.equal(mapStep("go_to", { placeText: "מקום", place: null, layers: some }), "no_place");
  assert.equal(mapStep("go_to", { placeText: null, place: null, layers: none }), "no_place");
  for (const a of ["show", "filter"] as const) {
    assert.equal(mapStep(a, { placeText: null, place: null, layers: some }), "focus");
    assert.equal(mapStep(a, { placeText: "105", place, layers: none }), "focus");
    assert.equal(mapStep(a, { placeText: "105", place, layers: some }), "focus");
    assert.equal(mapStep(a, { placeText: "מקום", place: null, layers: some }), "no_place");
    assert.equal(mapStep(a, { placeText: null, place: null, layers: none }), "no_topic");
    assert.equal(mapStep(a, { placeText: "  ", place: null, layers: none }), "no_topic");
  }
});

test("hide: whole layers only, never outside Tel Aviv, place does not scope it", () => {
  const place = { kind: "geocoded" as const, codes: ["102"], label: "רמת אביב" };
  const foci = topicLayers("שכבת המוקדים", loc);
  // Place outside Tel Aviv-Yafo → declined, map unchanged.
  assert.equal(mapStep("hide", { placeText: "חיפה", place: null, layers: foci, outside: true }), "outside");
  // Named place not identified → no_place (map unchanged), as for show / filter.
  assert.equal(mapStep("hide", { placeText: "מקום לא ידוע", place: null, layers: foci }), "no_place");
  // Place inside Tel Aviv-Yafo → hide the whole layer and say it applies to the whole map.
  assert.equal(mapStep("hide", { placeText: "רמת אביב", place, layers: foci }), "hide");
  assert.equal(
    hideReply({ hidden: ["מוקדי פיתוח ושימוש עירוניים"], missing: [], partial: [], placeLabel: place.label }),
    "הוסתרו במפה: מוקדי פיתוח ושימוש עירוניים.\n\nההסתרה חלה על כל המפה, ולא רק על רמת אביב.",
  );
  // Code-level only (types inside the zones layer) → no action.
  const residential = topicLayers("אזורי מגורים", loc);
  assert.deepEqual(hideTargets(residential), { whole: [], partial: ["zones"] });
  assert.equal(mapStep("hide", { placeText: null, place: null, layers: residential }), "hide_partial");
  // Mixed: employment layer named as a whole, zone types inside the zones layer → hide only the whole layer.
  const emp = topicLayers("אזורי תעסוקה", loc);
  assert.deepEqual(hideTargets(emp), { whole: ["employment"], partial: ["zones", "foci"] });
  assert.equal(mapStep("hide", { placeText: null, place: null, layers: emp }), "hide");
  assert.equal(
    hideReply({ hidden: ["תעסוקה"], missing: [], partial: ["אזורי ייעוד"], placeLabel: null }),
    "הוסתרו במפה: תעסוקה.\n\nאין אפשרות להסתיר רק חלק משכבה, ולכן לא הוסתרו סוגים בתוך: אזורי ייעוד.",
  );
  // Whole layer not on the map.
  assert.equal(hideReply({ hidden: [], missing: ["מרחבי תכנון"], partial: [], placeLabel: "רמת אביב" }), "לא נמצאו במפה: מרחבי תכנון.");
});

test("mapFailedSummary says the map update failed and not to retry", () => {
  assert.equal(mapFailedSummary("go_to"), "go_to: map update failed; the user was told; do not retry");
});

test("areaShapedCode: shape only", () => {
  assert.equal(areaShapedCode("105"), "105");
  assert.equal(areaShapedCode("999"), "999");
  assert.equal(areaShapedCode("101ה"), "101ה");
  assert.equal(areaShapedCode("101-ה"), "101ה");
  assert.equal(areaShapedCode('"610"'), "610");
  assert.equal(areaShapedCode("אזור 999"), "999");
  assert.equal(areaShapedCode("אזור תכנון 105"), "105");
  assert.equal(areaShapedCode("רמת אביב"), null);
  assert.equal(areaShapedCode("4.3"), null);
  assert.equal(areaShapedCode("1050"), null);
  assert.equal(areaShapedCode("הרצל 105"), null);
  assert.equal(areaShapedCode(null), null);
});

test("placeTextStep: plan codes, area codes not in the plan are never geocoded", () => {
  assert.deepEqual(placeTextStep("105", loc), { kind: "coded", place: { kind: "area", codes: ["105"], label: "אזור 105 – אפקה" } });
  assert.equal((placeTextStep("אזור 105", loc) as { place: { codes: string[] } }).place.codes[0], "105");
  assert.deepEqual(placeTextStep("610", loc), { kind: "not_in_plan", code: "610" });
  assert.deepEqual(placeTextStep("אזור 999", loc), { kind: "not_in_plan", code: "999" });
  assert.deepEqual(placeTextStep("דיזנגוף 50", loc), { kind: "geocode" });
  assert.deepEqual(placeTextStep("  ", loc), { kind: "none" });
  assert.deepEqual(placeTextStep(null, loc), { kind: "none" });
});

test("placeTextStep: the plan itself or the whole city is not a place (never geocoded)", () => {
  for (const t of ["תא/5500", "תא 5500", "תכנית 5500", "תוכנית 5500", "תוכנית תא/5500", "5500", "התוכנית", "תוכנית המתאר", "תל אביב", "תל אביב-יפו", "העיר", "בתל אביב"]) {
    assert.deepEqual(placeTextStep(t, loc), { kind: "none" }, t);
  }
  assert.deepEqual(placeTextStep("דיזנגוף 50", loc), { kind: "geocode" });
});

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

test("mapStep: ambiguous layers are asked for show/filter; whole layers focus", () => {
  const base = { placeText: "", place: null, layers: new Map() };
  assert.equal(mapStep("show", { ...base, ambiguousLayers: true }), "ask_layer");
  assert.equal(mapStep("filter", { ...base, ambiguousLayers: true }), "ask_layer");
  assert.equal(mapStep("reset", { ...base, ambiguousLayers: true }), "reset");
  assert.equal(mapStep("show", { ...base, wholeLayers: 1 }), "focus");
  assert.equal(mapStep("show", base), "no_topic");
});

test("planCatalogUids: only layers that resolved to one drawing", () => {
  const e = { uid: "1-5", title: "צירי תכנון וקווי תיחום", group: "אזורי ייעוד 5500" };
  assert.deepEqual(planCatalogUids({ layers: [e], ambiguous: [{ title: "גבול התכנית", groups: ["a", "b"] }] }), ["1-5"]);
  assert.deepEqual(planCatalogUids({ layers: [], ambiguous: [] }), []);
});

test("placesByName: an area whose whole name (or a comma-separated part) is the text beats names that only contain it", () => {
  assert.deepEqual(placesByName("צהלה", loc).map((p) => p.codes[0]), ["207"]);
  assert.deepEqual(placesByName("אפקה", loc).map((p) => p.codes[0]), ["105"]);
  assert.deepEqual(placesByName("פלורנטין", loc).map((p) => p.codes[0]), ["801"]);
  assert.deepEqual(placesByName("נווה שרת", loc).map((p) => p.codes[0]), ["208"]);
  assert.deepEqual(placesByName("רמת אביב", loc).map((p) => p.codes[0]), ["102", "103", "104", "106"]); // no exact name: still several
});

test("placesByName: sub-areas only by their whole name; a street or landmark inside a longer name is geocoded", () => {
  for (const t of ["אבן גבירול", 'המע"ר', "שרונה"]) assert.deepEqual(placeTextStep(t, loc), { kind: "geocode" }, t);
  assert.equal((placeTextStep("רובע שדה דב", loc) as { place: Place }).place.codes[0], "101ו");
});

test("placesByName: a single generic word is not matched by containment (geocoded as before)", () => {
  for (const t of ["יפו", "גלילות", "החשמל"]) assert.deepEqual(placesByName(t, loc).filter((p) => p.kind === "area" && p.codes.length > 1), [], t);
  assert.deepEqual(placeTextStep("יפו", loc), { kind: "geocode" });
});

test("unplannedAreaCode: dropped area-shaped values that are not plan areas", () => {
  assert.equal(unplannedAreaCode(["999"], loc), "999");
  assert.equal(unplannedAreaCode(validateRequest({ areas: ["999"] }, loc).dropped, loc), "999");
  assert.equal(unplannedAreaCode(['"610"', "4.3"], loc), "610");
  assert.equal(unplannedAreaCode(["4.3", "רמת אביב"], loc), null);
  assert.equal(unplannedAreaCode(["105"], loc), null); // a plan area dropped as an entity is not "not in the plan"
  assert.equal(unplannedAreaCode([], loc), null);
});

test("useStoredPlace: only with no place named, or the stored place named again", () => {
  const stored = { kind: "geocoded" as const, codes: ["102"], label: "רמת אביב" };
  assert.equal(useStoredPlace("", stored), true);
  assert.equal(useStoredPlace(null, stored), true);
  assert.equal(useStoredPlace("רמת אביב", stored), true);
  assert.equal(useStoredPlace("פלורנטין", stored), false);
  assert.equal(useStoredPlace("", null), false);
});

test("planPlaceNote: not-in-plan area, city-wide with or without a map focus", () => {
  const base = { placeResolved: false, placeText: "", unplannedArea: null, focusApplied: true };
  assert.equal(planPlaceNote({ ...base, placeResolved: true, placeText: "x", unplannedArea: "999" }), "");
  assert.equal(planPlaceNote(base), "");
  assert.equal(planPlaceNote({ ...base, unplannedArea: "999" }), "אזור 999 אינו מופיע בתוכנית.");
  assert.equal(planPlaceNote({ ...base, placeText: "מקום", unplannedArea: "999" }), "אזור 999 אינו מופיע בתוכנית.");
  assert.equal(planPlaceNote({ ...base, placeText: "מקום" }), PLAN_NO_PLACE_NOTE);
  assert.equal(planPlaceNote({ ...base, placeText: "מקום", focusApplied: false }), PLAN_NO_PLACE_MAP_UNCHANGED_NOTE);
});

test("missingPlaceGeometry", () => {
  const place = { kind: "area" as const, codes: ["105"], label: "אזור 105" };
  assert.equal(missingPlaceGeometry(place, null), true);
  assert.equal(missingPlaceGeometry(place, {}), false);
  assert.equal(missingPlaceGeometry(null, null), false);
});

test("mapStep: an area code that is not in the plan is never acted on", () => {
  const some = new Map<LayerKey, string[]>([["foci", []]]);
  for (const a of ["go_to", "show", "filter", "hide"] as const) {
    assert.equal(mapStep(a, { placeText: "610", place: null, layers: some, notInPlan: true }), "not_in_plan");
  }
  assert.equal(mapStep("reset", { placeText: "610", place: null, layers: some, notInPlan: true }), "reset");
});
