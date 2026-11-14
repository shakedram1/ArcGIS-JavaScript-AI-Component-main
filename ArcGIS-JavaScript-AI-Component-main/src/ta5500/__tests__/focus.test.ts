import test from "node:test";
import assert from "node:assert/strict";
import { buildCodeWhere, focusLabel, focusStore, planFocus } from "../focus";
import type { FocusState, Place } from "../focus";
import type { LayerKey } from "../layers";

const area: Place = { kind: "area", codes: ["105"], label: "אזור 105" };

test("planFocus cases", () => {
  const cands = new Map<LayerKey, string[]>([["zones", ["332"]]]);
  const r = planFocus(area, cands);
  assert.equal(r.case, "place_topic");
  assert.deepEqual(r.layers.get("zones"), ["332"]);
  assert.notEqual(r.layers, cands);
  const po = planFocus(area, new Map());
  assert.equal(po.case, "place_only");
  assert.deepEqual(po.layers.get("zones"), []);
  assert.equal(planFocus(null, new Map([["foci", ["335"]]])).case, "topic_only");
  const n = planFocus(null, new Map());
  assert.equal(n.case, "none");
  assert.equal(n.layers.size, 0);
});

test("buildCodeWhere", () => {
  assert.equal(buildCodeWhere("EzorYeudCode", "string", ["332", "3'3"]), "EzorYeudCode IN ('332','3''3')");
  assert.equal(buildCodeWhere("TypeCode", "number", ["335", "x"]), "TypeCode IN (335)");
  assert.equal(buildCodeWhere("TypeCode", "number", ["x"]), "1=0");
  assert.equal(buildCodeWhere("f", "string", []), "1=1");
  assert.equal(buildCodeWhere("f", "number", [" 5 ", "5", "6"]), "f IN (5,6)");
  assert.equal(buildCodeWhere("f", "string", ["a", "a", "b"]), "f IN ('a','b')");
});

test("focusStore", () => {
  const st: FocusState = {
    place: area, geometryJson: null, layers: [{ layerKey: "zones", where: "1=1" }],
    previousVisibility: { u1: true, u2: false }, label: "x",
  };
  const seen: (FocusState | null)[] = [];
  const unsub = focusStore.subscribe((s) => seen.push(s));
  focusStore.subscribe(() => { throw new Error("boom"); });
  focusStore.set(st);
  assert.equal(focusStore.get(), st);
  assert.deepEqual(focusStore.get()?.previousVisibility, { u1: true, u2: false });
  assert.equal(focusStore.clear(), st);
  assert.equal(focusStore.get(), null);
  assert.deepEqual(seen, [st, null]);
  unsub();
  focusStore.set(st);
  assert.equal(seen.length, 2);
  focusStore.clear();
});

test("focusLabel", () => {
  assert.equal(focusLabel(area, []), "מיקוד: אזור 105");
  assert.equal(focusLabel(null, ["אזורי תעסוקה"]), "מיקוד: אזורי תעסוקה");
  assert.equal(focusLabel(null, ["a", "b"]), "מיקוד: a, b");
  assert.equal(focusLabel(null, []), "מיקוד");
});
