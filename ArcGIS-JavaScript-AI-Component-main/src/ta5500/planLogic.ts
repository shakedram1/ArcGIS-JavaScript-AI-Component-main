// TA5500 request validation, cited sections and reverse gis_codes. Pure: no @arcgis/* runtime imports, no DOM.
// "LLMs propose, code validates": every value in the returned filters comes from the plan data, never from the input.
import { TA5500_LAYERS, type LayerKey } from "./layers";
import type { GisCode, PlanFilters, PlanHit, PlanLocations, PlanSearchResult } from "./types";

const dedupe = (xs: string[]) => [...new Set(xs)];

function normalizeArea(raw: string): string {
  const s = raw.replace(/[\s'"׳״`\-־]/g, "");
  const m = /^(\d+)([א-ת]?)$/.exec(s) ?? (/^([א-ת])(\d+)$/.exec(s) ? ((x) => [x[0], x[2], x[1]])(/^([א-ת])(\d+)$/.exec(s)!) : null);
  return m ? `${m[1]}${m[2]}` : "";
}

const HEADING_RE = /^\d+(\.\d+)*(\([^)]+\))*$/;

export function validateRequest(c: PlanFilters, loc: PlanLocations): { filters: PlanFilters; dropped: string[] } {
  const dropped: string[] = [];
  const filters: PlanFilters = {};
  const run = (key: keyof PlanFilters, resolve: (v: string) => string | undefined) => {
    const input = c[key];
    if (!input) return;
    const kept: string[] = [];
    for (const raw of input) {
      const v = typeof raw === "string" ? raw.trim() : "";
      const ok = v ? resolve(v) : undefined;
      if (ok) kept.push(ok);
      else if (v) dropped.push(v);
    }
    filters[key] = dedupe(kept);
  };

  const areaCodes = new Set([...loc.areas.map((a) => a.code), ...loc.subareas.map((s) => s.code)]);
  run("areas", (v) => {
    const n = normalizeArea(v);
    return n && areaCodes.has(n) ? n : undefined;
  });

  run("entities", (v) => {
    const e = loc.entities.find((x) => (x.code && x.code === v) || x.label === v);
    return e ? (e.code && e.code === v ? e.code : e.label) : undefined;
  });

  const zoneIds = new Set(loc.zone_types.map((z) => z.id));
  const catIds = new Set(loc.zone_categories.map((z) => z.id));
  run("zone_types", (v) => {
    if (zoneIds.has(v) || catIds.has(v)) return v;
    return loc.zone_types.find((z) => z.title === v)?.id;
  });

  run("headings", (v) => (HEADING_RE.test(v) ? v : undefined));
  return { filters, dropped: dedupe(dropped) };
}

const SECTION_TOKEN = /\d+(?:\.\d+)*(?:\([^)]*\))*/g;

function sectionsOfCitation(citation: string): string[] {
  const m = /^\s*(?:סעיף|סעיפים)\s+(.*)$/.exec(citation);
  if (!m) return [];
  const body = m[1].split("|")[0];
  return (body.match(SECTION_TOKEN) ?? []).map((t) => t.replace(/\(.*$/, ""));
}

export function citedSections(result: PlanSearchResult, citedIndexes: number[]): string[] {
  const out: string[] = [];
  let table54 = false;
  for (const i of citedIndexes) {
    const hit: PlanHit | undefined = Number.isInteger(i) && i >= 1 ? result.hits[i - 1] : undefined;
    if (!hit) continue;
    out.push(...sectionsOfCitation(hit.citation));
    if (/^\s*טבלה\s+5\.4(?![\d])/.test(hit.citation)) table54 = true;
  }
  if (table54) out.push(...result.location.zone_types);
  return dedupe(out);
}

const LAYER_KEYS = new Set<string>(Object.keys(TA5500_LAYERS));

export function layersForSections(sections: string[], gis: GisCode[]): Map<LayerKey, string[]> {
  const out = new Map<LayerKey, string[]>();
  for (const g of gis) {
    if (!LAYER_KEYS.has(g.layer)) continue;
    const hit = sections.some((s) => g.value === s || s.startsWith(`${g.value}(`) || g.value.startsWith(`${s}.`));
    if (!hit) continue;
    const key = g.layer as LayerKey;
    const list = out.get(key) ?? [];
    if (!list.includes(g.code)) list.push(g.code);
    out.set(key, list);
  }
  return out;
}

export function isInsideExtent(
  p: { x: number; y: number },
  e: { xmin: number; ymin: number; xmax: number; ymax: number },
): boolean {
  return p.x >= e.xmin && p.x <= e.xmax && p.y >= e.ymin && p.y <= e.ymax;
}
