import test from "node:test";
import assert from "node:assert/strict";
import { findTa5500Layers, matchLayerTopics, matchTa5500LayerUrl, matchTopicOverrides, TA5500_LAYERS, TOPIC_OVERRIDES } from "../layers";

const BASE = "https://services3.arcgis.com/abc/arcgis/rest/services/TA5500_%D7%A4%D7%95%D7%9C%D7%999%D7%92%D7%95%D7%A0%D7%99%D7%9D1/FeatureServer";

test("matches TA5500 layer URL", () => {
  assert.deepEqual(matchTa5500LayerUrl(`${BASE}/122`), { layerKey: "areas", layerId: 122 });
  assert.equal(matchTa5500LayerUrl(`${BASE}/999`), null);
  assert.equal(matchTa5500LayerUrl("https://services3.arcgis.com/abc/arcgis/rest/services/Other/FeatureServer/122"), null);
  assert.deepEqual(matchTa5500LayerUrl("https://x/arcgis/rest/services/TA5500_a/MapServer/128/"), { layerKey: "zones", layerId: 128 });
  assert.equal(matchTa5500LayerUrl(""), null);
});

test("finds layers by key, using layerId when url has no trailing id", () => {
  const m = findTa5500Layers([
    { uid: "a", url: `${BASE}/128`, type: "feature" },
    { uid: "b", url: BASE, layerId: 128, type: "feature" },
    { uid: "c", url: `${BASE}/124`, type: "feature" },
    { uid: "d", url: null, type: "graphics" },
  ]);
  assert.equal(m.get("zones")?.length, 2);
  assert.equal(m.get("foci")?.length, 1);
  assert.equal(m.has("areas"), false);
});

test("topic overrides", () => {
  assert.deepEqual(matchTopicOverrides("מה תוכנית הפיתוח העסקי באזור 610?"), { zone_types: ["3.3", "3.4.1"] });
  assert.deepEqual(matchTopicOverrides("מה מותר לבנות באזור 610?"), {});
  assert.deepEqual(matchTopicOverrides("ובמסחר"), { zone_types: ["3.3", "3.4.1"] });
  assert.deepEqual(matchTopicOverrides(""), {});
  assert.deepEqual(matchTopicOverrides("אנשי מסחרים"), {});
  assert.deepEqual(matchTopicOverrides("תעסוקה ומסחר"), { zone_types: ["3.3", "3.4.1"] });
});

test("topic overrides do not leak config arrays", () => {
  const r = matchTopicOverrides("מסחר");
  r.zone_types!.push("x");
  assert.deepEqual(TOPIC_OVERRIDES[0].filters.zone_types, ["3.3", "3.4.1"]);
  assert.equal(TA5500_LAYERS.areas.layerId, 122);
});

test("layer topics by name", () => {
  assert.deepEqual(matchLayerTopics("תסתיר את שכבת המוקדים"), ["foci"]);
  assert.deepEqual(matchLayerTopics("אזורי ייעוד"), ["zones"]);
  assert.deepEqual(matchLayerTopics("מרחבי תכנון"), ["spaces"]);
  assert.deepEqual(matchLayerTopics("הוראות רחוב מיוחדות"), ["streets"]);
  assert.deepEqual(matchLayerTopics("והתעסוקה"), ["employment"]);
  assert.deepEqual(matchLayerTopics("מגורים"), []);
  assert.deepEqual(matchLayerTopics(""), []);
});
