// Client for the TA5500 RAG tools behind the MCP hub (namespaced ta5500__*). Node-safe: no DOM, no @arcgis/*.
import { normalizeUrl } from "../agents/mcpAgentCore";
import { callMcpToolRaw, extractText, isAbortLikeError, type McpToolResult } from "../utils/mcpClient";
import type { PlanFilters, PlanHit, PlanLocations, PlanSearchResult } from "./types";

export const PLAN_SERVICE_UNAVAILABLE = "שירות תוכנית המתאר אינו זמין כרגע. נסו שוב בעוד מספר דקות.";

const SEARCH_TOOL = "ta5500__search_plan";
const LOCATIONS_TOOL = "ta5500__get_plan_locations";

/** The plan service failed or returned nothing usable. `message` is the Hebrew text to show the user; `detail` is the cause. */
export class PlanServiceError extends Error {
  readonly detail?: string;
  constructor(detail?: string) {
    super(PLAN_SERVICE_UNAVAILABLE);
    this.name = "PlanServiceError";
    this.detail = detail;
  }
}

const BANDS = new Set(["high", "medium", "low"]);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function resultText(r: McpToolResult): string {
  const text = extractText(r?.content);
  if (r?.isError || !text) throw new PlanServiceError(r?.isError ? text || "tool error" : "empty result");
  return text;
}

export function parseSearchPlanResult(r: McpToolResult): PlanSearchResult {
  const text = resultText(r);
  const sc: any = r.structuredContent && typeof r.structuredContent === "object" ? r.structuredContent : {};
  const loc = sc.location ?? {};
  const hits: PlanHit[] = Array.isArray(sc.hits)
    ? sc.hits.map((h: any) => ({
        citation: String(h?.citation ?? ""),
        pages: String(h?.pages ?? ""),
        via: String(h?.via ?? ""),
        heading_path: Array.isArray(h?.heading_path) ? h.heading_path.join(" > ") : String(h?.heading_path ?? ""),
      }))
    : [];
  return {
    text,
    band: BANDS.has(sc.band) ? sc.band : "low",
    location: { areas: strings(loc.areas), subareas: strings(loc.subareas), zone_types: strings(loc.zone_types), entities: strings(loc.entities) },
    hits,
  };
}

export function parsePlanLocations(r: McpToolResult): PlanLocations {
  const text = resultText(r);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlanServiceError(`locations are not JSON: ${text.slice(0, 120)}`);
  }
  const list = (k: string) => (Array.isArray(json?.[k]) ? json[k] : []);
  return {
    areas: list("areas"),
    subareas: list("subareas"),
    entities: list("entities"),
    zone_types: list("zone_types"),
    zone_categories: list("zone_categories"),
    gis_codes: list("gis_codes"),
  };
}

async function callTool(endpointUrl: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return await callMcpToolRaw(endpointUrl, name, args);
  } catch (error) {
    if (isAbortLikeError(error)) throw error; // a user cancel, not an outage
    throw new PlanServiceError(error instanceof Error ? error.message : String(error));
  }
}

export async function searchPlan(endpointUrl: string, question: string, filters: PlanFilters = {}): Promise<PlanSearchResult> {
  const args: Record<string, unknown> = {};
  if (question.trim()) args.question = question.trim();
  for (const [k, v] of Object.entries(filters)) {
    if (Array.isArray(v) && v.length) args[k] = v;
  }
  return parseSearchPlanResult(await callTool(endpointUrl, SEARCH_TOOL, args));
}

const locationsCache = new Map<string, Promise<PlanLocations>>();

/** Cached for the session per endpoint; a failed load is not cached, so the next call retries. */
export function getPlanLocations(endpointUrl: string): Promise<PlanLocations> {
  const key = normalizeUrl(endpointUrl);
  let pending = locationsCache.get(key);
  if (!pending) {
    pending = callTool(endpointUrl, LOCATIONS_TOOL, {}).then(parsePlanLocations);
    pending.catch(() => locationsCache.delete(key));
    locationsCache.set(key, pending);
  }
  return pending;
}
