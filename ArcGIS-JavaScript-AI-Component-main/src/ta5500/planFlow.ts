// Pure helpers for the TA5500 Plan agent (spec §5.3): conversation text for the resolve prompt, the place
// derived from validated filters, search filters, answer context, map candidates and the final reply.
// Pure: no @arcgis/* runtime imports, no DOM.
import type { BaseMessage } from "@langchain/core/messages";
import { hasWord, matchLayerTopics, matchTopicOverrides, type LayerKey } from "./layers";
import { citedSections, layersForSections, validateRequest } from "./planLogic";
import type { Place } from "./focus";
import type { PlanFilters, PlanLocations, PlanSearchResult } from "./types";
import { PlanServiceError } from "./ragClient";
import { REQUEST_FAILED_REPLY, hiddenLine, hidePartialNote, hideWholeMapNote, shownLine } from "./prompts";

const FILTER_KEYS: (keyof PlanFilters)[] = ["areas", "entities", "zone_types", "headings"];

function messageText(m: BaseMessage): string {
  const c: unknown = (m as any)?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return "";
}

function roleOf(m: any): "user" | "assistant" | null {
  const type = typeof m?._getType === "function" ? m._getType() : m?.type ?? m?.role;
  if (type === "human" || type === "user") return "user";
  if (type === "ai" || type === "assistant") return "assistant";
  return null;
}

/**
 * The {request} input of RESOLVE_PROMPT: the recent user/assistant turns as plain text, ending with the
 * request. Tool messages and empty AI turns are dropped (the history is not passed as chat messages, so
 * dangling tool calls cannot break the structured call).
 */
export function conversationText(messages: BaseMessage[] | undefined, request: string, maxTurns = 8, maxChars = 800): string {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of messages ?? []) {
    const role = roleOf(m);
    const text = role ? messageText(m).trim() : "";
    if (role && text) turns.push({ role, text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text });
  }
  const req = request.trim();
  const last = [...turns].reverse().find((t) => t.role === "user");
  if (req && last?.text !== req) turns.push({ role: "user", text: req });
  return turns
    .slice(-maxTurns)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n");
}

export function mergeFilters(...all: PlanFilters[]): PlanFilters {
  const out: PlanFilters = {};
  for (const f of all) {
    for (const k of FILTER_KEYS) {
      const v = f?.[k];
      if (v?.length) out[k] = [...new Set([...(out[k] ?? []), ...v])];
    }
  }
  return out;
}

function areaLabel(codes: string[], loc: PlanLocations): string {
  if (codes.length > 1) return `אזורים ${codes.join(", ")}`;
  const code = codes[0];
  const name = loc.areas.find((a) => a.code === code)?.name ?? loc.subareas.find((s) => s.code === code)?.name;
  return name ? `אזור ${code} – ${name}` : `אזור ${code}`;
}

function streetLabel(code: string, label: string): string {
  const rest = label.startsWith(code) ? label.slice(code.length).trim() : label.trim();
  return rest ? `${rest} (${code})` : `רחוב ${code}`;
}

/**
 * The place named by validated filters: the first validated area or sub-area (with the other validated codes
 * of the same kind), else the first area / sub-area / street entity. Codes and labels come from the plan data.
 */
export function placeFromFilters(filters: PlanFilters, loc: PlanLocations): Place | null {
  const subareaCodes = new Set(loc.subareas.map((s) => s.code));
  const areas = filters.areas ?? [];
  if (areas.length) {
    const kind: Place["kind"] = subareaCodes.has(areas[0]) ? "subarea" : "area";
    const codes = areas.filter((c) => subareaCodes.has(c) === (kind === "subarea"));
    return { kind, codes, label: areaLabel(codes, loc) };
  }
  for (const v of filters.entities ?? []) {
    const e = loc.entities.find((x) => (x.code && x.code === v) || x.label === v);
    if (!e) continue;
    if (e.type === "street" && e.code) return { kind: "street", codes: [e.code], label: streetLabel(e.code, e.label) };
    if (e.type === "subarea" && e.code) return { kind: "subarea", codes: [e.code], label: areaLabel([e.code], loc) };
    if (e.type === "area" && e.areas.length) {
      const codes = validateRequest({ areas: e.areas }, loc).filters.areas ?? [];
      if (codes.length) return { kind: "area", codes, label: areaLabel(codes, loc) };
    }
  }
  return null;
}

/** Search filters for a place that did not come from the request's own filters (geocoded or the stored focus); validated. */
export function placeSearchFilters(place: Place, loc: PlanLocations): PlanFilters {
  if (place.kind === "street") return validateRequest({ entities: place.codes }, loc).filters;
  return validateRequest({ areas: place.codes }, loc).filters;
}

/** The {context} input of ANSWER_PROMPT: the RAG text, which starts with the band line; added if it is missing. */
export function answerContext(result: PlanSearchResult): string {
  if (result.text.includes("רמת התאמה")) return result.text;
  const label = result.band === "high" ? "התאמה גבוהה" : result.band === "medium" ? "התאמה בינונית" : "התאמה נמוכה";
  return `רמת התאמה: ${label}\n\n${result.text}`;
}

/** Map candidates (spec §5.3 4.2): layers of the sections the answer cited, plus the topic-override zone types. */
export function candidateLayers(
  result: PlanSearchResult,
  usedItems: number[],
  overrideZoneTypes: string[],
  loc: PlanLocations,
): Map<LayerKey, string[]> {
  const out = layersForSections(citedSections(result, usedItems), loc.gis_codes);
  for (const [key, codes] of layersForSections(overrideZoneTypes, loc.gis_codes)) {
    out.set(key, [...new Set([...(out.get(key) ?? []), ...codes])]);
  }
  return out;
}

/** Final reply: the answer, then the map line and notes (empty parts dropped). */
export function composeOutput(answer: string, ...extra: (string | null | undefined)[]): string {
  return [answer.trim(), ...extra.map((s) => (s ?? "").trim())].filter(Boolean).join("\n\n");
}

export function focusSummary(place: Place | null, layers: LayerKey[]): string {
  return `${place ? place.label : "no place"}; layers: ${layers.length ? layers.join(", ") : "none"}`;
}

/** Reply for an error that ends a TA5500 agent run: the plan-service message, or a generic failure. */
export function failureReply(err: unknown, tag: string): { output: string; ok: false } {
  if (err instanceof PlanServiceError) {
    console.warn(`${tag} plan service:`, err.detail ?? err.message);
    return { output: err.message, ok: false };
  }
  console.warn(`${tag}:`, err);
  return { output: REQUEST_FAILED_REPLY, ok: false };
}

// ---------- Map agent (spec §5.2, §5.5) ----------

/** A place written as a plan code or plan entity (area, sub-area, street), validated against the plan data. */
export function placeFromText(text: string | null | undefined, loc: PlanLocations): Place | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  return placeFromFilters(validateRequest({ areas: [t], entities: [t] }, loc).filters, loc);
}

const categoryCore = (title: string) => title.replace(/^אזורי?\s+/, "").trim();

/**
 * Plan layers (with feature codes) for a map topic in the user's words. Only plan data decides: a zone type id
 * or exact title (validateRequest); otherwise a zone category title such as "אזורי מגורים" / "מגורים" and the
 * topic overrides and the layers named as a whole ("שכבת המוקדים", codes [] = the whole layer). Empty when nothing matches.
 */
export function topicLayers(topic: string | null | undefined, loc: PlanLocations): Map<LayerKey, string[]> {
  const t = (topic ?? "").trim();
  const out = new Map<LayerKey, string[]>();
  if (!t) return out;
  // An exact zone type id or title is specific: categories, overrides and layer names are only matched otherwise.
  const exact = validateRequest({ zone_types: [t] }, loc).filters.zone_types ?? [];
  const zoneTypes = exact.length
    ? exact
    : [
        ...loc.zone_categories.filter((c) => hasWord(t, c.title) || (categoryCore(c.title) && hasWord(t, categoryCore(c.title)))).map((c) => c.id),
        ...(matchTopicOverrides(t).zone_types ?? []),
      ];
  for (const [key, codes] of layersForSections([...new Set(zoneTypes)], loc.gis_codes)) out.set(key, codes);
  if (!exact.length) for (const key of matchLayerTopics(t)) out.set(key, []);
  return out;
}

export type MapAction = "go_to" | "show" | "hide" | "filter" | "reset";
export type MapStep = "reset" | "outside" | "go_to" | "focus" | "hide" | "hide_partial" | "no_place" | "no_topic";

/**
 * What the Map agent does (never acts on things not in the plan):
 * - reset → reset;
 * - a named place outside Tel Aviv-Yafo (every action but reset) → outside (OUTSIDE_TA_REPLY, map unchanged);
 * - go_to → go to the resolved place, or no_place;
 * - show / filter / hide → no_place when a place was named but not resolved (the map stays unchanged);
 * - hide → hide the layers named as a whole (hideTargets); hide_partial when the topic only names types inside
 *   layers (hiding part of a layer is not supported); no_topic when nothing matched;
 * - show / filter → focus when the topic matched plan layers or a place resolved; otherwise no_topic.
 */
export function mapStep(
  action: MapAction,
  s: { placeText: string | null | undefined; place: Place | null; layers: Map<LayerKey, string[]>; outside?: boolean },
): MapStep {
  if (action === "reset") return "reset";
  if (s.outside) return "outside";
  if (action === "go_to") return s.place ? "go_to" : "no_place";
  if ((s.placeText ?? "").trim() && !s.place) return "no_place";
  if (action === "hide") {
    if (!s.layers.size) return "no_topic";
    return hideTargets(s.layers).whole.length ? "hide" : "hide_partial";
  }
  return s.layers.size || s.place ? "focus" : "no_topic";
}

/** Hide acts only on layers named as a whole (codes []); layers matched by feature codes are reported as partial. */
export function hideTargets(layers: Map<LayerKey, string[]>): { whole: LayerKey[]; partial: LayerKey[] } {
  const whole: LayerKey[] = [];
  const partial: LayerKey[] = [];
  for (const [key, codes] of layers) (codes.length ? partial : whole).push(key);
  return { whole, partial };
}

/**
 * Reply for a hide: what was hidden, requested whole layers not on the map, the code-level part that was not
 * hidden, and — when a place inside Tel Aviv-Yafo was named — that the hide applies to the whole map.
 */
export function hideReply(p: { hidden: string[]; missing: string[]; partial: string[]; placeLabel: string | null }): string {
  return composeOutput(
    hiddenLine(p.hidden),
    shownLine(null, [], p.missing),
    hidePartialNote(p.partial),
    p.placeLabel && p.hidden.length ? hideWholeMapNote(p.placeLabel) : "",
  );
}
