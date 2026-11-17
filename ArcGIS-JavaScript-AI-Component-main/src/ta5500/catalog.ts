// The plan map's layers as (drawing group, layer title) and matching of a request against them.
// Pure: no @arcgis/* runtime imports, no DOM. The entries are read from the live map (mapFocus.listCatalog);
// the same title can exist in several groups (the plan's drawings), e.g. "גבול התכנית" in all five.
import { hasWord } from "./layers";

export type CatalogEntry = { uid: string; title: string; group: string };
export type CatalogMatch = { layers: CatalogEntry[]; ambiguous: { title: string; groups: string[] }[] };

/** Spelling variants of plan words are equal; the plan's name ("תא/5500", "5500") and quotes are dropped. */
export function normalizePlanText(s: string): string {
  return s
    .replace(/תא\s*\/?\s*5500/g, " ")
    .replace(/5500/g, " ")
    .replace(/["'׳״`]/g, "")
    .replace(/איזור/g, "אזור")
    .replace(/תוכנית/g, "תכנית")
    .replace(/גבולות/g, "גבול")
    .replace(/(?<!י)יעוד/g, "ייעוד")
    .replace(/\s+/g, " ")
    .trim();
}

/** The group title without the plan number: "עיצוב עירוני 5500" → "עיצוב עירוני". */
export function groupLabel(group: string): string {
  return group.replace(/\s*5500\s*$/, "").trim();
}

const GROUP_ALIASES: Record<string, string[]> = {
  "אזורי ייעוד": ["אזור ייעוד", "ייעוד"],
  "עיצוב עירוני": ["עיצוב"],
  "סביבה ותשתיות": ["סביבה", "תשתיות"],
  "תחבורה וניידות": ["תחבורה", "ניידות"],
};

// Leading words of a title that are also an everyday place phrase ("באזור תכנון 105"): never matched alone.
const LEAD_EXCLUDE = new Set(["אזור תכנון"]);

/** The words of a title before its first "ו…" word (from the third word on): "צירי תכנון וקווי תיחום" → "צירי תכנון". */
function leadOf(title: string): string | null {
  const words = title.split(" ");
  const i = words.findIndex((w, k) => k >= 2 && w.startsWith("ו"));
  const lead = i > 0 ? words.slice(0, i).join(" ") : "";
  return lead && !LEAD_EXCLUDE.has(lead) ? lead : null;
}

/**
 * Layers named in `text`. A title matches whole or by its lead. A named layer that exists in one group (or in the
 * one group the text names) is returned in `layers`; one that exists in several groups, with no group named or a
 * named group that lacks it, is returned in `ambiguous` with the groups that have it, in map order.
 */
export function matchCatalog(text: string | null | undefined, entries: CatalogEntry[]): CatalogMatch {
  const out: CatalogMatch = { layers: [], ambiguous: [] };
  const n = normalizePlanText(text ?? "");
  if (!n) return out;

  const hits: { title: string; matched: string }[] = [];
  for (const title of new Set(entries.map((e) => e.title))) {
    const full = normalizePlanText(title);
    const lead = leadOf(full);
    const matched = hasWord(n, full) ? full : lead && hasWord(n, lead) ? lead : null;
    if (matched) hits.push({ title, matched });
  }
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.matched.length > h.matched.length && o.matched.includes(h.matched)));
  if (!kept.length) return out;

  let rest = n;
  for (const h of kept) rest = rest.split(h.matched).join(" ");
  const named = new Set(
    [...new Set(entries.map((e) => groupLabel(e.group)))].filter((g) =>
      [normalizePlanText(g), ...(GROUP_ALIASES[g] ?? [])].some((w) => hasWord(rest, w)),
    ),
  );

  for (const h of kept) {
    const all = entries.filter((e) => e.title === h.title);
    const inNamed = all.filter((e) => named.has(groupLabel(e.group)));
    const chosen = named.size && all.length > 1 ? inNamed : all;
    if (chosen.length === 1) out.layers.push(chosen[0]);
    else out.ambiguous.push({ title: h.title, groups: [...new Set(all.map((e) => groupLabel(e.group)))] });
  }
  return out;
}
