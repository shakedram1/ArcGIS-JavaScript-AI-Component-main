// nb_changed 2026-11-16: new file. Floating window that shows the TA5500 plan PDF and highlights the chunks that the RAG returned.
//  - The ranked chunk ids come from assistantState (set by McpPassthroughAgent when a search_plan answer carries the hits marker).
//  - Each chunk's boxes (PDF points from the TOP-LEFT of the page) come from the static public/ta5500/chunks.json.
//  - The boxes are an overlay positioned in PERCENT of the page size, so they stay aligned at any zoom or window size.
//    Logic mirrors the RAG repo's pdf_viewer_demo/index.html.
// nb_changed 2026-11-16 (revision 2): the window now shows the WHOLE PDF as a continuous, scrollable list of pages (it was one
//    page at a time). Every page is as wide as the window (times the +/- zoom); pages are rendered lazily (only the ones near
//    the visible area). Choosing a chunk scrolls to it instead of switching page; the zoom is not changed by chunk navigation.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"; // nb_changed 2026-11-16: + useLayoutEffect (keeps the reading place when the layout changes)
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
import { getLastTa5500Hits } from "../utils/assistantState";
import {
  loadTa5500ChunkIndex,
  regionsOf,
  type Ta5500Chunk,
  type Ta5500Hit,
  type Ta5500Region,
} from "../utils/ta5500Chunks";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_URL = "/ta5500/plan.pdf";
// nb_changed 2026-11-16: these are now limits of the ZOOM FACTOR applied on top of "page as wide as the window" (1 = fit width).
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
// nb_changed 2026-11-16: space (px) left on each side of a page, and between pages. The layout maths below must match the CSS.
const PAGE_PAD = 12;
const PAGE_GAP = 12;
// nb_changed 2026-11-16 (revision 3): smallest size (px) the user can resize the window to; the CSS min-width/min-height match.
const MIN_W = 340;
const MIN_H = 300;

export interface PdfViewerWindowProps {
  open: boolean;
  onClose: () => void;
}

interface Entry {
  hit: Ta5500Hit;
  chunk: Ta5500Chunk | undefined; // undefined = the id is not in chunks.json
  regions: Ta5500Region[];
}

// nb_changed 2026-11-16: size of each page at scale 1 (PDF points), and where/how big it is drawn at the current width and zoom.
interface PageSize {
  w: number;
  h: number;
}
interface PageLayout {
  top: number; // px from the top of the scrolled content
  scale: number; // pdf.js scale used for this page
  width: number;
  height: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

// nb_changed 2026-11-16 (revision 3): which handle of the window is being dragged to resize it (n = top edge, se = bottom-right corner...).
type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

// nb_changed 2026-11-16 (revision 3): window size when it first opens; same values the CSS used to give (about 620 x 78% of the
// screen height), kept clear of the chat panel on the right.
const initialWindowSize = () => ({
  w: Math.max(MIN_W, Math.min(620, window.innerWidth - 520)),
  h: Math.max(MIN_H, Math.min(Math.round(window.innerHeight * 0.78), 820)),
});

// nb_changed 2026-11-16 (revision 3): index of the page whose top is the last one at or above `y` (binary search; `pages` is sorted
// by `top`). Used to know which page is on screen and to remember the reading place.
function pageAtOffset(pages: { top: number }[], y: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// nb_changed 2026-11-16: new component. One page of the PDF: an empty white box of the exact page size (so the scrollbar is right
// from the start) that draws its canvas only while it is near the visible area, and frees the canvas when it is far away.
function PdfPage({
  pdf,
  pageNumber,
  scale,
  width,
  height,
  root,
  children,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
  root: HTMLElement | null;
  children?: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  // "near" = within ~800px of the scroll area, so the next pages are already drawn when the user scrolls to them.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !root) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root,
      rootMargin: "800px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  // Draw the page when it is near (and again when the scale changes); free the bitmap when it is far, to save memory.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      task = page.render({
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      try {
        await task.promise;
      } catch (error: any) {
        if (error?.name !== "RenderingCancelledException") console.error("PDF page render failed:", error);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, pageNumber, scale]);

  return (
    <div ref={wrapRef} className="pdf-window__page" style={{ width, height }} data-page={pageNumber}>
      <canvas ref={canvasRef} />
      {children}
    </div>
  );
}

export function PdfViewerWindow({ open, onClose }: PdfViewerWindowProps) {
  const [hits, setHits] = useState<Ta5500Hit[]>(() => getLastTa5500Hits()?.hits ?? []);
  const [index, setIndex] = useState<Map<string, Ta5500Chunk> | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  // nb_changed 2026-11-16: was `scale` (fixed 1.2). Now a zoom FACTOR on top of "page as wide as the window"; 1 = fit the width.
  const [zoom, setZoom] = useState(1);
  const [pageSizes, setPageSizes] = useState<PageSize[] | null>(null); // nb_changed 2026-11-16: size of every page, read once
  const [viewerEl, setViewerEl] = useState<HTMLDivElement | null>(null); // nb_changed 2026-11-16: the scroll container
  const [viewerSize, setViewerSize] = useState({ w: 0, h: 0 }); // nb_changed 2026-11-16: its visible size, kept up to date
  const [focusTick, setFocusTick] = useState(0); // nb_changed 2026-11-16: bumped to ask for a scroll to the chosen chunk
  const [pos, setPos] = useState({ left: 90, top: 80 });
  // nb_changed 2026-11-16 (revision 3): window size (px), changed by dragging the edges/corners; was fixed by CSS.
  const [size, setSize] = useState(initialWindowSize);
  // nb_changed 2026-11-16 (revision 3): page picker. `currentPage` follows the scroll; `pageText`/`editingPage` hold what the user
  // is typing in the page box, so scrolling does not overwrite it.
  const [currentPage, setCurrentPage] = useState(1);
  const [pageText, setPageText] = useState("");
  const [editingPage, setEditingPage] = useState(false);

  // nb_changed 2026-11-16: true while a scroll to the chosen chunk is wanted but has not happened yet (e.g. the PDF is still loading).
  // Only chunk choices set it, so zooming or scrolling by hand never jumps the view back.
  const focusPendingRef = useRef(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // nb_changed 2026-11-16 (revision 3): state of a window resize in progress (which handle, and the pointer/window values at the start).
  const resizeRef = useRef<{ dir: ResizeDir; x: number; y: number; left: number; top: number; w: number; h: number } | null>(null);
  // nb_changed 2026-11-16 (revision 3): the part of the document at the top of the view (page index + how far through that page),
  // so it can be restored when a resize or zoom changes the page sizes; plus the latest layout for the throttled scroll handler.
  const anchorRef = useRef<{ page: number; fraction: number } | null>(null);
  const layoutRef = useRef<PageLayout[] | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  // nb_changed 2026-11-16: choose a chunk and ask the view to scroll to it (used by Prev/Next, chips and clicks on a box).
  const selectChunk = useCallback((i: number) => {
    setSelected(i);
    focusPendingRef.current = true;
    setFocusTick((t) => t + 1);
  }, []);

  // ---- data: hits from the RAG answer ------------------------------------------------------------------------------
  // New hits arrive through a window event (setLastTa5500Hits). A new answer restarts at the first (best) chunk.
  useEffect(() => {
    const onHits = () => {
      setHits(getLastTa5500Hits()?.hits ?? []);
      selectChunk(0); // nb_changed 2026-11-16: was setSelected(0); also asks the view to scroll to the first chunk
    };
    window.addEventListener("ta5500-hits-changed", onHits);
    return () => window.removeEventListener("ta5500-hits-changed", onHits);
  }, [selectChunk]);

  // The chunk file and the PDF are only fetched the first time the window is opened.
  useEffect(() => {
    if (!open) return;
    if (!index) {
      loadTa5500ChunkIndex()
        .then(setIndex)
        .catch((error) => setLoadError(`טעינת מיקומי הקטעים נכשלה: ${error?.message ?? error}`));
    }
    if (!pdf) {
      getDocument(PDF_URL)
        .promise.then(setPdf)
        .catch((error) => setLoadError(`טעינת קובץ ה-PDF נכשלה: ${error?.message ?? error}`));
    }
  }, [open, index, pdf]);

  // nb_changed 2026-11-16: when the window is (re)opened with hits already present, scroll to the chosen chunk again.
  useEffect(() => {
    if (open && hits.length) {
      focusPendingRef.current = true;
      setFocusTick((t) => t + 1);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // nb_changed 2026-11-16: read the size of every page once the PDF is loaded (no drawing, so it is cheap). Needed to lay out all
  // pages with the right height before they are drawn, and to handle landscape pages (e.g. page 89).
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    (async () => {
      const sizes: PageSize[] = [];
      for (let n = 1; n <= pdf.numPages; n += 1) {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        sizes.push({ w: viewport.width, h: viewport.height });
      }
      if (!cancelled) setPageSizes(sizes);
    })().catch((error) => setLoadError(`קריאת גדלי העמודים נכשלה: ${error?.message ?? error}`));
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  // nb_changed 2026-11-16: keep the scroll area's visible size up to date (the window can be resized by the user).
  useEffect(() => {
    if (!viewerEl) return;
    const measure = () => setViewerSize({ w: viewerEl.clientWidth, h: viewerEl.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewerEl);
    return () => observer.disconnect();
  }, [viewerEl]);

  // Hits joined with their boxes. Ranking order is kept.
  const entries: Entry[] = useMemo(
    () =>
      hits.map((hit) => {
        const chunk = index?.get(hit.id);
        return { hit, chunk, regions: chunk ? regionsOf(chunk) : [] };
      }),
    [hits, index],
  );
  const current = entries[selected];
  const currentPages = useMemo(
    () => [...new Set((current?.regions ?? []).map((r) => r.pdf_page))],
    [current],
  );

  // nb_changed 2026-11-16: where every page sits. Each page is as wide as the window (minus a small margin), times the zoom, so
  // the whole width of the page is visible; heights follow from the page's own shape.
  const layout: PageLayout[] | null = useMemo(() => {
    if (!pageSizes || viewerSize.w <= 0) return null;
    let top = PAGE_GAP;
    return pageSizes.map(({ w, h }) => {
      const scale = Math.max(0.05, (viewerSize.w - 2 * PAGE_PAD) / w) * zoom;
      const page = { top, scale, width: w * scale, height: h * scale };
      top += page.height + PAGE_GAP;
      return page;
    });
  }, [pageSizes, viewerSize.w, zoom]);

  // nb_changed 2026-11-16: scroll so that a box is centred in the window (or its top is near the top edge when it is taller than
  // the window). Short moves are animated; long jumps (many pages away) are instant so the pages in between are not all drawn.
  const scrollToRegion = useCallback(
    (region: Ta5500Region) => {
      const page = layout?.[region.pdf_page - 1];
      if (!viewerEl || !page) return;
      const boxTop = page.top + region.y0 * page.scale;
      const boxHeight = (region.y1 - region.y0) * page.scale;
      const top = Math.max(0, boxHeight > viewerSize.h - 40 ? boxTop - 20 : boxTop - (viewerSize.h - boxHeight) / 2);
      // sideways scroll is only needed when the zoom makes the page wider than the window
      let left = 0;
      if (viewerEl.scrollWidth > viewerEl.clientWidth) {
        const pageLeft = Math.max(0, (viewerEl.scrollWidth - page.width) / 2);
        left = Math.max(0, pageLeft + ((region.x0 + region.x1) / 2) * page.scale - viewerSize.w / 2);
      }
      const far = Math.abs(top - viewerEl.scrollTop) > viewerSize.h * 3;
      viewerEl.scrollTo({ top, left, behavior: far ? "auto" : "smooth" });
    },
    [layout, viewerEl, viewerSize.h, viewerSize.w],
  );

  // nb_changed 2026-11-16: carries out a requested scroll to the chosen chunk as soon as everything it needs is ready
  // (the chunk file, the page layout and the scroll area). Replaces the old "jump to page" effect.
  useEffect(() => {
    if (!focusPendingRef.current || !open) return;
    if (!layout || !viewerEl || !index) return; // not ready yet: stay pending, this effect runs again when they are
    focusPendingRef.current = false;
    const region = current?.regions[0];
    if (region) scrollToRegion(region);
  }, [focusTick, open, layout, viewerEl, index, current, scrollToRegion]);

  // nb_changed 2026-11-16 (revision 3): the scroll handler below runs inside an animation frame, so it reads the layout through
  // a ref (a layout captured when the frame was requested could be out of date by then).
  layoutRef.current = layout;
  const numPages = layout?.length ?? 0;

  // nb_changed 2026-11-16 (revision 3): follows the scroll. Works out (1) the page on screen, shown in the page box, and (2) the
  // reading place (page at the top of the view + fraction through it) that the layout effect below restores after a resize or zoom.
  // Throttled to one run per animation frame.
  const onViewerScroll = useCallback(() => {
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const pages = layoutRef.current;
      const el = viewerEl;
      if (!pages || !pages.length || !el) return;
      const top = el.scrollTop;
      const shown = pageAtOffset(pages, top + el.clientHeight / 3); // the page a third of the way down the view counts as "current"
      setCurrentPage((p) => (p === shown + 1 ? p : shown + 1));
      const first = pageAtOffset(pages, top);
      anchorRef.current = { page: first, fraction: clamp((top - pages[first].top) / pages[first].height, 0, 1) };
    });
  }, [viewerEl]);

  // nb_changed 2026-11-16 (revision 3): jump to the top of page `n` (1-based, clamped to the document). Short moves are animated, long
  // ones instant (same rule as scrollToRegion). A pending chunk scroll is dropped so it cannot override the user's choice.
  const goToPage = useCallback(
    (n: number) => {
      const pages = layoutRef.current;
      if (!pages || !pages.length || !viewerEl || !Number.isFinite(n)) return;
      const target = clamp(Math.round(n), 1, pages.length);
      focusPendingRef.current = false;
      const top = Math.max(0, pages[target - 1].top - PAGE_GAP);
      const far = Math.abs(top - viewerEl.scrollTop) > viewerEl.clientHeight * 3;
      viewerEl.scrollTo({ top, behavior: far ? "auto" : "smooth" });
      setCurrentPage(target);
    },
    [viewerEl],
  );

  // nb_changed 2026-11-16 (revision 3): when the page sizes change (window resized, or zoom +/-), put the same part of the document
  // back at the top of the view; otherwise the old pixel offset would land on a different page. Skipped while a scroll to a
  // chunk is pending, which has priority.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!layout || !viewerEl || !anchor || focusPendingRef.current) return;
    const page = layout[anchor.page];
    if (!page) return;
    const target = page.top + anchor.fraction * page.height;
    if (Math.abs(viewerEl.scrollTop - target) > 1) viewerEl.scrollTop = target;
  }, [layout, viewerEl]);

  // nb_changed 2026-11-16: the boxes of all returned chunks, grouped by the page they are on (was: only the shown page).
  // The chosen chunk in orange; the other returned chunks in blue (click one to choose it).
  const boxesByPage = useMemo(() => {
    const byPage = new Map<number, { key: string; i: number; entry: Entry; r: Ta5500Region }[]>();
    entries.forEach((entry, i) =>
      entry.regions.forEach((r, j) => {
        const list = byPage.get(r.pdf_page) ?? [];
        list.push({ key: `${entry.hit.id}:${j}`, i, entry, r });
        byPage.set(r.pdf_page, list);
      }),
    );
    return byPage;
  }, [entries]);

  // ---- dragging the window by its header ---------------------------------------------------------------------------
  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("calcite-action, button")) return; // header buttons are not a drag handle
    dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos({
      left: clamp(e.clientX - drag.dx, 0, window.innerWidth - 140),
      top: clamp(e.clientY - drag.dy, 0, window.innerHeight - 48),
    });
  };
  const onHeaderPointerUp = () => {
    dragRef.current = null;
  };

  // nb_changed 2026-11-16 (revision 3): resizing by dragging an edge or corner. Same pattern as the header drag: the pointer is
  // captured by the handle, and the new size comes from how far it moved since the press. Dragging a west/north edge also
  // moves left/top so the opposite edge stays where it was. Size is kept between MIN_W x MIN_H and the browser window, and the
  // window cannot be pushed off-screen.
  const onResizePointerDown = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { dir, x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, w: size.w, h: size.h };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    let { left, top, w, h } = start;
    if (start.dir.includes("e")) w = clamp(start.w + dx, MIN_W, window.innerWidth - start.left);
    if (start.dir.includes("s")) h = clamp(start.h + dy, MIN_H, window.innerHeight - start.top);
    if (start.dir.includes("w")) {
      const right = start.left + start.w; // the east edge stays fixed
      w = clamp(start.w - dx, MIN_W, right);
      left = right - w;
    }
    if (start.dir.includes("n")) {
      const bottom = start.top + start.h; // the south edge stays fixed
      h = clamp(start.h - dy, MIN_H, bottom);
      top = bottom - h;
    }
    setPos({ left, top });
    setSize({ w, h });
  };
  const onResizePointerUp = () => {
    resizeRef.current = null;
  };

  // nb_changed 2026-11-16 (revision 3): the page box. Enter jumps to the typed page; Escape cancels the edit.
  const commitPageText = (input: HTMLInputElement) => {
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) goToPage(n);
    setEditingPage(false);
    input.blur();
  };

  const go = useCallback(
    (delta: number) => selectChunk(clamp(selected + delta, 0, Math.max(entries.length - 1, 0))), // nb_changed 2026-11-16: was setSelected
    [entries.length, selected, selectChunk],
  );

  if (!open) return null;

  // label for the shown chunk's box: exact, or estimated between neighbouring chunks (dashed on the page)
  const locationNote = current?.chunk ? (current.chunk.bbox_exact ? "מיקום מדויק" : "מיקום משוער (בין קטעים סמוכים)") : "";

  return (
    // nb_changed 2026-11-16 (revision 3): width/height now come from the `size` state (they used to be fixed in CSS)
    <div className="pdf-window" style={{ left: pos.left, top: pos.top, width: size.w, height: size.h }} dir="rtl" role="dialog" aria-label="תוכנית המתאר תא/5500">
      <div
        className="pdf-window__header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <span className="pdf-window__title">תוכנית המתאר תא/5500 – מיקום הקטעים</span>
        <span className="pdf-window__spacer" />
        {/* nb_changed 2026-11-16: the buttons now change the zoom factor (fit-width = 1), not a fixed page scale */}
        <calcite-action icon="minus" scale="s" text="הקטנה" title="הקטנה" onClick={() => setZoom((z) => clamp(+(z - 0.2).toFixed(2), MIN_ZOOM, MAX_ZOOM))}></calcite-action>
        <calcite-action icon="plus" scale="s" text="הגדלה" title="הגדלה" onClick={() => setZoom((z) => clamp(+(z + 0.2).toFixed(2), MIN_ZOOM, MAX_ZOOM))}></calcite-action>
        <calcite-action icon="x" scale="s" text="סגירה" title="סגירה" onClick={onClose}></calcite-action>
      </div>

      {/* nb_changed 2026-11-16 (revision 3): page picker. The number follows the scroll; type a page + Enter to jump to it; the
          arrows go one page back/forward (up/down chevrons: the pages are stacked vertically, whatever the text direction). */}
      <div className="pdf-window__pagebar">
        <calcite-action
          icon="chevron-up"
          scale="s"
          text="עמוד קודם"
          title="עמוד קודם"
          disabled={numPages === 0 || currentPage <= 1 ? true : undefined}
          onClick={() => goToPage(currentPage - 1)}
        ></calcite-action>
        <span>עמוד</span>
        <input
          className="pdf-window__pageinput"
          type="number"
          min={1}
          max={numPages || undefined}
          disabled={numPages === 0}
          value={editingPage ? pageText : numPages ? currentPage : ""}
          aria-label="מעבר לעמוד"
          onFocus={(e) => {
            setPageText(String(currentPage));
            setEditingPage(true);
            e.currentTarget.select();
          }}
          onChange={(e) => setPageText(e.target.value)}
          onBlur={() => setEditingPage(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPageText(e.currentTarget);
            else if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
        <span>/ {numPages || "…"}</span>
        <calcite-action
          icon="chevron-down"
          scale="s"
          text="עמוד הבא"
          title="עמוד הבא"
          disabled={numPages === 0 || currentPage >= numPages ? true : undefined}
          onClick={() => goToPage(currentPage + 1)}
        ></calcite-action>
      </div>

      {loadError && <div className="pdf-window__error">{loadError}</div>}

      {/* nb_changed 2026-11-16: the PDF is always shown; with no hits yet only a one-line hint is added above it
          (it used to replace the whole window with an empty message). */}
      {entries.length === 0 && (
        <div className="pdf-window__hint">שאל שאלה על תוכנית המתאר בצ'אט, והקטעים שיוחזרו יסומנו כאן. אפשר גם לגלול בתוכנית.</div>
      )}

      {entries.length > 0 && (
        <>
          <div className="pdf-window__nav">
            <calcite-button scale="s" appearance="outline" disabled={selected <= 0 ? true : undefined} onClick={() => go(-1)}>הקודם</calcite-button>
            <span className="pdf-window__counter">קטע {selected + 1} / {entries.length}</span>
            <calcite-button scale="s" appearance="outline" disabled={selected >= entries.length - 1 ? true : undefined} onClick={() => go(1)}>הבא</calcite-button>
            {currentPages.length > 1 && (
              <span className="pdf-window__pages">
                עמודים:
                {/* nb_changed 2026-11-16: a button now scrolls to that page's box of the chunk (was: switch the shown page) */}
                {currentPages.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      const region = current?.regions.find((r) => r.pdf_page === p);
                      if (region) scrollToRegion(region);
                    }}
                  >
                    {p}
                  </button>
                ))}
              </span>
            )}
          </div>

          <div className="pdf-window__chips">
            {entries.map((entry, i) => (
              <button
                key={entry.hit.id}
                type="button"
                className={`${i === selected ? "on" : ""}${entry.regions.length ? "" : " nomap"}`}
                title={entry.regions.length ? entry.hit.id : `${entry.hit.id} – אין מיקום בקובץ ה-PDF`}
                onClick={() => selectChunk(i)}
              >
                {i + 1} · {entry.hit.id}
              </button>
            ))}
          </div>
        </>
      )}

      {/* nb_changed 2026-11-16: the scroll area with ALL pages (was one canvas for the chosen page). The pages are LTR so the
          absolute left/top offsets of the boxes match the PDF coordinates. */}
      <div className="pdf-window__viewer" ref={setViewerEl} onScroll={onViewerScroll}> {/* nb_changed 2026-11-16 (revision 3): onScroll feeds the page box and the reading place */}
        <div className="pdf-window__column" dir="ltr">
          {pdf &&
            layout &&
            layout.map((page, n) => (
              <PdfPage
                key={n + 1}
                pdf={pdf}
                pageNumber={n + 1}
                scale={page.scale}
                width={page.width}
                height={page.height}
                root={viewerEl}
              >
                <div className="pdf-window__overlay">
                  {(boxesByPage.get(n + 1) ?? []).map(({ key, i, entry, r }) => (
                    <div
                      key={key}
                      className={`pdf-box${i === selected ? " pdf-box--sel" : ""}${entry.chunk?.bbox_exact === false ? " pdf-box--est" : ""}`}
                      style={{
                        left: `${(r.x0 / r.page_w) * 100}%`,
                        top: `${(r.y0 / r.page_h) * 100}%`,
                        width: `${((r.x1 - r.x0) / r.page_w) * 100}%`,
                        height: `${((r.y1 - r.y0) / r.page_h) * 100}%`,
                      }}
                      title={`#${i + 1} ${entry.hit.id}`}
                      onClick={() => selectChunk(i)}
                    />
                  ))}
                </div>
              </PdfPage>
            ))}
        </div>
      </div>

      {entries.length > 0 && (
        <div className="pdf-window__details">
          {current && !current.regions.length ? (
            <div className="pdf-window__error">אין מיקום בקובץ ה-PDF עבור הקטע {current.hit.id}.</div>
          ) : (
            <div className="pdf-window__meta">{current?.hit.id} · עמוד {currentPages[0] ?? ""} · {locationNote}</div>
          )}
          {current?.chunk?.text && <div className="pdf-window__text" dir="auto">{current.chunk.text}</div>}
        </div>
      )}

      {/* nb_changed 2026-11-16 (revision 3): grab zones on all four edges and corners to resize the window (replaces the browser's
          small resize triangle, which sat in the bottom-LEFT corner of this RTL window, over the chunk text). */}
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`pdf-resize pdf-resize--${dir}`}
          onPointerDown={onResizePointerDown(dir)}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ))}
    </div>
  );
}
