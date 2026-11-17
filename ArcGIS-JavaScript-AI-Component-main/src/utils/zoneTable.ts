/**
 * The zone table of the planning-info sheet (דף מידע מתארי): one column per zone type
 * (אזור מגורים בבנייה עירונית, אזור מגורים בבנייה רבת קומות, …), one row per attribute of the zoning
 * layer (אזורי ייעוד תכנוניים, TA5500 layer 128). Cells hold the attribute VALUES, never field names.
 *
 * Pure logic with no ArcGIS or browser imports, so it runs under the tsx test harness.
 */

export type ZoneAttrs = Record<string, unknown>;

/** Field that holds the zone type; it is the column title. */
export const ZONE_NAME_FIELD = "EzorYeud";

const NONE = "-";

export interface ZoneRowSpec {
  key: string;
  /** Row heading, as in the sketch. */
  label: string;
  /** Fields the row reads, for documentation and for tests. */
  fields: string[];
  /** Underline the cell like the links in the sketch. */
  link?: "use";
  /** Cell text from every feature of the zone type that lies in the area. */
  format: (features: ZoneAttrs[]) => string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function nums(features: ZoneAttrs[], field: string): number[] {
  return features.map((f) => num(f[field])).filter((n): n is number => n !== null);
}

/** 2.50 → "2.5", 4 → "4". */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Distinct, non-empty text values in order of first appearance, one per line; "-" when there are none. */
function texts(features: ZoneAttrs[], field: string): string {
  const seen: string[] = [];
  for (const f of features) {
    const t = String(f[field] ?? "").replace(/\s+/g, " ").trim();
    if (t && !/^[-—–]+$/.test(t) && !seen.includes(t)) seen.push(t);
  }
  return seen.length ? seen.join("\n") : NONE;
}

function far(features: ZoneAttrs[]): string {
  const lo = Math.min(...nums(features, "RahakMinEzorYeud"));
  const hi = Math.max(...nums(features, "RahakMaxEzorYeud"));
  const withAdd = Math.max(...nums(features, "MaxRahakIncAdd"));
  const lines: string[] = [];
  if (Number.isFinite(hi) && hi > 0) {
    lines.push(Number.isFinite(lo) && lo > 0 && lo !== hi ? `${fmt(lo)}-${fmt(hi)}` : fmt(hi));
  }
  // A zone can gain FAR from table 5.4 / urban renewal; the base range alone would understate it.
  if (Number.isFinite(withAdd) && withAdd > (Number.isFinite(hi) ? hi : 0)) {
    lines.push(`עד ${fmt(withAdd)} כולל תוספת רח"ק`);
  }
  return lines.length ? lines.join("\n") : NONE;
}

function height(features: ZoneAttrs[]): string {
  // MaxGovaInc is the height step including the special instructions; k_gova is the zone's own step.
  const withSpecial = Math.max(...nums(features, "MaxGovaInc"));
  const own = Math.max(...nums(features, "k_gova"));
  const n = Number.isFinite(withSpecial) ? withSpecial : own;
  return Number.isFinite(n) && n > 0 ? `עד ${fmt(n)} קומות` : NONE;
}

/** Rows of the table in sketch order; the alert rows come from the spatial query, not from these fields. */
export const ZONE_ROWS: ZoneRowSpec[] = [
  {
    key: "primary",
    label: "מקבץ שימושים ראשי - לאזור הייעוד",
    fields: ["MikbazeiShimushim_Rashi"],
    link: "use",
    format: (fs) => texts(fs, "MikbazeiShimushim_Rashi"),
  },
  {
    key: "extra",
    label: "מקבצי שימושים נוספים - לאזור הייעוד",
    fields: ["MikbazeiShimushim_nosafim"],
    link: "use",
    format: (fs) => texts(fs, "MikbazeiShimushim_nosafim"),
  },
  { key: "far", label: 'רח"ק לפי אזור הייעוד', fields: ["RahakMinEzorYeud", "RahakMaxEzorYeud", "MaxRahakIncAdd"], format: far },
  { key: "height", label: "גובה מירבי", fields: ["MaxGovaInc", "k_gova"], format: height },
  { key: "special", label: "הוראות מיוחדות", fields: ["Instructions"], format: (fs) => texts(fs, "Instructions") },
];

export interface ZoneColumn {
  zone: string;
  /** Features of this zone type in the area. */
  count: number;
  /** Cell text by row key. */
  cells: Record<string, string>;
}

/**
 * Group the zoning features by zone type (most frequent first) and format every row for each type.
 * `nameField` lets the caller fall back to another field when the layer has no `EzorYeud`.
 */
export function buildZoneColumns(features: ZoneAttrs[], nameField: string = ZONE_NAME_FIELD): ZoneColumn[] {
  const byZone = new Map<string, ZoneAttrs[]>();
  for (const f of features) {
    const name = String(f[nameField] ?? "").trim();
    if (!name) continue;
    const list = byZone.get(name);
    if (list) list.push(f);
    else byZone.set(name, [f]);
  }
  return [...byZone.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([zone, fs]) => ({
      zone,
      count: fs.length,
      cells: Object.fromEntries(ZONE_ROWS.map((r) => [r.key, r.format(fs)])),
    }));
}

// ── Merging with the master-plan RAG ─────────────────────────────────────────

/** The part of the RAG's zone lookup (planInfo.ts ZoneInfo) that feeds the table. */
export interface RagZoneInfo {
  found: boolean;
  primaryUse: string;
  extraUses: string;
  far: string;
  height: string;
  directives: string;
}

function meaningful(v: string | undefined | null): v is string {
  return !!v && !/^[\s\-—–]*$/.test(v);
}

/** RAG values by row key; only rows the plan text actually answered are present. */
export function ragCells(info: RagZoneInfo | null | undefined): Record<string, string> {
  if (!info?.found) return {};
  const raw: Record<string, string> = {
    primary: info.primaryUse,
    extra: info.extraUses,
    far: info.far,
    height: info.height,
    special: info.directives,
  };
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => meaningful(v)));
}

/**
 * Per row: the plan text (RAG) wins because it carries the binding wording and the area-specific
 * overrides; the layer's attribute fills in only where the RAG has nothing for that row.
 * `fromLayer` lists the rows that fell back to the layer.
 */
export function mergeCells(
  layer: Record<string, string>,
  rag: Record<string, string>,
): { cells: Record<string, string>; fromLayer: string[] } {
  const cells: Record<string, string> = {};
  const fromLayer: string[] = [];
  for (const row of ZONE_ROWS) {
    const r = rag[row.key];
    if (meaningful(r)) cells[row.key] = r;
    else {
      cells[row.key] = layer[row.key] ?? NONE;
      if (meaningful(layer[row.key])) fromLayer.push(row.key);
    }
  }
  return { cells, fromLayer };
}
