// TA5500 layer configuration and matching. Pure: no @arcgis/* runtime imports, no DOM.
import type { PlanFilters } from "./types";

export type LayerKey = "areas" | "zones" | "foci" | "spaces" | "streets" | "employment";

export const TA5500_LAYERS: Record<LayerKey, { layerId: number; codeFields: string[]; displayField?: string; label: string }> = {
  areas: { layerId: 122, codeFields: ["NumEzorTihnun"], label: "אזורי תכנון" },
  zones: { layerId: 128, codeFields: ["EzorYeudCode"], displayField: "EzorYeud", label: "אזורי ייעוד" },
  foci: { layerId: 124, codeFields: ["TypeCode"], displayField: "TypeName", label: "מוקדי פיתוח ושימוש עירוניים" },
  spaces: { layerId: 145, codeFields: ["mis_ezor"], displayField: "shem_ezor", label: "מרחבי תכנון" },
  streets: { layerId: 146, codeFields: ["mis_ezor"], displayField: "shem_ezor", label: "הוראות רחוב מיוחדות" },
  // codeFields: the first field that exists on the layer is used at runtime.
  employment: { layerId: 126, codeFields: ["TypeCode2", "TypeCode"], label: "תעסוקה" },
};

export const TOPIC_OVERRIDES: { words: string[]; filters: PlanFilters }[] = [
  {
    words: ["פיתוח עסקי", "פיתוח כלכלי", "תעסוקה", "מסחר", "מסחרי", "עסקים"],
    filters: { zone_types: ["3.3", "3.4.1"] },
  },
];

const KEY_BY_ID = new Map<number, LayerKey>(
  (Object.keys(TA5500_LAYERS) as LayerKey[]).map((k) => [TA5500_LAYERS[k].layerId, k]),
);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function matchTa5500LayerUrl(url: string): { layerKey: LayerKey; layerId: number } | null {
  if (!url) return null;
  const m = /\/services\/([^/]+)\/(?:FeatureServer|MapServer)\/(\d+)\/?(?:[?#].*)?$/i.exec(safeDecode(url));
  if (!m || !m[1].startsWith("TA5500_")) return null;
  const layerId = Number(m[2]);
  const layerKey = KEY_BY_ID.get(layerId);
  return layerKey ? { layerKey, layerId } : null;
}

const PREFIX = "[והבלמש]{0,2}";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HEB = "\\u0590-\\u05FF";

export function matchTopicOverrides(text: string): PlanFilters {
  const out: PlanFilters = {};
  if (!text) return out;
  for (const { words, filters } of TOPIC_OVERRIDES) {
    const hit = words.some((w) =>
      new RegExp(`(?<![\\w${HEB}])${w.split(/\s+/).map((part) => PREFIX + escapeRe(part)).join("\\s+")}(?![\\w${HEB}])`, "u").test(text),
    );
    if (!hit) continue;
    for (const key of Object.keys(filters) as (keyof PlanFilters)[]) {
      const add = filters[key] ?? [];
      out[key] = [...new Set([...(out[key] ?? []), ...add])];
    }
  }
  return out;
}

export type MapLayerLike = { uid: string; url?: string | null; layerId?: number | null; type: string };

export function findTa5500Layers(layers: MapLayerLike[]): Map<LayerKey, MapLayerLike[]> {
  const out = new Map<LayerKey, MapLayerLike[]>();
  for (const layer of layers) {
    if (!layer.url) continue;
    const url = layer.url.replace(/\/+$/, "");
    const full = /\/\d+$/.test(safeDecode(url)) || layer.layerId == null ? url : `${url}/${layer.layerId}`;
    const m = matchTa5500LayerUrl(full);
    if (!m) continue;
    const list = out.get(m.layerKey) ?? [];
    list.push(layer);
    out.set(m.layerKey, list);
  }
  return out;
}
