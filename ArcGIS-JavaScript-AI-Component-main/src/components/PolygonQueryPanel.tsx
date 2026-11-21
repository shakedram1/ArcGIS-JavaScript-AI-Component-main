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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PolygonQueryResult | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  // Layer visibility is mutated on the map; this just forces a re-render of the checkboxes.
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
        setResult(r);
        setError(null);
        setVisibility(Object.fromEntries(r.groups.flatMap((g) => g.layers.map((l) => [l.id, l.visible]))));
      },
      setBusy,
      setError,
      setDrawing,
    );
    controllerRef.current = controller;

    return () => {
      controller.destroy();
      controllerRef.current = null;
      setResult(null);
      setDrawing(false);
      setBusy(false);
    };
  }, [isMapReady, webMapId, mapElementRef]);

  // A drawn polygon becomes the assistant's focus; any other state (cleared, boundary mode) drops it.
  useEffect(() => {
    const polygon = result?.mode === "manual" ? controllerRef.current?.getPolygon() : null;
    if (polygon) void setFocusPolygon(polygon, () => loadGisCodes(resolveArcgisMcpBaseUrl()));
    else clearFocus();
  }, [result]);

  const handleDraw = () => {
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
  };

  const toggleLayer = (id: string, visible: boolean) => {
    controllerRef.current?.setLayerVisible(id, visible);
    setVisibility((prev) => ({ ...prev, [id]: visible }));
  };

  const working = busy || !!exporting;
  const exportLabel = result?.mode === "manual"
    ? "הפקת דף מידע מתארי"
    : "הפקת דף מידע מתארי: יש לשרטט גבול תחילה";

  return (
    <>
      {children(
        <>
          <div slot="top-left" className="pdf-toggle">
            <calcite-action
              icon={drawing ? "x" : "polygon"}
              text={drawing ? "ביטול שרטוט" : "שרטוט גבול תכנית לבדיקה"}
              title={drawing ? "ביטול שרטוט" : "שרטוט גבול תכנית לבדיקה"}
              disabled={!isMapReady || working ? true : undefined}
              onClick={handleDraw}
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
        <div className="pq-panel" dir="rtl">
          {(result || error) && (
            <calcite-button appearance="outline" kind="neutral" icon-start="trash" disabled={working ? true : undefined} onClick={handleClear}>
              ניקוי
            </calcite-button>
          )}

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
                  </summary>
                  {!g.found && <p className="pq-empty">לא נמצאה קבוצת שכבות בשם זה במפה</p>}
                  {g.found && g.layers.length === 0 && <p className="pq-empty">אין שכבות בקבוצה</p>}
                  {g.layers.map((l) => (
                    <label key={l.id} className={`pq-layer${l.count === 0 ? " pq-layer--none" : ""}`}>
                      <input
                        type="checkbox"
                        checked={visibility[l.id] ?? false}
                        onChange={(e) => toggleLayer(l.id, e.target.checked)}
                      />
                      <span className="pq-layer-title">{l.title}</span>
                      <span className="pq-count">{l.count}</span>
                    </label>
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
