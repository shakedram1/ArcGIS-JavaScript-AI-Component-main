import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import SketchViewModel from "@arcgis/core/widgets/Sketch/SketchViewModel";
import FeatureFilter from "@arcgis/core/layers/support/FeatureFilter";
import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as unionOperator from "@arcgis/core/geometry/operators/unionOperator.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import Extent from "@arcgis/core/geometry/Extent";
import type Polygon from "@arcgis/core/geometry/Polygon";
import {
  CARD_ASPECT,
  PAGE_H,
  PAGE_W,
  composeCardsPage,
  composeMapPage,
  composeTablePage,
  downloadBytes,
  jpegsToPdf,
  type MapCard,
  type TableColumn,
  type TableRow,
} from "./groupPdf";
import { ZONE_NAME_FIELD, ZONE_ROWS, buildZoneColumns, mergeCells, ragCells, type ZoneAttrs } from "./zoneTable";
import { fetchZoneInfo, type ZonePlanResult } from "./planInfo";

/** Buffer distance (meters) applied around the drawn polygon / plan boundary. */
export const QUERY_BUFFER_METERS = 100;

export interface LayerGroupSpec {
  key: string;
  label: string;
  /** Matches the GroupLayer title in the WebMap (Hebrew titles from the planning sketch). */
  match: RegExp;
}

/** The 5 layer groups from the planning-info sketch (דף מידע מתארי). */
export const LAYER_GROUPS: LayerGroupSpec[] = [
  { key: "zoning", label: "אזורי ייעוד", match: /ייעוד/ },
  { key: "urban-design", label: "עיצוב עירוני", match: /עיצוב\s*עירוני/ },
  { key: "planning-areas", label: "אזורי ומרחבי תכנון", match: /מרחבי\s*תכנון|אזורי\s*תכנון/ },
  { key: "transport", label: "תחבורה וניידות", match: /תחבורה|ניידות/ },
  { key: "infrastructure", label: "תשתיות", match: /תשתיות|תשתית/ },
];

/** The 4 groups shown as map cards on page 2 of the PDF, in sketch order. */
const CARD_GROUP_KEYS = ["urban-design", "planning-areas", "transport", "infrastructure"];

/** How much of the image width/height the area of interest (its bounding box) should fill in the PDF maps. */
const FILL_FRACTION = 0.75;

const ZONE_COLORS = ["#ffa500", "#ff5a00", "#b266ff", "#5cb85c"];

/** Zone types shown as table columns (the most frequent in the area); more would not fit the page width. */
const MAX_ZONE_COLUMNS = 6;

export type AnalysisMode = "manual" | "boundary";

export interface LayerHit {
  id: string;
  title: string;
  /** Features intersecting polygon + buffer. */
  count: number;
  /** Features intersecting the polygon itself (count − countInPolygon = only in the buffer ring). */
  countInPolygon: number;
  geometryType: string;
  visible: boolean;
}

export interface GroupResult {
  key: string;
  label: string;
  /** False when no group layer with a matching title exists in the map. */
  found: boolean;
  layers: LayerHit[];
}

export interface PolygonQueryResult {
  groups: GroupResult[];
  mode: AnalysisMode;
}

export interface BoundaryLayerOption {
  key: string;
  title: string;
}

type AnyLayer = any;

// ── Layer-tree helpers ───────────────────────────────────────────────────────

function toArray(collection: any): AnyLayer[] {
  return collection?.toArray?.() ?? (Array.isArray(collection) ? collection : []);
}

function childrenOf(layer: AnyLayer): AnyLayer[] {
  // GroupLayer.layers, MapImageLayer.sublayers, Sublayer.sublayers
  return toArray(layer?.layers ?? layer?.sublayers);
}

function isQueryable(layer: AnyLayer): boolean {
  return typeof layer?.queryFeatureCount === "function";
}

function findGroupLayer(roots: AnyLayer[], spec: LayerGroupSpec): AnyLayer | null {
  for (const layer of roots) {
    if (layer?.type === "group" && spec.match.test(String(layer.title ?? ""))) return layer;
    if (layer?.type === "group") {
      const nested = findGroupLayer(childrenOf(layer), spec);
      if (nested) return nested;
    }
  }
  return null;
}

/** Every queryable leaf below a group (feature layers and map-service sublayers). */
function collectLeaves(group: AnyLayer, parents: AnyLayer[] = []): { leaf: AnyLayer; parents: AnyLayer[] }[] {
  const out: { leaf: AnyLayer; parents: AnyLayer[] }[] = [];
  for (const child of childrenOf(group)) {
    const kids = childrenOf(child);
    if (kids.length > 0) {
      out.push(...collectLeaves(child, [...parents, group]));
    } else if (isQueryable(child)) {
      out.push({ leaf: child, parents: [...parents, group] });
    }
  }
  return out;
}

function pickNameField(featureSet: any): string | null {
  const fields = (featureSet?.fields ?? []).filter(
    (f: any) => f.type === "string" && !/^(globalid|guid)$/i.test(String(f.name)),
  );
  if (featureSet?.displayFieldName && fields.some((f: any) => f.name === featureSet.displayFieldName)) {
    return featureSet.displayFieldName;
  }
  const preferred = fields.find((f: any) =>
    /יעוד|ייעוד|zone|landuse|name|שם|desc|תיאור|type|סוג/i.test(`${f.name} ${f.alias ?? ""}`),
  );
  return (preferred ?? fields[0])?.name ?? null;
}

export interface ZoneStyle {
  color: string;
  hatch: boolean;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const isDark = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < 40;

/** Colours ([r,g,b,a]) found in a symbol's JSON (esri or CIM), outlines skipped, in drawing order. */
function collectColors(node: any, out: number[][], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectColors(n, out, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (/outline/i.test(k)) continue;
    if (k === "color" && Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number")) {
      if (v.length < 4 || (v[3] as number) > 0) out.push(v as number[]);
    } else collectColors(v, out, depth + 1);
  }
}

/** Fill colour and hatching of a symbol: hatch fills keep the colour of their lines. */
function symbolStyle(symbol: any): ZoneStyle | null {
  if (!symbol) return null;
  let json: any = null;
  try {
    json = symbol.toJSON?.() ?? null;
  } catch {
    /* ignore */
  }
  const text = json ? JSON.stringify(json) : "";
  const hatch = /CIMHatchFill/.test(text) || (symbol.type === "simple-fill" && !/^(solid|none)$/.test(String(symbol.style ?? "solid")));
  const colors: number[][] = [];
  const direct = symbol.color?.toRgba?.();
  if (direct && direct[3] > 0) colors.push(direct);
  if (json) collectColors(json, colors);
  const pick = colors.find((c) => !isDark(c)) ?? colors[0];
  return pick ? { color: `#${hex2(pick[0])}${hex2(pick[1])}${hex2(pick[2])}`, hatch } : null;
}

// ── Controller ───────────────────────────────────────────────────────────────

/**
 * Owns the sketch tool and the highlight graphics for one map view.
 * Flow: draw a polygon (or take the plan-boundary layer) → 100 m geodesic buffer → for each of the
 * 5 groups, query every sublayer against the buffer, show the layers that have features and clip
 * their rendering to the buffer → export the planning-info sheet (PDF).
 */
export class PolygonGroupQueryController {
  private view: any;
  private sketchLayer: GraphicsLayer;
  private sketchVM: SketchViewModel;
  private filteredLayerViews: any[] = [];
  private touchedVisibility = new Map<AnyLayer, boolean>();
  private runId = 0;
  /** Sublayer ids are only unique per service, so results reference leaves by a generated key. */
  private leafByKey = new Map<string, AnyLayer>();
  private groupLayerByKey = new Map<string, AnyLayer>();
  private visibilityHandles: { remove: () => void }[] = [];
  private boundaryLayerByKey = new Map<string, AnyLayer>();
  private analysis: { polygon: Polygon; buffer: Polygon; mode: AnalysisMode; result: PolygonQueryResult } | null = null;
  /** In view.graphics: they render above every layer, including ones added later. */
  private resultGraphics: Graphic[] = [];

  constructor(
    view: any,
    private readonly onResult: (result: PolygonQueryResult) => void,
    private readonly onBusy: (busy: boolean) => void,
    private readonly onError: (message: string) => void,
    private readonly onDrawing: (drawing: boolean) => void,
    private readonly onVisibility: (key: string, visible: boolean) => void,
    private readonly onPolygonChange: (exists: boolean) => void,
  ) {
    this.view = view;
    this.sketchLayer = new GraphicsLayer({ id: "polygon-query-sketch", listMode: "hide" });
    view.map.add(this.sketchLayer);

    this.sketchVM = new SketchViewModel({
      view,
      layer: this.sketchLayer,
      polygonSymbol: PLAN_SYMBOL as any,
    });

    this.sketchVM.on("create", (event: any) => {
      if (event.state === "cancel") {
        this.onDrawing(false);
      } else if (event.state === "complete") {
        this.onPolygonChange(true);
        this.onDrawing(false);
        void this.analyze(event.graphic.geometry as Polygon, "manual");
      }
    });
  }

  hasAnalysis(): boolean {
    return this.analysis !== null;
  }

  /** The polygon of the current analysis, before buffering. */
  getPolygon(): Polygon | null {
    return this.analysis?.polygon ?? null;
  }

  startDrawing(): void {
    this.clear();
    this.onDrawing(true);
    this.sketchVM.create("polygon");
  }

  cancelDrawing(): void {
    this.sketchVM.cancel();
    this.onDrawing(false);
  }

  /** Remove graphics, filters, and restore layer visibility to what it was before. */
  clear(): void {
    this.runId++;
    this.onPolygonChange(false);
    this.visibilityHandles.forEach((handle) => handle.remove());
    this.visibilityHandles = [];
    this.sketchVM.cancel();
    this.sketchLayer.removeAll();
    this.view.graphics.removeMany(this.resultGraphics);
    this.resultGraphics = [];
    for (const lv of this.filteredLayerViews) {
      try {
        lv.filter = null;
      } catch {
        /* layer view may be gone */
      }
    }
    this.filteredLayerViews = [];
    for (const [layer, visible] of this.touchedVisibility) {
      try {
        layer.visible = visible;
      } catch {
        /* ignore */
      }
    }
    this.touchedVisibility.clear();
    this.leafByKey.clear();
    this.groupLayerByKey.clear();
    this.analysis = null;
  }

  destroy(): void {
    this.clear();
    this.sketchVM.destroy();
    try {
      this.view?.map?.remove(this.sketchLayer);
    } catch {
      /* map may already be gone */
    }
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    const layer = this.leafByKey.get(layerId);
    if (!layer) return;
    this.setVisible(layer, visible);
  }

  setGroupVisible(groupKey: string, visible: boolean): void {
    const group = this.groupLayerByKey.get(groupKey);
    if (group) this.setVisible(group, visible);
  }

  getVisibility(): Record<string, boolean> {
    return Object.fromEntries(
      [...this.groupLayerByKey, ...this.leafByKey].map(([key, layer]) => [key, !!layer.visible]),
    );
  }

  /** Present the queried layers in the same order as the map's layer list. */
  getDisplayResult(result: PolygonQueryResult): PolygonQueryResult {
    const order = new Map<AnyLayer, number>();
    const walk = (layers: AnyLayer[]) => {
      for (const layer of [...layers].reverse()) {
        order.set(layer, order.size);
        walk(childrenOf(layer));
      }
    };
    walk(toArray(this.view.map.layers));
    const indexOf = (layer: AnyLayer) => order.get(layer) ?? Infinity;
    const groups = result.groups.map((group) => {
      const layer = this.groupLayerByKey.get(group.key);
      return {
        ...group,
        label: layer?.title ?? group.label,
        layers: [...group.layers].sort((a, b) => indexOf(this.leafByKey.get(a.id)) - indexOf(this.leafByKey.get(b.id))),
      };
    });
    groups.sort((a, b) => indexOf(this.groupLayerByKey.get(a.key)) - indexOf(this.groupLayerByKey.get(b.key)));
    return { ...result, groups };
  }

  private setVisible(layer: AnyLayer, visible: boolean): void {
    if (!this.touchedVisibility.has(layer)) this.touchedVisibility.set(layer, !!layer.visible);
    layer.visible = visible;
  }

  // ── Plan boundary mode ─────────────────────────────────────────────────────

  /** Polygon feature layers in the map, those that look like a plan boundary first. */
  listPolygonLayers(): BoundaryLayerOption[] {
    this.boundaryLayerByKey.clear();
    const found: { key: string; title: string; likely: boolean }[] = [];
    const walk = (layers: AnyLayer[], path: string) => {
      layers.forEach((layer, i) => {
        if (layer === this.sketchLayer) return;
        const key = `${path}/${i}`;
        const kids = childrenOf(layer);
        if (kids.length > 0) return walk(kids, key);
        if (isQueryable(layer) && layer.geometryType === "polygon") {
          const title = String(layer.title ?? layer.id);
          this.boundaryLayerByKey.set(key, layer);
          found.push({ key, title, likely: /גבול|גבולות|תכנית|תוכנית|boundary/i.test(title) });
        }
      });
    };
    walk(toArray(this.view.map.layers), "L");
    found.sort((a, b) => Number(b.likely) - Number(a.likely));
    return found.map(({ key, title }) => ({ key, title }));
  }

  /** Use all features of the chosen layer (unioned) as the area of interest. */
  async analyzeBoundary(layerKey: string): Promise<void> {
    const layer = this.boundaryLayerByKey.get(layerKey);
    if (!layer) {
      this.onError("שכבת גבול התכנית לא נמצאה");
      return;
    }
    this.clear();
    this.onBusy(true);
    try {
      const fs = await layer.queryFeatures({
        where: "1=1",
        returnGeometry: true,
        outSpatialReference: this.view.spatialReference,
      });
      const geoms = fs.features.map((f: any) => f.geometry).filter(Boolean);
      if (geoms.length === 0) throw new Error("בשכבת גבול התכנית שנבחרה אין ישויות");
      const union = geoms.length === 1 ? geoms[0] : (unionOperator.executeMany(geoms) as Polygon | null);
      if (!union) throw new Error("איחוד גבולות התכנית נכשל");
      await this.analyze(union as Polygon, "boundary");
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
      this.onBusy(false);
    }
  }

  // ── Analysis ───────────────────────────────────────────────────────────────

  private async analyze(polygon: Polygon, mode: AnalysisMode): Promise<void> {
    const runId = ++this.runId;
    this.onBusy(true);
    try {
      await geodesicBufferOperator.load();
      const buffer = geodesicBufferOperator.execute(polygon, QUERY_BUFFER_METERS, { unit: "meters" } as any);
      if (!buffer) throw new Error("יצירת הבאפר נכשלה");

      this.sketchLayer.removeAll();
      this.resultGraphics = [
        new Graphic({
          geometry: buffer,
          symbol: {
            type: "simple-fill",
            color: [0, 0, 255, 0.03],
            outline: { color: [0, 0, 255, 0.8], width: 1.5, style: "dash" },
          } as any,
        }),
        new Graphic({ geometry: polygon, symbol: PLAN_SYMBOL as any }),
      ];
      this.view.graphics.addMany(this.resultGraphics);

      const roots = toArray(this.view.map.layers);
      const groups: GroupResult[] = [];

      for (const spec of LAYER_GROUPS) {
        const group = findGroupLayer(roots, spec);
        if (!group) {
          groups.push({ key: spec.key, label: spec.label, found: false, layers: [] });
          continue;
        }
        const leaves = collectLeaves(group);
        const hits = await Promise.all(
          leaves.map(async ({ leaf, parents }) => {
            let count = 0;
            let countInPolygon = 0;
            let geometryType = String(leaf.geometryType ?? "");
            try {
              if (typeof leaf.load === "function") await leaf.load();
              geometryType = String(leaf.geometryType ?? geometryType);
              [count, countInPolygon] = await Promise.all([
                leaf.queryFeatureCount({ geometry: buffer, spatialRelationship: "intersects", returnGeometry: false }),
                leaf.queryFeatureCount({ geometry: polygon, spatialRelationship: "intersects", returnGeometry: false }),
              ]);
              if (!geometryType && count > 0) {
                const one = await leaf.queryFeatures({ geometry: buffer, num: 1, returnGeometry: false });
                geometryType = String(one?.geometryType ?? "");
              }
            } catch {
              count = 0;
              countInPolygon = 0;
            }
            return { leaf, parents, count, countInPolygon, geometryType };
          }),
        );
        if (runId !== this.runId) return; // a newer run / clear superseded this one

        this.groupLayerByKey.set(spec.key, group);
        this.setVisible(group, true);
        const layerHits: LayerHit[] = [];
        for (const [i, { leaf, parents, count, countInPolygon, geometryType }] of hits.entries()) {
          const key = `${spec.key}:${i}`;
          this.leafByKey.set(key, leaf);
          const show = count > 0;
          if (show) parents.forEach((p) => this.setVisible(p, true));
          this.setVisible(leaf, show);
          if (show) void this.clipToBuffer(leaf, buffer);
          layerHits.push({
            id: key,
            title: String(leaf.title ?? leaf.id),
            count,
            countInPolygon,
            geometryType,
            visible: show,
          });
        }
        layerHits.sort((a, b) => b.count - a.count);
        groups.push({ key: spec.key, label: spec.label, found: true, layers: layerHits });
      }

      if (runId !== this.runId) return;
      if (buffer.extent) {
        await this.view.goTo(buffer.extent.clone().expand(1.4), { duration: 600 }).catch(() => undefined);
      }
      const result: PolygonQueryResult = { groups, mode };
      this.analysis = { polygon, buffer, mode, result };
      for (const [key, layer] of [...this.groupLayerByKey, ...this.leafByKey]) {
        this.visibilityHandles.push(reactiveUtils.watch(
          () => !!layer.visible,
          (visible) => this.onVisibility(key, visible),
        ));
      }
      this.onResult(result);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runId === this.runId) this.onBusy(false);
    }
  }

  /** Clip a feature layer's rendering to the buffer (map-service sublayers can't be clipped client-side). */
  private async clipToBuffer(layer: AnyLayer, buffer: Polygon): Promise<void> {
    if (layer?.type !== "feature") return;
    try {
      const lv = await this.view.whenLayerView(layer);
      lv.filter = new FeatureFilter({ geometry: buffer, spatialRelationship: "intersects" });
      this.filteredLayerViews.push(lv);
    } catch {
      /* layer view unavailable (e.g. layer hidden at this scale) — visibility is still applied */
    }
  }

  // ── Planning-info sheet (PDF) ──────────────────────────────────────────────

  /**
   * One PDF, three kinds of page:
   *  1. the zoning group (אזורי ייעוד) as a full map, like sketch page 2;
   *  2. the other four groups as a row of map cards, like sketch page 3;
   *  3. a table with one column per zone type, master-plan (RAG) text first and the zoning-layer attributes as fallback, like sketch page 5.
   * The layer visibility and view the user had are restored afterwards.
   */
  async exportInfoSheet(onProgress?: (message: string) => void): Promise<void> {
    const a = this.analysis;
    if (!a) throw new Error("יש לבחור אזור (פוליגון או גבול תכנית) לפני הייצוא");
    if (!this.groupLayerByKey.get("zoning")) throw new Error("לא נמצאה קבוצת שכבות 'אזורי ייעוד' במפה");
    if (!a.polygon.extent) throw new Error("לא ניתן לחשב את תחום האזור");

    const pageFrame = this.frameFor(PAGE_W / PAGE_H);
    const cardFrame = this.frameFor(CARD_ASPECT);

    const savedVisibility = new Map<AnyLayer, boolean>();
    for (const g of this.groupLayerByKey.values()) savedVisibility.set(g, !!g.visible);
    const savedViewpoint = this.view.viewpoint?.clone?.();

    const showOnly = async (key: string | null, frame: Extent) => {
      for (const [k, layer] of this.groupLayerByKey) layer.visible = k === key;
      await this.view.goTo(frame, { animate: false }).catch(() => undefined);
      await new Promise((r) => window.setTimeout(r, 300));
      await Promise.race([
        reactiveUtils.whenOnce(() => !this.view.updating),
        new Promise((r) => window.setTimeout(r, 15000)),
      ]);
    };
    const shoot = async (): Promise<string> => (await this.view.takeScreenshot({ format: "png" })).dataUrl;

    try {
      onProgress?.("מצלם: אזורי ייעוד");
      await showOnly("zoning", pageFrame);
      const page1 = await composeMapPage({
        title: "אזורי ייעוד",
        screenshotDataUrl: await shoot(),
        scale: Number(this.view.scale) || 0,
      });

      const cards: MapCard[] = [];
      let first = true;
      for (const key of CARD_GROUP_KEYS) {
        const spec = LAYER_GROUPS.find((g) => g.key === key)!;
        if (!this.groupLayerByKey.has(key)) {
          cards.push({ title: spec.label, screenshotDataUrl: null });
          continue;
        }
        onProgress?.(`מצלם: ${spec.label}`);
        await showOnly(key, cardFrame);
        if (first) first = false;
        cards.push({ title: spec.label, screenshotDataUrl: await shoot() });
      }
      const page2 = await composeCardsPage(cards);

      const page3 = await this.buildTablePage(onProgress);

      downloadBytes(jpegsToPdf([page1, page2, page3]), "דף מידע מתארי.pdf");
    } finally {
      for (const [layer, visible] of savedVisibility) layer.visible = visible;
      if (savedViewpoint) await this.view.goTo(savedViewpoint, { animate: false }).catch(() => undefined);
    }
  }

  /**
   * The map extent for a PDF image of the given width/height ratio: centred on the polygon, sized so
   * the polygon's bounding box fills FILL_FRACTION of the limiting dimension. Layers that stick out
   * of the polygon are simply cropped by the frame.
   */
  private frameFor(aspect: number): Extent {
    const e = this.analysis!.polygon.extent!;
    const cx = (e.xmin + e.xmax) / 2;
    const cy = (e.ymin + e.ymax) / 2;
    const w = Math.max(e.width, e.height * aspect, 1e-9) / FILL_FRACTION;
    const h = w / aspect;
    return new Extent({
      xmin: cx - w / 2,
      xmax: cx + w / 2,
      ymin: cy - h / 2,
      ymax: cy + h / 2,
      spatialReference: e.spatialReference,
    });
  }

  /**
   * Zoning features inside the area (attributes of every field) and the colour each zone type is
   * drawn with. Prefers what lies inside the polygon; falls back to the buffer ring.
   */
  private async discoverZones(): Promise<{
    features: ZoneAttrs[];
    nameField: string;
    colors: Map<string, ZoneStyle>;
    geometries: Map<string, any[]>;
  }> {
    const a = this.analysis!;
    const hits = (a.result.groups.find((g) => g.key === "zoning")?.layers ?? []).filter((l) => l.count > 0);

    const queryAll = async (hit: LayerHit, geometry: Polygon) => {
      const leaf = this.leafByKey.get(hit.id);
      if (!leaf) return null;
      const fs = await leaf.queryFeatures({
        geometry,
        spatialRelationship: "intersects",
        outFields: ["*"],
        returnGeometry: true,
        outSpatialReference: this.view.spatialReference,
      });
      return { leaf, fs };
    };

    const loaded: { leaf: AnyLayer; fs: any }[] = [];
    for (const hit of hits) {
      let r = await queryAll(hit, a.polygon);
      if (r && r.fs.features.length === 0) r = await queryAll(hit, a.buffer);
      if (r && r.fs.features.length > 0) loaded.push(r);
    }
    // The zoning layer proper has the zone-type field; other layers in the group would add empty columns.
    const hasName = (r: { fs: any }) => (r.fs.fields ?? []).some((f: any) => f.name === ZONE_NAME_FIELD);
    const used = loaded.some(hasName) ? loaded.filter(hasName) : loaded;

    const features: ZoneAttrs[] = [];
    const colors = new Map<string, ZoneStyle>();
    const geometries = new Map<string, any[]>();
    let nameField = ZONE_NAME_FIELD;
    for (const { leaf, fs } of used) {
      const field = hasName({ fs }) ? ZONE_NAME_FIELD : pickNameField(fs);
      if (!field) continue;
      nameField = field;
      for (const f of fs.features) {
        const attrs = (f.attributes ?? {}) as ZoneAttrs;
        features.push(attrs);
        const name = String(attrs[field] ?? "").trim();
        if (name && f.geometry) geometries.set(name, [...(geometries.get(name) ?? []), f.geometry]);
        // The column takes the colour (and hatching) the zone is drawn with on the map.
        if (name && !colors.has(name)) {
          const style = await this.zoneStyle(leaf, f);
          if (style) colors.set(name, style);
        }
      }
    }
    return { features, nameField, colors, geometries };
  }

  /** Fill colour (hex) and whether it is hatched, as the layer's renderer draws the feature; null when unresolvable. */
  private async zoneStyle(layer: AnyLayer, feature: any): Promise<ZoneStyle | null> {
    const renderer = layer?.renderer;
    const candidates: any[] = [];
    try {
      candidates.push(await renderer?.getSymbolAsync?.(feature));
    } catch {
      /* fall through to the legend lookup below */
    }
    try {
      // Unique-value renderers: match the feature's value against the legend entries.
      const field = renderer?.field;
      if (field && Array.isArray(renderer.uniqueValueInfos ?? null)) {
        const value = String(feature?.attributes?.[field] ?? "");
        candidates.push(renderer.uniqueValueInfos.find((u: any) => String(u.value) === value)?.symbol);
      }
      candidates.push(renderer?.symbol, renderer?.defaultSymbol);
    } catch {
      /* ignore */
    }
    for (const symbol of candidates) {
      const style = symbolStyle(symbol);
      if (style) return style;
    }
    return null;
  }

  /** The part of the drawn polygon that lies in a zone type: union of its features ∩ polygon (the whole zone if that fails). */
  private zonePart(geoms: any[]): Polygon {
    const a = this.analysis!;
    if (geoms.length === 0) return a.polygon;
    try {
      const union = (geoms.length === 1 ? geoms[0] : unionOperator.executeMany(geoms)) as Polygon | null;
      if (!union) return a.polygon;
      const cut = intersectionOperator.execute(union, a.polygon) as Polygon | null;
      return cut && !(cut as any).isEmpty?.call?.(cut) && (cut.rings?.length ?? 0) > 0 ? cut : union;
    } catch {
      return a.polygon;
    }
  }

  /**
   * Attribute VALUES (not layer or field names) of the alert layers selected by `pick`, e.g. the
   * name of each alert polygon / line / point. Distinct, in layer order; "" when nothing is found,
   * so empty cells stay empty in the table.
   */
  private async alertValues(pick: (l: LayerHit) => boolean, geometry: Polygon): Promise<string> {
    const values: string[] = [];
    for (const g of this.analysis!.result.groups) {
      if (g.key === "zoning") continue;
      for (const hit of g.layers) {
        if (!pick(hit)) continue;
        const leaf = this.leafByKey.get(hit.id);
        if (!leaf) continue;
        try {
          const fs = await leaf.queryFeatures({
            geometry,
            spatialRelationship: "intersects",
            outFields: ["*"],
            returnGeometry: false,
            num: 50,
          });
          const field = pickNameField(fs);
          if (!field) continue;
          for (const f of fs.features) {
            const v = String(f.attributes?.[field] ?? "").replace(/\s+/g, " ").trim();
            if (v && !/^[-—–]+$/.test(v) && !values.includes(v)) values.push(v);
          }
        } catch {
          /* a layer that cannot be queried contributes no values */
        }
      }
    }
    return values.slice(0, 8).join("\n");
  }

  /** Planning area (e.g. 901): the most frequent 3-digit code in the string attributes of the planning-areas group. */
  private async discoverAreaCode(): Promise<string | undefined> {
    const a = this.analysis!;
    const hits = (a.result.groups.find((g) => g.key === "planning-areas")?.layers ?? []).filter((l) => l.count > 0);
    const codeCounts = new Map<string, number>();
    for (const hit of hits) {
      const leaf = this.leafByKey.get(hit.id);
      if (!leaf) continue;
      try {
        const fs = await leaf.queryFeatures({
          geometry: a.polygon,
          spatialRelationship: "intersects",
          outFields: ["*"],
          returnGeometry: false,
        });
        const stringFields = (fs.fields ?? []).filter((f: any) => f.type === "string").map((f: any) => f.name);
        for (const f of fs.features) {
          for (const name of stringFields) {
            const m = /(?:^|\s)([1-9]\d{2})(?=\s|$|[א-ת'])/.exec(String(f.attributes?.[name] ?? ""));
            if (m) codeCounts.set(m[1], (codeCounts.get(m[1]) ?? 0) + 1);
          }
        }
      } catch {
        /* a layer that cannot be queried just contributes no code */
      }
    }
    return [...codeCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  }

  private async buildTablePage(onProgress?: (message: string) => void) {
    const a = this.analysis!;
    const { features, nameField, colors, geometries } = await this.discoverZones();
    const zoneColumns = buildZoneColumns(features, nameField);
    const shown = zoneColumns.slice(0, MAX_ZONE_COLUMNS);

    // The master-plan text (RAG) is stronger than the layer attributes: ask it for every zone and use the
    // layer only for the rows it has no answer for.
    onProgress?.("שולף נתוני תוכנית המתאר מה-RAG");
    const areaCode = await this.discoverAreaCode();
    const errors: string[] = [];
    const plan: (ZonePlanResult | null)[] = await Promise.all(
      shown.map((z) =>
        fetchZoneInfo(z.zone, areaCode).catch((err) => {
          errors.push(err instanceof Error ? err.message : String(err));
          return null;
        }),
      ),
    );
    const merged = shown.map((z, i) => mergeCells(z.cells, ragCells(plan[i]?.info)));

    const columns: TableColumn[] = shown.length
      ? shown.map((z, i) => ({
          title: z.zone,
          color: colors.get(z.zone)?.color ?? ZONE_COLORS[i % ZONE_COLORS.length],
          hatch: colors.get(z.zone)?.hatch ?? false,
        }))
      : [{ title: "לא זוהה אזור ייעוד", color: "#cccccc" }];

    // Rows are the attributes of the zoning layer; cells are their values for each zone type.
    const inPoly = (l: LayerHit) => l.countInPolygon > 0;
    // Value priority: RAG → layer attributes → empty (never "-" or a field name).
    const blank = (t: string | undefined) => (!t || /^[\s\-—–]*$/.test(t) ? "" : t);

    // Alerts are cut by the zone: each column only gets the values of alert features inside that
    // zone's part of the polygon (adjacent ones: within 100 m of that part).
    onProgress?.("שולף ערכי התראות מהשכבות לכל אזור ייעוד");
    await geodesicBufferOperator.load();
    const perZone = await Promise.all(
      (shown.length ? shown : [null]).map(async (z) => {
        const part = z ? this.zonePart(geometries.get(z.zone) ?? []) : a.polygon;
        const near = geodesicBufferOperator.execute(part, QUERY_BUFFER_METERS, { unit: "meters" } as any) as Polygon | null;
        const [spatial, linear, pointy, adjacent] = await Promise.all([
          this.alertValues((l) => inPoly(l) && l.geometryType === "polygon", part),
          this.alertValues((l) => inPoly(l) && l.geometryType === "polyline", part),
          this.alertValues((l) => inPoly(l) && l.geometryType === "point", part),
          this.alertValues((l) => l.count > 0 && l.countInPolygon === 0, near ?? a.buffer),
        ]);
        return { spatial, linear, pointy, adjacent };
      }),
    );
    const rows: TableRow[] = [
      ...ZONE_ROWS.map((r) => ({
        label: r.label,
        cells: shown.length ? merged.map((m) => blank(m.cells[r.key])) : [""],
        link: r.link,
      })),
      { label: "התראות מרחביות", cells: perZone.map((z) => z.spatial), link: "alert" },
      { label: "התראות קוויות", cells: perZone.map((z) => z.linear), link: "alert" },
      { label: "התראות נקודתיות", cells: perZone.map((z) => z.pointy), link: "alert" },
      { label: "התראות מגורמים סמוכים", cells: perZone.map((z) => z.adjacent), link: "alert" },
    ];

    const bottomNotes: string[] = ["תכניות בניין עיר ומסמכי מדיניות מאושרים ובתכנון: (1) _____ (2) _____"];
    if (shown.length === 0) bottomNotes.push("לא נמצאו ישויות בשכבות אזורי הייעוד בתחום שנבחר, או שלא זוהה שדה שם.");
    if (zoneColumns.length > shown.length) bottomNotes.push(`מוצגים ${shown.length} אזורי הייעוד הנפוצים מתוך ${zoneColumns.length}.`);
    const sources = plan.filter((r): r is ZonePlanResult => !!r && !!r.info.source);
    if (sources.length) {
      bottomNotes.push("מקור: תוכנית המתאר תא/5500 — " + sources.map((r) => `${r.info.zone} (${r.info.source})`).join("; "));
    }
    const fromLayer = merged.flatMap((m, i) => m.fromLayer.map((k) => `${shown[i].zone}: ${ZONE_ROWS.find((r) => r.key === k)?.label.split(" - ")[0]}`));
    if (fromLayer.length) bottomNotes.push(`ערכים שלא נמצאו בתוכנית המתאר נלקחו משכבת אזורי הייעוד (${fromLayer.join("; ")})`);
    const areaNotes = plan.find((r) => r && r.areaNotes.length)?.areaNotes ?? [];
    if (areaCode && areaNotes.length) bottomNotes.push(`הוראות מיוחדות לאזור תכנון ${areaCode} (טבלה 5.4): ${areaNotes.join(" | ")}`);
    if (errors.length) bottomNotes.push(`שגיאה בגישה ל-RAG, הוצגו נתוני השכבה: ${[...new Set(errors)][0]}`);
    bottomNotes.push(`תוצר אוטומטי לפי ${a.mode === "boundary" ? "גבול התכנית" : "הפוליגון שנבחר"} + באפר ${QUERY_BUFFER_METERS} מ׳ | ${new Date().toLocaleDateString("he-IL")}`);

    return composeTablePage({
      columns,
      rows,
      topNotes: [
        "* ההוראות המפורטות בטבלה מטה מהוות תמצית של ההנחיות לתחום הנבחר. ככל ההוראות המחייבות מפורטות במסמכי תכנית המתאר",
        "** ההתראות המפורטות מטה עשויות לשנות באופן מקומי את ההנחיות הכלליות המוצגות בטבלה",
      ],
      bottomNotes,
    });
  }
}

const PLAN_SYMBOL = {
  type: "simple-fill",
  color: [0, 0, 255, 0.05],
  outline: { color: [0, 0, 255, 1], width: 3 },
};
