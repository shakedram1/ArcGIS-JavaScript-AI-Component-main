import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZoneColumns } from "./zoneTable.ts";

const urban = {
  EzorYeud: "אזור מגורים בבניה עירונית",
  MikbazeiShimushim_Rashi: "מגורים",
  MikbazeiShimushim_nosafim: "(א) מסחר 1",
  RahakMinEzorYeud: 2,
  RahakMaxEzorYeud: 4,
  MaxRahakIncAdd: 4,
  k_gova: 20,
  MaxGovaInc: 20,
  Instructions: "102 - אזור מגורים בבניה עירונית",
};
const tall = {
  EzorYeud: "אזור מגורים בבניה רבת קומות",
  MikbazeiShimushim_Rashi: "מגורים",
  MikbazeiShimushim_nosafim: "-",
  RahakMinEzorYeud: 2,
  RahakMaxEzorYeud: 5,
  MaxRahakIncAdd: 5,
  k_gova: 20,
  MaxGovaInc: 20,
  Instructions: null,
};

test("one column per zone type, most frequent first, values not field names", () => {
  const cols = buildZoneColumns([tall, urban, { ...urban }]);
  assert.deepEqual(cols.map((c) => c.zone), ["אזור מגורים בבניה עירונית", "אזור מגורים בבניה רבת קומות"]);
  assert.equal(cols[0].cells.primary, "מגורים");
  assert.equal(cols[0].cells.far, "2-4");
  assert.equal(cols[0].cells.height, "עד 20 קומות");
  assert.equal(cols[0].cells.special, "102 - אזור מגורים בבניה עירונית");
});

test("empty values become a dash", () => {
  const [col] = buildZoneColumns([tall]);
  assert.equal(col.cells.extra, "-");
  assert.equal(col.cells.special, "-");
});

test("same zone type over several features lists each distinct value once", () => {
  const [col] = buildZoneColumns([urban, { ...urban, Instructions: "105 - אחר", RahakMaxEzorYeud: 5, MaxRahakIncAdd: 5 }, urban]);
  assert.equal(col.cells.special, "102 - אזור מגורים בבניה עירונית\n105 - אחר");
  assert.equal(col.cells.far, "2-5");
});

test("FAR addition and a zone without base FAR", () => {
  const [col] = buildZoneColumns([{ EzorYeud: "אזור מעורב", RahakMinEzorYeud: 0, RahakMaxEzorYeud: 0, MaxRahakIncAdd: 7, MaxGovaInc: 40, k_gova: 30 }]);
  assert.equal(col.cells.far, 'עד 7 כולל תוספת רח"ק');
  assert.equal(col.cells.height, "עד 40 קומות");
});

test("features without a zone name are skipped", () => {
  assert.deepEqual(buildZoneColumns([{ EzorYeud: " " }, {}]), []);
});

import { mergeCells, ragCells } from "./zoneTable.ts";

test("RAG value beats the layer; the layer fills rows the RAG left empty", () => {
  const [col] = buildZoneColumns([urban]);
  const rag = ragCells({ found: true, primaryUse: "מגורים ומסחר", extraUses: "-", far: "-", height: "עד 25 קומות", directives: "-" });
  const { cells, fromLayer } = mergeCells(col.cells, rag);
  assert.equal(cells.primary, "מגורים ומסחר");
  assert.equal(cells.height, "עד 25 קומות");
  assert.equal(cells.far, "2-4");
  assert.equal(cells.extra, "(א) מסחר 1");
  assert.deepEqual(fromLayer, ["extra", "far", "special"]);
});

test("zone not found in the RAG → everything from the layer", () => {
  const [col] = buildZoneColumns([urban]);
  assert.deepEqual(mergeCells(col.cells, ragCells({ found: false, primaryUse: "x", extraUses: "x", far: "x", height: "x", directives: "x" })).cells, col.cells);
});
