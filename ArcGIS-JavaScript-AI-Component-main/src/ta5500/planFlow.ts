// Pure helpers for the TA5500 Plan agent (spec §5.3): conversation text for the resolve prompt, the place
// derived from validated filters, search filters, answer context, map candidates and the final reply.
// Pure: no @arcgis/* runtime imports, no DOM.
import type { BaseMessage } from "@langchain/core/messages";
import { type LayerKey } from "./layers";
import { citedSections, layersForSections, validateRequest } from "./planLogic";
import type { Place } from "./focus";
import type { PlanFilters, PlanLocations, PlanSearchResult } from "./types";

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
