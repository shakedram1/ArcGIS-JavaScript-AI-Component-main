import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { parseSearchPlanResult } from "../ragClient";
import { validateRequest } from "../planLogic";
import {
  answerContext,
  candidateLayers,
  composeOutput,
  conversationText,
  focusSummary,
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
