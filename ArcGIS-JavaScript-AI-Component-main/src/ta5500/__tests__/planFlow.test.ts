import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { parseSearchPlanResult, PlanServiceError, PLAN_SERVICE_UNAVAILABLE } from "../ragClient";
import { REQUEST_FAILED_REPLY } from "../prompts";
import type { LayerKey } from "../layers";
import { validateRequest } from "../planLogic";
import {
  answerContext,
  candidateLayers,
  composeOutput,
  conversationText,
  failureReply,
  focusSummary,
  mapStep,
  placeFromText,
  topicLayers,
  mergeFilters,
  placeFromFilters,
  placeSearchFilters,
} from "../planFlow";
import type { PlanLocations } from "../types";

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
    assert.deepEqual(failureReply(e, "t"), { output: e.message, ok: false });
    assert.equal(e.message, PLAN_SERVICE_UNAVAILABLE);
    assert.deepEqual(failureReply(new Error("x"), "t"), { output: REQUEST_FAILED_REPLY, ok: false });
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
