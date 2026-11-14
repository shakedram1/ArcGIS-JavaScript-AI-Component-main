// TA5500 focus planning, where clauses and focus store. Pure: no @arcgis/* runtime imports, no DOM.
import type { LayerKey } from "./layers";

export type Place = { kind: "area" | "subarea" | "street" | "geocoded"; codes: string[]; label: string };
export type FocusCase = "place_topic" | "place_only" | "topic_only" | "none";

export function planFocus(
  place: Place | null,
  candidates: Map<LayerKey, string[]>,
): { case: FocusCase; layers: Map<LayerKey, string[]> } {
  const copy = new Map<LayerKey, string[]>();
  for (const [k, v] of candidates) copy.set(k, [...v]);
  if (copy.size > 0) return { case: place ? "place_topic" : "topic_only", layers: copy };
  if (place) return { case: "place_only", layers: new Map<LayerKey, string[]>([["zones", []]]) };
  return { case: "none", layers: new Map() };
}

export function buildCodeWhere(field: string, fieldType: "string" | "number", codes: string[]): string {
  if (codes.length === 0) return "1=1";
  const uniq = [...new Set(codes.map((c) => String(c).trim()))];
  if (fieldType === "number") {
    const nums = uniq.filter((c) => /^\d+$/.test(c));
    return nums.length ? `${field} IN (${nums.join(",")})` : "1=0";
  }
  return `${field} IN (${uniq.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")})`;
}

export type FocusState = {
  place: Place | null;
  geometryJson: unknown | null;
  layers: { layerKey: LayerKey; where: string }[];
  previousVisibility: Record<string, boolean>;
  label: string;
};

let current: FocusState | null = null;
const subs = new Set<(s: FocusState | null) => void>();
function notify() {
  for (const fn of [...subs]) {
    try {
      fn(current);
    } catch (e) {
      console.error("focusStore subscriber failed", e);
    }
  }
}

export const focusStore = {
  get: (): FocusState | null => current,
  set(s: FocusState): void {
    current = s;
    notify();
  },
  clear(): FocusState | null {
    const prev = current;
    current = null;
    notify();
    return prev;
  },
  subscribe(fn: (s: FocusState | null) => void): () => void {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
};

export function focusLabel(place: Place | null, layerLabels: string[]): string {
  if (place) return `מיקוד: ${place.label}`;
  return layerLabels.length ? `מיקוד: ${layerLabels.join(", ")}` : "מיקוד";
}
