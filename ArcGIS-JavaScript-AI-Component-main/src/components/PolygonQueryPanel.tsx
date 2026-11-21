import React, { useEffect, useRef, useState } from "react";
import { loadGisCodes } from "../agents/McpPassthroughAgent";
import { resolveArcgisMcpBaseUrl } from "../utils/arcgisMcp";
import { clearFocus, setFocusPolygon } from "../utils/focusStore";
import {
  PolygonGroupQueryController,
  QUERY_BUFFER_METERS,
  type PolygonQueryResult,
} from "../utils/polygonGroupQuery";

interface PolygonQueryPanelProps {
  mapElementRef: React.RefObject<HTMLElement & Record<string, unknown>>;
  isMapReady: boolean;
  webMapId: string;
  children: (controls: React.ReactNode) => React.ReactNode;
}

/**
 * Draw a polygon → 100 m buffer → show relevant planning layers and export a planning-info sheet.
 */
export function PolygonQueryPanel({ mapElementRef, isMapReady, webMapId, children }: PolygonQueryPanelProps) {
  const controllerRef = useRef<PolygonGroupQueryController | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [polygonExists, setPolygonExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PolygonQueryResult | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});

  const runExport = async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    setError(null);
    setExporting("מתחיל…");
    try {
      await controller.exportInfoSheet((msg) => setExporting(msg));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMinimized(false);
    } finally {
      setExporting(null);
    }
  };
  useEffect(() => {
    const view = (mapElementRef.current as any)?.view;
    if (!isMapReady || !view?.map) return;

    const controller = new PolygonGroupQueryController(
      view,
      (r) => {
        const displayResult = controller.getDisplayResult(r);
        const nextVisibility = controller.getVisibility();
        setResult(displayResult);
        setError(null);
        setVisibility(nextVisibility);
      },
      setBusy,
      (message) => {
        setError(message);
        setMinimized(false);
      },
      setDrawing,
      (key, visible) => setVisibility((prev) => ({ ...prev, [key]: visible })),
      setPolygonExists,
    );
    controllerRef.current = controller;

    return () => {
      controller.destroy();
      controllerRef.current = null;
      setResult(null);
      setDrawing(false);
      setBusy(false);
      setMinimized(false);
      setPosition(null);
    };
  }, [isMapReady, webMapId, mapElementRef]);

  // A drawn polygon becomes the assistant's focus; any other state (cleared, boundary mode) drops it.
  useEffect(() => {
    const polygon = result?.mode === "manual" ? controllerRef.current?.getPolygon() : null;
    if (polygon) void setFocusPolygon(polygon, () => loadGisCodes(resolveArcgisMcpBaseUrl()));
    else clearFocus();
  }, [result]);

  const handleDraw = () => {
    setMinimized(false);
    setResult(null);
    setError(null);
    if (drawing) controllerRef.current?.cancelDrawing();
    else controllerRef.current?.startDrawing();
  };

  const handleClear = () => {
    controllerRef.current?.clear();
    setResult(null);
    setError(null);
    setDrawing(false);
    setMinimized(false);
  };

  const toggleLayer = (id: string, visible: boolean) => {
    controllerRef.current?.setLayerVisible(id, visible);
    setVisibility((prev) => ({ ...prev, [id]: visible }));
  };

  const toggleGroup = (key: string, visible: boolean) => {
    controllerRef.current?.setGroupVisible(key, visible);
    setVisibility((prev) => ({ ...prev, [key]: visible }));
  };

  const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("calcite-action, button")) return;
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPosition({
      left: Math.max(0, Math.min(event.clientX - dragRef.current.dx, window.innerWidth - 140)),
      top: Math.max(0, Math.min(event.clientY - dragRef.current.dy, window.innerHeight - 48)),
    });
  };

  const working = busy || !!exporting;
  const drawLabel = drawing
    ? "ביטול שרטוט"
    : polygonExists
      ? minimized ? "הצגת תוצאות השרטוט" : "מזעור תוצאות השרטוט"
      : "שרטוט גבול תכנית לבדיקה";
  const exportLabel = result?.mode === "manual"
    ? "הפקת דף מידע מתארי"
    : "הפקת דף מידע מתארי: יש לשרטט גבול תחילה";

  return (
    <>
      {children(
        <>
          <div slot="top-left" className={`pdf-toggle pq-draw-toggle${polygonExists ? " pq-draw-toggle--active" : ""}`}>
            <calcite-action
              icon={drawing ? "x" : "polygon"}
              text={drawLabel}
              title={drawLabel}
              aria-expanded={polygonExists ? !minimized : undefined}
              disabled={!isMapReady || (working && !polygonExists) ? true : undefined}
              onClick={() => polygonExists ? setMinimized((value) => !value) : handleDraw()}
            />
          </div>
          <div slot="top-left" className="pdf-toggle">
            <calcite-action
              text={exportLabel}
              title={exportLabel}
              disabled={!isMapReady || working || drawing || result?.mode !== "manual" ? true : undefined}
              onClick={() => void runExport()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M4.5 2.5h11l4 4v15h-15zM15.5 2.5v4h4" />
                <circle cx="12" cy="10" r="0.8" fill="currentColor" stroke="none" />
                <path d="M12 12v5" strokeWidth="1.5" />
              </svg>
            </calcite-action>
          </div>
        </>,
      )}
      {isMapReady && (drawing || busy || exporting || error || result) && (
        <div className="pq-panel" dir="rtl" hidden={minimized} style={position ? { position: "fixed", left: position.left, top: position.top, bottom: "auto" } : undefined}>
          <div
            className="pq-header"
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={() => { dragRef.current = null; }}
            onPointerCancel={() => { dragRef.current = null; }}
          >
            <span>בדיקת הוראות התכנית</span>
            {polygonExists && (
              <calcite-action icon="polygon" text="שרטוט גבול חדש" title="שרטוט גבול חדש" scale="s" disabled={working ? true : undefined} onClick={handleDraw} />
            )}
            {(result || error) && (
              <calcite-action icon="trash" text="ניקוי שרטוט" title="ניקוי שרטוט" scale="s" disabled={working ? true : undefined} onClick={handleClear} />
            )}
            {polygonExists && (
              <calcite-action icon="chevron-down" text="מזעור תוצאות השרטוט" title="מזעור תוצאות השרטוט" scale="s" onClick={() => setMinimized(true)} />
            )}
          </div>

          {drawing && <p className="pq-hint">ניתן להוסיף קודקודים בלחיצה על המפה. לחיצה כפולה מסיימת את הפוליגון.</p>}
          {busy && <p className="pq-hint">מתבצעת שאילתה מרחבית (באפר {QUERY_BUFFER_METERS} מ׳)…</p>}
          {exporting && <p className="pq-hint">{exporting}</p>}
          {error && <p className="pq-error">{error}</p>}

          {result && (
            <div className="pq-groups">
              <p className="pq-hint">
                תוצאות ל{result.mode === "boundary" ? "גבול התכנית" : "פוליגון"} + באפר {QUERY_BUFFER_METERS} מ׳
              </p>
              {result.groups.map((g) => (
                <details key={g.key} className="pq-group" open={g.found && g.layers.some((l) => l.count > 0)}>
                  <summary>
                    {g.label}
                    {g.found && <span className="pq-badge">{g.layers.filter((l) => l.count > 0).length}</span>}
                    {g.found && (
                      <calcite-action
                        icon={visibility[g.key] ? "view-visible" : "view-hide"}
                        text={`${visibility[g.key] ? "הסתרת" : "הצגת"} ${g.label}`}
                        title={`${visibility[g.key] ? "הסתרת" : "הצגת"} ${g.label}`}
                        scale="s"
                        disabled={working ? true : undefined}
                        onClick={(event: React.MouseEvent) => {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleGroup(g.key, !visibility[g.key]);
                        }}
                      />
                    )}
                  </summary>
                  {!g.found && <p className="pq-empty">לא נמצאה קבוצת שכבות בשם זה במפה</p>}
                  {g.found && g.layers.length === 0 && <p className="pq-empty">אין שכבות בקבוצה</p>}
                  {g.layers.map((l) => (
                    <div key={l.id} className={`pq-layer${l.count === 0 ? " pq-layer--none" : ""}`}>
                      <span className="pq-layer-title">{l.title}</span>
                      <span className="pq-count">{l.count}</span>
                      <calcite-action
                        icon={visibility[l.id] ? "view-visible" : "view-hide"}
                        text={`${visibility[l.id] ? "הסתרת" : "הצגת"} ${l.title}`}
                        title={`${visibility[l.id] ? "הסתרת" : "הצגת"} ${l.title}`}
                        scale="s"
                        disabled={working ? true : undefined}
                        onClick={() => toggleLayer(l.id, !visibility[l.id])}
                      />
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
