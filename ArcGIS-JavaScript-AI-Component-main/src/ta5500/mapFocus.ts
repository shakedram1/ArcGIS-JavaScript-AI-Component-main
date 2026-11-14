// TA5500 map focus operations: place geometry, geocoding in Tel Aviv, filters/effects, outline, reset.
// Browser-only (ArcGIS runtime). Spec §5.3 step 4 and §5.4.
import type MapView from "@arcgis/core/views/MapView.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type Layer from "@arcgis/core/layers/Layer.js";
import type Geometry from "@arcgis/core/geometry/Geometry.js";
import type { GeometryUnion } from "@arcgis/core/geometry/types.js";
import Extent from "@arcgis/core/geometry/Extent.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import FeatureFilter from "@arcgis/core/layers/support/FeatureFilter.js";
import FeatureEffect from "@arcgis/core/layers/support/FeatureEffect.js";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol.js";
import * as unionOperator from "@arcgis/core/geometry/operators/unionOperator.js";
import * as projectOperator from "@arcgis/core/geometry/operators/projectOperator.js";
import * as locator from "@arcgis/core/rest/locator.js";
import { TA5500_LAYERS, findTa5500Layers, type LayerKey } from "./layers";
import { buildCodeWhere, focusLabel, focusStore, type FocusCase, type FocusState, type Place } from "./focus";
import { isInsideExtent } from "./planLogic";

const WORLD_GEOCODER_URL = "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer";
const OUTLINE_LAYER_ID = "ta5500-focus-outline";
const DIM_EFFECT = "grayscale(100%) opacity(35%)";
const PLACE_LAYER: Record<Place["kind"], LayerKey> = { area: "areas", subarea: "spaces", street: "streets", geocoded: "areas" };

/** Thrown by applyFocus when a newer applyFocus/resetFocus started before it could apply. */
export class FocusSupersededError extends Error {
  constructor() {
    super("ta5500 focus superseded by a newer call");
    this.name = "FocusSupersededError";
  }
}

let callToken = 0;
// Each TA5500 layer's web-map-authored featureEffect (a clone, by uid), recorded the first time the layer is
// seen — when TA5500 mode starts (rememberAuthoredEffects from useTa5500Mode), else before the first restore —
// and never overwritten. Reset restores it, so effects set later (a plan focus, the data-exploration agent)
// are cleared while the author's own effect survives (spec §5.4).
const originalEffects = new Map<string, FeatureEffect | null>();
// Start loading the projection engine early so telAvivExtent (sync) can project.
void projectOperator.load().catch(() => undefined);

export function getView(): MapView | null {
  const view = (document.querySelector("#main-map") as { view?: MapView } | null)?.view;
  return view?.map ? view : null;
}

function featureLayers(view: MapView): FeatureLayer[] {
  return (view.map?.allLayers.toArray() ?? []).filter((l: Layer) => l.type === "feature") as FeatureLayer[];
}

export function listTa5500Layers(view: MapView): Map<LayerKey, FeatureLayer[]> {
  const layers = featureLayers(view);
  const found = findTa5500Layers(layers.map((l) => ({ uid: l.uid, url: l.url, layerId: l.layerId, type: l.type })));
  const out = new Map<LayerKey, FeatureLayer[]>();
  for (const [key, likes] of found) {
    out.set(key, likes.map((like) => layers.find((l) => l.uid === like.uid)!).filter(Boolean));
  }
  return out;
}

export function codeFieldOf(layer: FeatureLayer): { name: string; type: "string" | "number" } | null {
  const key = [...listKeyOf(layer)][0];
  if (!key) return null;
  for (const name of TA5500_LAYERS[key].codeFields) {
    const field = layer.fields?.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (field) return { name: field.name, type: field.type === "string" ? "string" : "number" };
  }
  return null;
}

function listKeyOf(layer: FeatureLayer): LayerKey[] {
  return [...findTa5500Layers([{ uid: layer.uid, url: layer.url, layerId: layer.layerId, type: layer.type }]).keys()];
}

function whereFor(layer: FeatureLayer, codes: string[]): string | null {
  const field = codeFieldOf(layer);
  if (!field) return codes.length === 0 ? "1=1" : null;
  return buildCodeWhere(field.name, field.type, codes);
}

async function toViewSR<T extends GeometryUnion>(view: MapView, geom: T): Promise<T | null> {
  if (!geom.spatialReference || geom.spatialReference.equals(view.spatialReference)) return geom;
  if (!projectOperator.isLoaded()) await projectOperator.load();
  return (projectOperator.execute(geom, view.spatialReference) as T | null | undefined) ?? null;
}

async function unionPolygons(polys: Polygon[]): Promise<Polygon | null> {
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];
  const out = unionOperator.executeMany(polys);
  return out && out.type === "polygon" ? (out as Polygon) : null;
}

export async function resolvePlaceGeometry(view: MapView, place: Place): Promise<Polygon | null> {
  const layer = listTa5500Layers(view).get(PLACE_LAYER[place.kind])?.[0];
  if (!layer || place.codes.length === 0) return null;
  const where = whereFor(layer, place.codes);
  if (!where) return null;
  const res = await layer.queryFeatures({ where, returnGeometry: true, outSpatialReference: view.spatialReference });
  const polys = res.features.map((f) => f.geometry).filter((g): g is Polygon => g?.type === "polygon");
  return unionPolygons(polys);
}

export function telAvivExtent(view: MapView): Extent | null {
  let out: Extent | null = null;
  for (const layer of listTa5500Layers(view).get("areas") ?? []) {
    let ext = layer.fullExtent;
    if (!ext) continue;
    if (ext.spatialReference && !ext.spatialReference.equals(view.spatialReference)) {
      if (!projectOperator.isLoaded()) continue;
      ext = (projectOperator.execute(ext, view.spatialReference) as Extent | null | undefined) ?? null;
      if (!ext) continue;
    }
    out = out ? out.union(ext) : ext.clone();
  }
  return out;
}

export async function geocodeInTelAviv(
  view: MapView,
  text: string,
): Promise<{ place: Place; geometry: Polygon | Extent } | { outside: true } | null> {
  const q = text.trim();
  if (!q) return null;
  if (!projectOperator.isLoaded()) await projectOperator.load();
  const ta = telAvivExtent(view);
  if (!ta) return null;
  const geocode = async (constrained: boolean) =>
    locator.addressToLocations(WORLD_GEOCODER_URL, {
      address: { SingleLine: q },
      maxLocations: constrained ? 1 : 3,
      ...(constrained ? { countryCode: "ISR", searchExtent: ta } : {}),
      outSpatialReference: view.spatialReference,
      outFields: ["Match_addr", "Addr_type"],
    });
  // searchExtent is a hard filter: when it yields nothing, geocode again with no extent and no
  // country, so "outside Tel Aviv" (foreign or elsewhere in Israel -> { outside: true }) differs from
  // "unknown place" (null). The Tel Aviv-constrained call is always tried first; a name that also
  // exists elsewhere is resolved by the geocoder's ranking only when Tel Aviv has no match.
  let candidates = await geocode(true);
  if (!candidates?.length) candidates = await geocode(false);
  const c = candidates?.[0];
  if (!c?.location) return null;
  const loc = await toViewSR(view, c.location);
  if (!loc || !isInsideExtent(loc, ta)) return { outside: true };
  const areas = listTa5500Layers(view).get("areas")?.[0];
  const field = areas ? codeFieldOf(areas) : null;
  if (!areas || !field) return null;
  // The bounding box of the planning areas also covers neighbours (Ramat Gan, Givatayim, north Holon / Bat Yam):
  // the geocoded point itself must fall in a planning-area polygon. Applies to both geocode paths above.
  const inside = await areas.queryFeatureCount({ geometry: loc, spatialRelationship: "intersects" });
  if (inside === 0) return { outside: true };
  // Candidate extent (or ~250 m around the point when the geocoder gives none); only used to collect area codes.
  const raw = c.extent ? await toViewSR(view, c.extent) : null;
  const geometry =
    raw ??
    new Extent({ xmin: loc.x - 250, ymin: loc.y - 250, xmax: loc.x + 250, ymax: loc.y + 250, spatialReference: view.spatialReference });
  const res = await areas.queryFeatures({ geometry, spatialRelationship: "intersects", outFields: [field.name], returnGeometry: false });
  const codes = [...new Set(res.features.map((f) => f.attributes?.[field.name]).filter((v) => v != null).map(String))];
  if (codes.length === 0) return { outside: true };
  return { place: { kind: "geocoded", codes, label: q }, geometry };
}

export async function keepLayersWithFeatures(
  view: MapView,
  layers: Map<LayerKey, string[]>,
  geometry: Geometry | null,
): Promise<{ kept: Map<LayerKey, string[]>; skipped: LayerKey[] }> {
  const all = listTa5500Layers(view);
  const kept = new Map<LayerKey, string[]>();
  const skipped: LayerKey[] = [];
  await Promise.all(
    [...layers].map(async ([key, codes]) => {
      const layer = all.get(key)?.[0];
      const where = layer ? whereFor(layer, codes) : null;
      if (!layer || !where) return void skipped.push(key);
      try {
        const n = await layer.queryFeatureCount({
          where,
          ...(geometry ? { geometry: geometry as GeometryUnion, spatialRelationship: "intersects" as const } : {}),
        });
        if (n > 0) kept.set(key, codes);
        else skipped.push(key);
      } catch {
        skipped.push(key);
      }
    }),
  );
  // Keep the caller's key order.
  const ordered = new Map([...layers.keys()].filter((k) => kept.has(k)).map((k) => [k, kept.get(k)!] as const));
  return { kept: ordered, skipped: [...layers.keys()].filter((k) => skipped.includes(k)) };
}

/** Record the authored featureEffect of TA5500 layers not seen before. Call before anything changes their effects. */
export function rememberAuthoredEffects(view: MapView): void {
  for (const layer of [...listTa5500Layers(view).values()].flat()) {
    if (!originalEffects.has(layer.uid)) originalEffects.set(layer.uid, layer.featureEffect?.clone() ?? null);
  }
}

/** Synchronously undo whatever a focus (or another agent's filter/effect) did to the map. */
function restoreMap(view: MapView, prev: FocusState | null): void {
  rememberAuthoredEffects(view);
  const all = view.map?.allLayers;
  for (const [uid, visible] of Object.entries(prev?.previousVisibility ?? {})) {
    const layer = all?.find((l) => l.uid === uid);
    if (layer) layer.visible = visible;
  }
  for (const layer of [...listTa5500Layers(view).values()].flat()) {
    const lv = view.allLayerViews.find((v) => v.layer === layer) as { filter?: FeatureFilter | null } | undefined;
    if (lv && "filter" in lv) lv.filter = null;
    layer.featureEffect = originalEffects.get(layer.uid)?.clone() ?? null;
  }
  const outline = view.map?.findLayerById(OUTLINE_LAYER_ID);
  if (outline) view.map?.remove(outline);
}

export async function resetFocus(view: MapView): Promise<void> {
  callToken++;
  restoreMap(view, focusStore.clear());
}

export async function applyFocus(
  view: MapView,
  plan: { case: FocusCase; layers: Map<LayerKey, string[]> },
  place: Place | null,
  geometry: Geometry | null,
): Promise<FocusState> {
  const empty: FocusState = { place: null, geometryJson: null, layers: [], previousVisibility: {}, label: focusLabel(null, []) };
  if (plan.case === "none") return focusStore.get() ?? empty; // spec §5.3 4.4: map unchanged
  const token = ++callToken;
  const usePlace = plan.case !== "topic_only";
  const geom = usePlace && geometry ? await toViewSR(view, geometry as GeometryUnion) : null;
  // A place focus is always clipped to the place geometry: without it (not resolved / not projected) nothing is
  // applied, rather than filtering by codes alone. Callers check first and report the map update as failed.
  if (usePlace && !geom) throw new Error("ta5500 focus: no place geometry");

  // Async preparation: layer views, where clauses, target extent. Nothing on the map changes here.
  const all = listTa5500Layers(view);
  const targets: { key: LayerKey; layer: FeatureLayer; where: string; lv: { filter?: FeatureFilter | null } }[] = [];
  for (const [key, codes] of plan.layers) {
    for (const layer of all.get(key) ?? []) {
      const where = whereFor(layer, codes);
      if (!where) continue;
      const lv = (await view.whenLayerView(layer)) as unknown as { filter?: FeatureFilter | null };
      targets.push({ key, layer, where, lv });
    }
  }
  let goToTarget: Extent | null = geom?.extent?.clone().expand(1.2) ?? null;
  if (plan.case === "topic_only") {
    for (const [key] of plan.layers) {
      const first = targets.find((t) => t.key === key);
      if (!first) continue;
      const res = await first.layer
        .queryExtent({ where: first.where, outSpatialReference: view.spatialReference })
        .catch(() => null);
      if (res?.extent && res.count > 0) goToTarget = goToTarget ? goToTarget.union(res.extent) : res.extent.clone();
    }
    goToTarget = goToTarget?.expand(1.2) ?? null;
  }
  if (token !== callToken) throw new FocusSupersededError();

  // Synchronous apply: clear the previous focus, then set the new one.
  restoreMap(view, focusStore.get());
  const previousVisibility: Record<string, boolean> = {};
  const keptUids = new Set(targets.map((t) => t.layer.uid));
  for (const layer of featureLayers(view)) {
    const want = keptUids.has(layer.uid);
    if (layer.visible !== want && (want || layer.visible)) {
      previousVisibility[layer.uid] = layer.visible;
      layer.visible = want;
    }
  }
  for (const t of targets) {
    if (usePlace) {
      t.lv.filter = new FeatureFilter({ where: t.where, ...(geom ? { geometry: geom, spatialRelationship: "intersects" } : {}) });
    } else {
      t.layer.featureEffect = new FeatureEffect({ filter: new FeatureFilter({ where: t.where }), excludedEffect: DIM_EFFECT });
    }
  }
  if (geom && (geom.type === "polygon" || geom.type === "extent")) {
    const outline = new GraphicsLayer({ id: OUTLINE_LAYER_ID, listMode: "hide", title: "TA5500 focus" });
    const symbol = new SimpleFillSymbol({ color: [0, 0, 0, 0], outline: { color: [230, 0, 120, 1], width: 2.5 } });
    outline.add(new Graphic({ geometry: geom, symbol }));
    view.map?.add(outline);
  }

  const seen = new Set<LayerKey>();
  const layers = targets.filter((t) => !seen.has(t.key) && seen.add(t.key)).map((t) => ({ layerKey: t.key, where: t.where }));
  const state: FocusState = {
    place,
    geometryJson: geom ? geom.toJSON() : null,
    layers,
    previousVisibility,
    label: focusLabel(place, layers.map((l) => TA5500_LAYERS[l.layerKey].label)),
  };
  focusStore.set(state);
  if (goToTarget) await view.goTo(goToTarget).catch(() => undefined);
  return state;
}

/**
 * Map agent "hide": sets visible = false on every map instance of the given TA5500 layers. The previous
 * visibility is recorded in the focus store's previousVisibility (merged into the current focus, the first
 * recorded value per layer wins; or in a new place-less focus), so resetFocus restores it and a new
 * applyFocus first restores it before applying. Supersedes an applyFocus still in flight.
 * Returns the keys that have at least one instance on the map (none: the map and the store are unchanged).
 */
export function hideLayers(view: MapView, keys: LayerKey[]): { hidden: LayerKey[]; state: FocusState | null } {
  callToken++;
  const all = listTa5500Layers(view);
  const prev = focusStore.get();
  const previousVisibility: Record<string, boolean> = { ...(prev?.previousVisibility ?? {}) };
  const hidden: LayerKey[] = [];
  for (const key of keys) {
    const instances = all.get(key) ?? [];
    if (instances.length) hidden.push(key);
    for (const layer of instances) {
      if (!layer.visible) continue;
      if (!(layer.uid in previousVisibility)) previousVisibility[layer.uid] = true;
      layer.visible = false;
    }
  }
  if (!hidden.length) return { hidden, state: prev };
  const state: FocusState = prev
    ? { ...prev, previousVisibility }
    : { place: null, geometryJson: null, layers: [], previousVisibility, label: `הוסתרו: ${hidden.map((k) => TA5500_LAYERS[k].label).join(", ")}` };
  focusStore.set(state);
  return { hidden, state };
}
