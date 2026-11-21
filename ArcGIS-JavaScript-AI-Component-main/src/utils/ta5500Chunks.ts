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
