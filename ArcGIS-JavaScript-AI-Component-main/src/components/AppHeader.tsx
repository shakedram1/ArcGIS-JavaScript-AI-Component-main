import React from "react";
import mcpServerIcon from "../../mcpicon.png";
import { ASSISTANT_DESCRIPTION } from "./AssistantPanel";
// nb_changed 2026-11-16: the Tel Aviv and Systematics logos shown at the start of the bar (copies of the files in the project's
// logos folder, kept in src/assets/logos so Vite serves and hashes them like mcpicon.png above).
import taMuniLogo from "../assets/logos/ta-muni-logo.jpeg";
import systematicsLogo from "../assets/logos/systematics-logo.png";

// nb_changed 2026-11-16: credits line shown under the title: a label plus the names of the students who worked on the project
// (in the order they were given).
const CREDITS_LABEL = "הפרויקט בוצע על ידי:";
const STUDENT_NAMES = ["אור גור", "עידו לוטן", "יותם שביט", "רונן גלמנוביץ'", "אסף ארנברג", "שקד רם", "נחמה בריקנר"];

const mcpIconStyle: React.CSSProperties = {
  width: "22px",
  height: "22px",
  display: "block",
  backgroundColor: "#007ac2",
  WebkitMaskImage: `url(${mcpServerIcon})`,
  maskImage: `url(${mcpServerIcon})`,
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskSize: "contain",
  maskSize: "contain",
};

const actionButtonScale = "m" as const;

export interface AppHeaderProps {
  /** Rendered title text */
  headerTitle: string;
  /** Rendered subtitle text. Pass null or empty to hide. */
  headerSubtitle: string;
  /** CSS font-family for title/subtitle */
  headerFontFamily: string;
  /** CSS background (gradient or hex) for the header bar — unused in the glass design, kept for theme-editor compatibility */
  headerBackground: string;
  /** CSS color for the bottom border — unused in the glass design, kept for theme-editor compatibility */
  headerBorderColor: string;
  /** CSS color for the title */
  headerTextColor: string;
  /** CSS color for the subtitle */
  headerSubtitleColor: string;
  /** Whether the session is signed in and the actions should be shown */
  isSignedIn: boolean;
  /** Whether the map picker / startup screen is showing (hides title copy) */
  isStartupPage: boolean;
  /** App mode — "edit" enables the theme-editor button */
  appMode: "default" | "edit";
  /** Currently loaded WebMap item ID (empty string = none) */
  webMapId: string;
  /** Show the hidden "regenerate embeddings" button */
  showEmbeddingRegenerateButton: boolean;
  /** Whether an embedding operation is in flight */
  isEmbeddingBusy: boolean;
  /** Slot for the account dropdown rendered by the parent */
  accountMenuSlot: React.ReactNode;
  onOpenThemeEditor: () => void;
  onChangeWebMap: () => void;
  onRegenerateEmbeddings: () => void;
  /** Click handler for the MCP button; receives the native mouse event */
  onMcpButtonClick: (event: MouseEvent) => void;
}

/**
 * Floating glass command header, rendered above the full-bleed map.
 */
export function AppHeader({
  headerFontFamily,
  headerTextColor,
  isSignedIn,
  isStartupPage,
  appMode,
  webMapId,
  showEmbeddingRegenerateButton,
  isEmbeddingBusy,
  accountMenuSlot,
  onOpenThemeEditor,
  onChangeWebMap,
  onRegenerateEmbeddings,
  onMcpButtonClick,
}: AppHeaderProps) {
  const shouldShowActions = isSignedIn;

  return (
    <header className="ds-header">
      <div className="ds-header-border">
        <div className="ds-header-inner">
          {/* nb_changed 2026-11-16: the decorative blue spark icon is replaced by the two logos below. The old element is kept here,
              commented out, and its .ds-spark styles are still in styles.css (unused).
          <div className="ds-spark">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3c.4 4 1.6 5.2 5.6 5.6C13.6 9 12.4 10.2 12 14c-.4-3.8-1.6-5-5.6-5.4C10.4 8.2 11.6 7 12 3Z" />
            </svg>
          </div>
          */}

          {/* nb_changed 2026-11-16: logos at the start of the bar. The page is right-to-left, so the first item is on the RIGHT:
              Tel Aviv, then Systematics. The Systematics image is a wide green banner with its text on the right half, so it is
              shown cropped inside a fixed-size tile (see .ds-logo--systematics in styles.css). Shown on the startup page too,
              like the spark icon was. */}
          <div className="ds-header-logos">
            <img className="ds-logo ds-logo--ta" src={taMuniLogo} alt="עיריית תל אביב יפו" title="עיריית תל אביב יפו" />
            <span className="ds-logo ds-logo--systematics" title="Systematics">
              <img src={systematicsLogo} alt="Systematics" />
            </span>
          </div>

          {!isStartupPage && (
            <div className="ds-header-text">
              <span className="ds-header-eyebrow">
                {/* nb_changed 2026-11-17: the text "ArcGIS Maps SDK for JavaScript · " was removed from the start of this line; the old
                    text is kept here, commented out: ArcGIS Maps SDK for JavaScript · */}
                <span className="ds-eyebrow-latin">Systematics</span>
                {/* nb_changed 2026-11-16: the city name added after Systematics (nothing was removed from this line) */}
                {" · "}עיריית תל אביב יפו
              </span>
              <span
                className="ds-header-title"
                style={{ color: headerTextColor, fontFamily: headerFontFamily }}
              >
                {ASSISTANT_DESCRIPTION}
              </span>
              {/* nb_changed 2026-11-16: credits line under the title (the description): label + the students' names. Reuses the
                  existing .ds-header-subtitle style (small, muted, one line with an ellipsis if it does not fit). It sits inside
                  this block, so it is hidden on the startup page together with the title. */}
              <span className="ds-header-subtitle">{CREDITS_LABEL} {STUDENT_NAMES.join(", ")}</span>
            </div>
          )}

          <span className="ds-spacer" />

          {shouldShowActions && !isStartupPage && (
            <div className="app-header-actions">
              {appMode === "edit" && (
                <calcite-button
                  appearance="transparent"
                  icon-start="pencil"
                  scale={actionButtonScale}
                  title="עריכת ערכת נושא"
                  aria-label="עריכת ערכת נושא"
                  className="app-header-icon-button"
                  onClick={onOpenThemeEditor}
                />
              )}

              <calcite-button
                appearance="transparent"
                icon-start="map"
                scale={actionButtonScale}
                title={webMapId ? "החלפת מפת אינטרנט" : "טעינת מפת אינטרנט"}
                aria-label={webMapId ? "החלפת מפת אינטרנט" : "טעינת מפת אינטרנט"}
                className="app-header-icon-button"
                onClick={onChangeWebMap as any}
              />

              {showEmbeddingRegenerateButton && webMapId && (
                <calcite-button
                  appearance="transparent"
                  icon-start="reset"
                  scale={actionButtonScale}
                  className="app-header-icon-button"
                  title="רענון נתוני העוזר"
                  aria-label="רענון נתוני העוזר"
                  onClick={() => {
                    if (!isEmbeddingBusy) onRegenerateEmbeddings();
                  }}
                />
              )}

              <calcite-button
                appearance="transparent"
                scale={actionButtonScale}
                title="ניהול שרתי MCP"
                aria-label="ניהול שרתי MCP"
                className="app-header-icon-button"
                onClick={(event: any) => onMcpButtonClick(event?.nativeEvent ?? event)}
              >
                <span aria-hidden="true" style={mcpIconStyle} />
              </calcite-button>

              {accountMenuSlot}
            </div>
          )}

          <span className="ds-live-badge">
            <span className="ds-live-dot" />
            LIVE
          </span>
        </div>
      </div>
    </header>
  );
}
