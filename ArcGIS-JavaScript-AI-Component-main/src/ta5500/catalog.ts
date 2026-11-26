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
    .replace(/תשתיות/g, "תשתית")
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
  "אזורי ומרחבי תכנון": ["אזורי תכנון", "אזורי ומרחבי"],
};

// Topic words that name a whole drawing group when no layer title is named ("תשתיות" → the infrastructure layers).
// Deliberately not "ייעוד" or "עיצוב": those are everyday words in plan questions.
const GROUP_TOPIC_WORDS: Record<string, string[]> = {
  "סביבה ותשתיות": ["תשתיות", "סביבה"],
  "תחבורה וניידות": ["תחבורה", "ניידות"],
};

/** The layers of every group whose topic word is in `n` (already normalized), minus titles that exist in several groups. */
function matchGroupTopics(n: string, entries: CatalogEntry[]): CatalogEntry[] {
  const groups = [...new Set(entries.map((e) => groupLabel(e.group)))];
  const groupsOfTitle = new Map<string, Set<string>>();
  for (const e of entries) groupsOfTitle.set(e.title, (groupsOfTitle.get(e.title) ?? new Set()).add(groupLabel(e.group)));
  const named = groups.filter((g) => (GROUP_TOPIC_WORDS[g] ?? []).some((w) => hasWord(n, normalizePlanText(w))));
  return entries.filter((e) => named.includes(groupLabel(e.group)) && groupsOfTitle.get(e.title)!.size === 1);
}

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
  // A drawing's full name can contain a layer title ("אזורי ומרחבי תכנון" contains "מרחבי תכנון"): when the whole
  // name is in the text, that part of the text names the drawing, not the layer.
  const groups = [...new Set(entries.map((e) => groupLabel(e.group)))];
  const fullGroups = groups.filter((g) => hasWord(n, normalizePlanText(g)));
  const inGroupName = (h: { matched: string }) => fullGroups.some((g) => normalizePlanText(g).includes(h.matched));
  const kept = hits
    .filter((h) => !inGroupName(h))
    .filter((h) => !hits.some((o) => o !== h && o.matched.length > h.matched.length && o.matched.includes(h.matched)));
  if (!kept.length) {
    out.layers.push(...matchGroupTopics(n, entries));
    return out;
  }

  let rest = n;
  for (const h of kept) rest = rest.split(h.matched).join(" ");
  const named = new Set([
    ...fullGroups,
    ...groups.filter((g) => (GROUP_ALIASES[g] ?? []).some((w) => hasWord(rest, normalizePlanText(w)))),
  ]);

  for (const h of kept) {
    const all = entries.filter((e) => e.title === h.title);
    const inNamed = all.filter((e) => named.has(groupLabel(e.group)));
    const chosen = named.size && all.length > 1 ? inNamed : all;
    if (chosen.length === 1) out.layers.push(chosen[0]);
    else out.ambiguous.push({ title: h.title, groups: [...new Set(all.map((e) => groupLabel(e.group)))] });
  }
  return out;
}

/** The catalog as numbered lines for an LLM: "<n>. <group> | <title>", n from 1, in map order. */
export function catalogForPrompt(entries: CatalogEntry[]): string {
  return entries.map((e, i) => `${i + 1}. ${groupLabel(e.group)} | ${e.title}`).join("\n");
}

/** The entries an LLM picked by number: valid, distinct 1-based integers only, returned in map order. */
export function entriesFromPicks(picks: number[], entries: CatalogEntry[]): CatalogEntry[] {
  const valid = new Set(picks.filter((n) => Number.isInteger(n) && n >= 1 && n <= entries.length));
  return entries.filter((_, i) => valid.has(i + 1));
}
