// nb_changed 2026-11-16: new file. Framework-free helpers for the TA5500 PDF viewer window:
//  - parseTa5500Hits: reads the ranked chunk ids that the RAG's MCP wrapper (mcp/server.mjs, search_plan) appends to its output
//    as a single `<!--ta5500-hits:[...]-->` line;
//  - loadTa5500ChunkIndex: loads the static chunk file (chunk_id -> text + XY boxes in PDF points) once.
// It imports nothing from React/ArcGIS, so it can be run in Node (tsx) like mcpAgentCore.ts.

/** One box on a PDF page, in PDF points measured from the TOP-LEFT of the page. */
export interface Ta5500Region {
  page?: number;
  pdf_page: number; // the physical PDF page (use this one, not `page`/`page_start`, which can differ by one)
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  page_w: number; // page size in points; lets the overlay be positioned in percent, independent of zoom
  page_h: number;
  orientation?: string;
}

/** One chunk of the plan, as stored in public/ta5500/chunks.json. Only the fields the viewer uses are typed. */
export interface Ta5500Chunk {
  chunk_id: string;
  seq?: number;
  kind?: string;
  text?: string;
  heading_path?: string[];
  zone?: string | null;
  area?: string | null;
  page_start?: number;
  page_end?: number;
  bbox_exact?: boolean; // false = the box was estimated between neighbouring chunks
  regions?: Ta5500Region[];
  regions_v2?: Ta5500Region[]; // only present in the demo file; the final file has a single `regions`
}

/** One hit as the MCP wrapper reports it: id = chunk_id, p = page_start, s = score. Array order = rank. */
export interface Ta5500Hit {
  id: string;
  p?: number | null;
  s?: number;
  explicit?: boolean;
}

/** A readable label for the viewer; chunk IDs are internal except for actual clause numbers. */
export function chunkLabel(hit: Ta5500Hit, chunk?: Ta5500Chunk, previous?: Ta5500Chunk): { title: string; context?: string } {
  if (chunk?.zone) {
    return { title: chunk.zone, context: chunk.area ? `אזור תכנון ${chunk.area}` : undefined };
  }
  if (chunk?.kind === "record") {
    const title = chunk.text?.match(/^\[([^\]]+)\]/)?.[1];
    if (title) return { title };
  }
  if (/^\d+(?:\.\d+)*(?:\([א-תa-z\d]+\))*$/i.test(hit.id)) {
    const isChapter = chunk?.kind === "chapter" || /^\d+$/.test(hit.id);
    const lines = chunk?.text?.split("\n") ?? [];
    const firstLine = lines[0]?.trim() ?? "";
    let context: string | undefined;
    if (chunk?.kind === "chapter") {
      context = firstLine.match(/^פרק\s+\d+\s*[–-]\s*(.+)$/)?.[1];
    } else if (chunk?.kind === "section" || chunk?.kind === "subsection") {
      const prefix = `${hit.id}.`;
      if (firstLine.startsWith(prefix)) context = firstLine.slice(prefix.length).trim() || undefined;
    } else if (chunk?.kind === "clause") {
      const ownTitle = firstLine.match(/^\([א-ת\d]+\)\s+([^.!?:]{1,80})$/)?.[1]?.trim();
      if (ownTitle && /^\s*\([א-ת\d]+\)/.test(lines[1] ?? "")) {
        context = ownTitle;
      } else {
        const parent = chunk.heading_path?.slice().reverse().find((part) => /^\d+(?:\.\d+)+\.\s+\S/.test(part));
        if (parent) context = `תחת סעיף ${parent}`;
      }
    }
    return { title: `${isChapter ? "פרק" : "סעיף"} ${hit.id}`, ...(context ? { context } : {}) };
  }
  const heading = chunk?.heading_path?.slice(-1)[0];
  const firstLine = chunk?.text?.split("\n")[0]?.trim();
  const previousLine = previous?.kind === "intro" ? previous.text?.split("\n").slice(-1)[0]?.trim() : undefined;
  const shortTitle = (line?: string) => line && line.length <= 60 && !/[.:!?]$/.test(line) ? line : undefined;
  const bulletTitle = firstLine?.match(/^[]\s*([^:]{1,60}):/)?.[1];
  return {
    title: heading || "קטע ללא כותרת",
    context: chunk?.kind === "intro" ? bulletTitle || shortTitle(firstLine) || shortTitle(previousLine) : undefined,
  };
}

/** Broad introductory and chapter chunks are shown only when the request names them. */
export function filterViewerHits(hits: Ta5500Hit[], index: Map<string, Ta5500Chunk>, request: string): Ta5500Hit[] {
  const introRequested = /דברי\s+ה?הסבר|(?:ה)?מבוא|הקדמה|ת(?:ו)?כנית\s+ה?מתאר\s+ה?כוללנית|עדכון\s+ת(?:ו)?כנית\s+המתאר/i.test(request);
  const chapters = [...request.matchAll(/(?:פרק|סעיף|chapter|section)\s*(\d+)(?![\d.])/gi)].map((match) => match[1]);
  return hits.filter((hit) => {
    if (hit.explicit) return true;
    const chunk = index.get(hit.id);
    if (chunk?.kind === "intro") return introRequested;
    if (chunk?.kind !== "chapter") return true;
    const title = chunk.text?.split("\n")[0]?.replace(/^פרק\s+\d+\s*[–-]\s*/, "").trim();
    return chapters.includes(hit.id) || (!!title && /פרק|chapter/i.test(request) && request.includes(title));
  });
}

const HITS_MARKER = /<!--ta5500-hits:(\[[\s\S]*?\])-->/g;

/**
 * Extracts the ranked hits from the raw text outputs of this turn's tool calls.
 * Keeps the rank order, drops duplicates (a later search of the same turn only adds new ids) and ignores bad JSON.
 */
export function parseTa5500Hits(toolOutputs: string[]): Ta5500Hit[] {
  const seen = new Set<string>();
  const hits: Ta5500Hit[] = [];
  for (const output of toolOutputs) {
    if (typeof output !== "string") continue;
    for (const match of output.matchAll(HITS_MARKER)) {
      try {
        const parsed = JSON.parse(match[1]);
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
          seen.add(item.id);
          hits.push({ id: item.id, p: item.p ?? null, s: typeof item.s === "number" ? item.s : undefined });
        }
      } catch {
        // malformed marker: skip it, the chat answer is not affected
      }
    }
  }
  return hits;
}

/** The regions to draw for a chunk: `regions`, or `regions_v2` when only the demo file's second version is filled. */
export function regionsOf(chunk: Ta5500Chunk): Ta5500Region[] {
  if (chunk.regions && chunk.regions.length) return chunk.regions;
  return chunk.regions_v2 ?? [];
}

/** Locate an explicitly requested clause without searching the plan. */
export function findClauseHit(index: Map<string, Ta5500Chunk>, clause: string, request: string): Ta5500Hit | null {
  const id = clause.trim();
  const mentioned: string[] = request.match(/\d+(?:\.\d+)*(?:\([א-תa-z\d]+\))?/gi) ?? [];
  if (!mentioned.includes(id)) return null;
  const chunk = index.get(id);
  return chunk && regionsOf(chunk).length ? { id } : null;
}

let chunkIndexPromise: Promise<Map<string, Ta5500Chunk>> | null = null;

/** Loads /ta5500/chunks.json once and returns a chunk_id -> chunk map. A failed load is not cached, so a retry can succeed. */
export function loadTa5500ChunkIndex(url = "/ta5500/chunks.json"): Promise<Map<string, Ta5500Chunk>> {
  if (!chunkIndexPromise) {
    chunkIndexPromise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`chunks file HTTP ${res.status}`);
        return res.json() as Promise<Ta5500Chunk[]>;
      })
      .then((rows) => new Map(rows.map((row) => [row.chunk_id, row] as const)))
      .catch((error) => {
        chunkIndexPromise = null;
        throw error;
      });
  }
  return chunkIndexPromise;
}
