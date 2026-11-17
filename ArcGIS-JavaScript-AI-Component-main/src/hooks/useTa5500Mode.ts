import { useEffect, useState } from "react";
import type MapView from "@arcgis/core/views/MapView.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
import type Polygon from "@arcgis/core/geometry/Polygon.js";
import * as projectOperator from "@arcgis/core/geometry/operators/projectOperator.js";
import { captureBaseline, getView, listCatalog, listTa5500Layers, rememberAuthoredEffects, telAvivExtent } from "../ta5500/mapFocus";
import { baselineStore } from "../ta5500/baseline";
import { focusStore } from "../ta5500/focus";

const EXTENT_EXPAND = 1.3;

/**
 * TA5500 mode (spec §5.1): true when the loaded web map contains the plan's
 * planning-areas layer. While true, lateral navigation is constrained to the
 * Tel Aviv-Yafo extent (layer union, expanded) as a backstop; the previous
 * constraint is restored when the mode ends, the map changes or on unmount.
 * When the mode ends or the map changes, the plan focus store is cleared (the old view's outline layer goes
 * with the old map; resetFocus is not called on a view that may already be destroyed).
 */
export function useTa5500Mode(isMapReady: boolean, webMapId: string): boolean {
  const [isTa5500, setIsTa5500] = useState(false);

  useEffect(() => {
    setIsTa5500(false);
    if (!isMapReady || !webMapId) return;

    let cancelled = false;
    let constrainedView: MapView | null = null;
    let previousGeometry: Extent | Polygon | null = null;

    const run = async () => {
      const view = getView();
      if (!view) return;
      try {
        await view.when();
      } catch {
        return;
      }
      if (cancelled || view.destroyed) return;

      const areas = listTa5500Layers(view).get("areas") ?? [];
      if (!areas.length) return;
      // Before any agent touches the layers: keep the web map's own featureEffects for reset (mapFocus).
      rememberAuthoredEffects(view);
      captureBaseline(view);
      const catalog = listCatalog(view);
      console.debug(`ta5500 catalog: ${catalog.length} layers in ${new Set(catalog.map((e) => e.group)).size} groups`);
      setIsTa5500(true);

      // fullExtent needs the layers loaded; projection may be needed if the
      // layer's spatial reference differs from the view's.
      await Promise.all([
        ...areas.map((layer) => layer.load().catch(() => undefined)),
        projectOperator.load().catch(() => undefined),
      ]);
      if (cancelled || view.destroyed) return;

      const extent = telAvivExtent(view);
      if (!extent) return;
      previousGeometry = view.constraints.geometry ? view.constraints.geometry.clone() : null;
      view.constraints.geometry = extent.clone().expand(EXTENT_EXPAND);
      constrainedView = view;
    };

    void run();

    return () => {
      cancelled = true;
      focusStore.clear();
      baselineStore.clear();
      const view = constrainedView;
      if (view && !view.destroyed) {
        view.constraints.geometry = previousGeometry;
      }
    };
  }, [isMapReady, webMapId]);

  return isTa5500;
}
