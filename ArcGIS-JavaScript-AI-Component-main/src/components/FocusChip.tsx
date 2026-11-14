import { useEffect, useRef, useSyncExternalStore } from "react";
import { focusStore } from "../ta5500/focus";
import { getView, resetFocus } from "../ta5500/mapFocus";

const CLEAR_FOCUS_LABEL = "נקה מיקוד";

/** Clears the active TA5500 map focus; never rejects (a click must not cause an unhandled rejection). */
export async function clearFocusSafely(): Promise<void> {
  try {
    const view = getView();
    if (view) await resetFocus(view);
    else focusStore.clear();
  } catch (e) {
    console.error("clear focus failed", e);
    focusStore.clear();
  }
}

/** Closable chip showing the active map focus; renders nothing when no focus is set. */
export function FocusChip() {
  const focus = useSyncExternalStore(focusStore.subscribe, focusStore.get);
  const chipRef = useRef<HTMLElement>(null);
  const active = focus !== null;

  useEffect(() => {
    const el = chipRef.current as any;
    if (!el) return;
    el.messageOverrides = { close: CLEAR_FOCUS_LABEL };
    const handler = () => void clearFocusSafely();
    el.addEventListener("calciteChipClose", handler);
    return () => el.removeEventListener("calciteChipClose", handler);
  }, [active]);

  if (!focus) return null;
  return (
    <div className="focus-chip" dir="rtl" style={{ padding: "6px 8px" }}>
      <calcite-chip
        ref={chipRef}
        key={focus.label}
        closable
        scale="s"
        kind="brand"
        appearance="outline-fill"
        label={focus.label}
        title={focus.label}
      >
        {focus.label}
      </calcite-chip>
    </div>
  );
}
