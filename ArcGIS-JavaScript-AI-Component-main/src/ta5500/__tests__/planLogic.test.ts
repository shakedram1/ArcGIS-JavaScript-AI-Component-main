import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSearchPlanResult } from "../ragClient";
import { citedSections, isInsideExtent, layersForSections, validateRequest } from "../planLogic";
import type { PlanLocations, PlanSearchResult } from "../types";

const fixtureJson = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const loc: PlanLocations = JSON.parse(fixtureJson("locations.json").content[0].text);
const searchResult = () => parseSearchPlanResult(fixtureJson("search-plan.json"));

test("validateRequest keeps valid values, normalizes, maps titles, drops the rest", () => {
  const r = validateRequest(
    { areas: ["105", "999", "101 ה'"], zone_types: ["אזור מעורב", "3.3"], headings: ["4.3", "abc"] },
    loc,
  );
  assert.deepEqual(r.filters, { areas: ["105", "101ה"], zone_types: ["3.4.1", "3.3"], headings: ["4.3"] });
  assert.ok(r.dropped.includes("999"));
  assert.ok(r.dropped.includes("abc"));
});

test("sub-area normalization variants", () => {
  for (const v of ["101 ה'", "ה101", "101-ה", "101ה", " 101ה "]) {
    assert.deepEqual(validateRequest({ areas: [v] }, loc).filters.areas, ["101ה"], v);
  }
  assert.deepEqual(validateRequest({ areas: ["101ץ", "101אב"] }, loc).filters.areas, []);
});

test("empty, whitespace, duplicates and unknown values never pass through", () => {
  const r = validateRequest(
    {
      areas: ["", "   ", "105", "105", " 105 "],
      entities: ["", " ", "ר-11", "ר-11", "לא קיים"],
      zone_types: ["", "3.3", "3.3", "אזור מעורב", "3.4.1", "9.9.9"],
      headings: ["", " ", "4.3", "4.3", "4.7.1(ב)", "4.", "x4.3", "4.3 "],
    },
    loc,
  );
  assert.deepEqual(r.filters.areas, ["105"]);
  assert.deepEqual(r.filters.entities, ["ר-11"]);
  assert.deepEqual(r.filters.zone_types, ["3.3", "3.4.1"]);
  assert.deepEqual(r.filters.headings, ["4.3", "4.7.1(ב)"]);
  for (const bad of ["לא קיים", "9.9.9", "4.", "x4.3"]) assert.ok(r.dropped.includes(bad), bad);
});

test("entity matches by code or label; empty entity code is not a wildcard", () => {
  const e = validateRequest({ entities: ["ר-11 רחוב חיים לבנון", "אזור תכנון 101", "ר-12"] }, loc).filters.entities;
  assert.deepEqual(e, ["ר-11 רחוב חיים לבנון", "אזור תכנון 101", "ר-12"]);
  assert.deepEqual(validateRequest({ entities: [""] }, loc).filters.entities, []);
});

test("zone type: category id and exact title only", () => {
  assert.deepEqual(validateRequest({ zone_types: ["3.3", "3.4"] }, loc).filters.zone_types, ["3.3", "3.4"]);
  assert.deepEqual(validateRequest({ zone_types: ["אזורי תעסוקה"] }, loc).filters.zone_types, []); // category titles are not accepted
  const r = validateRequest({ zone_types: ["אזור"] }, loc);
  assert.deepEqual(r.filters.zone_types, []);
  assert.deepEqual(r.dropped, ["אזור"]);
});

test("validateRequest omits keys not requested", () => {
  assert.deepEqual(validateRequest({}, loc), { filters: {}, dropped: [] });
});

test("layersForSections: type and subsection", () => {
  const m = layersForSections(["3.3.2(ב)"], loc.gis_codes);
  assert.deepEqual(m.get("zones"), ["332"]);
  assert.deepEqual(m.get("employment"), ["3321", "3322", "3323"]);
});

test("layersForSections: category covers its types", () => {
  const m = layersForSections(["3.3"], loc.gis_codes);
  for (const c of ["332", "333", "334"]) assert.ok(m.get("zones")!.includes(c));
  assert.ok(m.get("foci")!.includes("335"));
});

test("layersForSections: section without GIS mapping gives an empty map", () => {
  assert.equal(layersForSections(["4.3"], loc.gis_codes).size, 0);
  assert.equal(layersForSections([], loc.gis_codes).size, 0);
});

test("layersForSections ignores unknown layers, does not prefix-match by digits, dedupes", () => {
  const gis = [
    { layer: "bogus", code: "1", key: "headings" as const, value: "3.3", note: "" },
    { layer: "zones", code: "A", key: "headings" as const, value: "3.3", note: "" },
    { layer: "zones", code: "A", key: "zone_types" as const, value: "3.3", note: "" },
    { layer: "zones", code: "B", key: "headings" as const, value: "3.30", note: "" },
  ];
  const m = layersForSections(["3.3"], gis);
  assert.deepEqual([...m.keys()], ["zones"]);
  assert.deepEqual(m.get("zones"), ["A"]);
});

test("citedSections on a real search result", () => {
  const r = searchResult();
  // hit 1 is a "טבלה 5.4" row (adds the result's zone_types), hits 2 and 4 are "סעיף 3.3" and "סעיף 3.3.3"
  assert.deepEqual(citedSections(r, [2, 4]), ["3.3", "3.3.3"]);
  const withTable = citedSections(r, [1, 2]);
  assert.ok(withTable.length > 0);
  for (const id of withTable) assert.match(id, /^\d+(\.\d+)*$/);
  assert.ok(withTable.includes("3.3"));
});

test("citedSections parses citation shapes", () => {
  const mk = (...citations: string[]): PlanSearchResult => ({
    text: "",
    band: "high",
    location: { areas: [], subareas: [], zone_types: ["3.3.2", "3.4.1"], entities: [] },
    hits: citations.map((citation) => ({ citation, pages: "", via: "", heading_path: "" })),
  });
  const r = mk("סעיף 3.3.2(ב)", "סעיפים 3.10, 3.11", "סעיף 4.7.1(ב)-(ג)", "טבלה 5.4 - אזור תכנון 105", "סעיף 3.3.2(ג)(1)");
  assert.deepEqual(citedSections(r, [1]), ["3.3.2"]);
  assert.deepEqual(citedSections(r, [2]), ["3.10", "3.11"]);
  assert.deepEqual(citedSections(r, [3]), ["4.7.1"]);
  assert.deepEqual(citedSections(r, [4]), ["3.3.2", "3.4.1"]);
  assert.deepEqual(citedSections(r, [5]), ["3.3.2"]);
  assert.deepEqual(citedSections(r, [1, 5, 2]), ["3.3.2", "3.10", "3.11"]);
  assert.deepEqual(citedSections(r, [0, 99, -1, 1.5]), []);
});

test("isInsideExtent", () => {
  const e = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
  assert.equal(isInsideExtent({ x: 5, y: 5 }, e), true);
  assert.equal(isInsideExtent({ x: 11, y: 5 }, e), false);
  assert.equal(isInsideExtent({ x: 5, y: -1 }, e), false);
  assert.equal(isInsideExtent({ x: 10, y: 10 }, e), true);
});

test("a text-only section (4.5, תכנון בר קיימה) has no map layers", () => {
  assert.equal(layersForSections(["4.5"], loc.gis_codes).size, 0);
});
