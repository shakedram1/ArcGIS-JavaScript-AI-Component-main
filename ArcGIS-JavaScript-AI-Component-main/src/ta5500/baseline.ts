// The map's startup state (layer visibility and viewpoint), captured when TA5500 mode starts; "reset" returns to it.
// Pure: no @arcgis/* runtime imports, no DOM.
export type MapBaseline = { visibility: Record<string, boolean>; viewpointJson: unknown | null };

let current: MapBaseline | null = null;

export const baselineStore = {
  get: (): MapBaseline | null => current,
  set(b: MapBaseline): void {
    current = b;
  },
  clear(): void {
    current = null;
  },
};

/** The layers whose visibility differs from the baseline, with the baseline value. Layers added after it are left alone. */
export function visibilityChanges(
  baseline: Record<string, boolean>,
  current: { uid: string; visible: boolean }[],
): { uid: string; visible: boolean }[] {
  return current.filter((l) => l.uid in baseline && baseline[l.uid] !== l.visible).map((l) => ({ uid: l.uid, visible: baseline[l.uid] }));
}
