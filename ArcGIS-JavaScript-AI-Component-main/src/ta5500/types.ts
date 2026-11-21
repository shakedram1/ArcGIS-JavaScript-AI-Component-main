// Shapes returned by the TA5500 (תוכנית המתאר תא/5500) RAG MCP server. Pure types: no runtime imports.

export type GisCode = { layer: string; code: string; key: "zone_types" | "headings"; value: string; note?: string };

export type PlanLocations = {
  areas: { code: string; name: string }[];
  subareas: { code: string; area: string; name: string }[];
  entities: { code: string; type: string; label: string; areas: string[] }[];
  zone_types: { id: string; title: string; category: string }[];
  zone_categories: { id: string; title: string }[];
  gis_codes: GisCode[];
};

export type PlanHit = { chunk_id?: string; citation: string; pages: string; via: string; heading_path: string };

export type PlanSearchResult = {
  text: string;
  band: "high" | "medium" | "low";
  location: { areas: string[]; subareas: string[]; zone_types: string[]; entities: string[] };
  hits: PlanHit[];
};

export type PlanFilters = { areas?: string[]; entities?: string[]; zone_types?: string[]; headings?: string[] };
