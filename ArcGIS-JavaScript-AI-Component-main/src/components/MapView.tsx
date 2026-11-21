import React, { useEffect } from "react";

interface MapViewProps {
  webMapId: string;
  mapElementRef: React.RefObject<HTMLElement & Record<string, unknown>>;
  homeElementRef: React.RefObject<HTMLElement & Record<string, unknown>>;
  onTogglePdf: () => void; // nb_changed 2026-11-16: opens/closes the TA5500 PDF viewer window
  children?: React.ReactNode;
}

/**
 * Renders the arcgis-map element with its default widget slots.
 * Also manages mutual-exclusion between the expand widgets so that
 * opening one automatically collapses the others.
 */
export function MapView({ webMapId, mapElementRef, homeElementRef, onTogglePdf, children }: MapViewProps) { // nb_changed 2026-11-16: + onTogglePdf
  const layersExpandRef = React.useRef<HTMLElement & { expanded?: boolean }>(null);
  const basemapExpandRef = React.useRef<HTMLElement & { expanded?: boolean }>(null);
  const legendExpandRef = React.useRef<HTMLElement & { expanded?: boolean }>(null);
  const distanceExpandRef = React.useRef<HTMLElement & { expanded?: boolean }>(null);
  const areaExpandRef = React.useRef<HTMLElement & { expanded?: boolean }>(null);

  // Collapse sibling expands when one opens
  useEffect(() => {
    const expandEls = [
      layersExpandRef.current,
      basemapExpandRef.current,
      legendExpandRef.current,
      distanceExpandRef.current,
      areaExpandRef.current,
    ];
    const cleanups: (() => void)[] = [];

    expandEls.forEach((el, i) => {
      if (!el) return;
      const others = expandEls.filter((_, j) => j !== i);
      const handler = (event: Event) => {
        const e = event as CustomEvent<{ name: string }>;
        if (e.detail?.name === "expanded" && el.expanded) {
          others.forEach((other) => {
            if (other) other.expanded = false;
          });
        }
      };
      el.addEventListener("arcgisPropertyChange", handler);
      cleanups.push(() => el.removeEventListener("arcgisPropertyChange", handler));
    });

    return () => cleanups.forEach((fn) => fn());
  }, [webMapId]);

  return (
    <arcgis-map
      key={webMapId || "empty-webmap"}
      ref={mapElementRef as React.Ref<any>}
      id="main-map"
      className="ds-map"
    >
      <arcgis-zoom slot="top-left" />
      <arcgis-home ref={homeElementRef as React.Ref<any>} slot="top-left" />
      <arcgis-expand
        ref={layersExpandRef as React.Ref<any>}
        slot="top-left"
        expand-icon="layers"
        collapse-icon="x"
      >
        <arcgis-layer-list />
      </arcgis-expand>
      <arcgis-expand
        ref={basemapExpandRef as React.Ref<any>}
        slot="top-left"
        expand-icon="basemap"
        collapse-icon="x"
      >
        <arcgis-basemap-gallery />
      </arcgis-expand>
      {/* nb_changed 2026-11-16: map button (top-left widget column) that opens/closes the TA5500 PDF viewer window.
          arcgis-placement is not available in this SDK version, so a plain slotted element carries the button. */}
      <div slot="top-left" className="pdf-toggle">
        <calcite-action
          text="הוראות תכנית המתאר"
          title="הוראות תכנית המתאר"
          onClick={onTogglePdf}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M4.5 2.5h11l4 4v15h-15zM15.5 2.5v4h4" />
            <path d="M7.5 10h9M7.5 13.5h9M7.5 17h9" />
          </svg>
        </calcite-action>
      </div>
      {children}
      <arcgis-expand
        ref={distanceExpandRef as React.Ref<any>}
        slot="top-left"
        expand-icon="measure-line"
        collapse-icon="x"
      >
        <arcgis-distance-measurement-2d unit="metric" />
      </arcgis-expand>
      <arcgis-expand
        ref={areaExpandRef as React.Ref<any>}
        slot="top-left"
        expand-icon="measure-area"
        collapse-icon="x"
      >
        <arcgis-area-measurement-2d unit="metric" />
      </arcgis-expand>
      <arcgis-expand
        ref={legendExpandRef as React.Ref<any>}
        slot="bottom-left"
        expand-icon="legend"
        collapse-icon="x"
      >
        <arcgis-legend />
      </arcgis-expand>
    </arcgis-map>
  );
}
