import React, { useEffect, useRef, useState } from "react";
import { installAssistantUserBubbleStyler } from "../utils/assistantStyler";
import { FocusChip, clearFocusSafely } from "./FocusChip";
import { focusStore } from "../ta5500/focus";

// ── Hebrew assistant copy ────────────────────────────────────────────────────

// nb_changed 2026-11-16: new description text for the TA5500 planning assistant. This constant is also imported by AppHeader.tsx and
// shown there as the main title of the top bar, so the new text appears in both places. The previous text is kept below, commented out.
// export const ASSISTANT_DESCRIPTION = "תחקור שכבות המפה ומקורות מידע חיצוניים בשפה יומיומית";
export const ASSISTANT_DESCRIPTION = "תחקור שכבות ומסמך תוכנית המתאר תא/5500";
// ArcGIS's own docs say `heading` "should be concise" — it's a short label slot,
// not a sentence, and long values get visually truncated by the component itself.
// nb_changed 2026-11-16: new heading shown at the top of the chat (set on the assistant element by applyAssistantCopy below).
// The previous text is kept, commented out. Note: the component says the heading should be concise, so a long one may be clipped.
// const ASSISTANT_HEADING = "עוזר אישי לרשותך לתחקור המפה וסיכום עיקרי החדשות";
// nb_changed 2026-11-17: the heading (next to the refresh button) is now a short label "התחל שיחה חדשה"; the long text moved to the
// strip above the chat (see ds-eyebrow below). The previous text is kept, commented out.
// const ASSISTANT_HEADING = "עוזר אישי לרשותך לתחקור שכבות ומסמך תוכנית המתאר תא/5500";
const ASSISTANT_HEADING = "התחל שיחה חדשה";
// nb_changed 2026-11-16: new welcome message (two paragraphs separated by \n\n) introducing the TA5500 assistant.
// The previous text is kept below, commented out.
// const ASSISTANT_ENTRY_MESSAGE =
//   "שלום! אני יכול לעזור לך לסייר ולנתח את נתוני המפה.\n\nנסה לשאול על שכבות, סטטיסטיקות, או לנווט לכל מיקום.";
const ASSISTANT_ENTRY_MESSAGE =
  "שלום! אני העוזר החכם לתוכנית המתאר תא/5500. אני משלב בין תשריטי התוכנית, המוצגים במפה, ובין הוראות התוכנית, אותן ניתן לתשאל דרכי.";
// The first chat message: a real assistant message at the top of the conversation (not the built-in entry notice, which is a
// closable info pop-up that disappears after the first question).
const ASSISTANT_FIRST_MESSAGE =
  "שלום! אני העוזר החכם לתוכנית המתאר תא/5500. אני משלב בין תשריטי התוכנית, המוצגים במפה, ובין הוראות התוכנית, אותן ניתן לתשאל דרכי.";
const ASSISTANT_FIRST_MESSAGE_ID = "ta5500-welcome";
const ASSISTANT_SUGGESTED_PROMPTS = [
  "אילו שכבות יש במפה?",
  "כמה ישויות יש בשכבה הראשונה?",
  "מה אני יכול לשאול אותך?",
];

interface AssistantElement extends HTMLElement {
  heading?: string;
  description?: string;
  entryMessage?: string;
  suggestedPrompts?: string[];
  logEnabled?: boolean;
  assistantAvatarEnabled?: boolean;
  clearChatHistory?: () => Promise<void>;
  // nb_changed 2026-11-17: the assistant's chat message list (an ArcGIS Collection); only the two members we use are typed here.
  messages?: {
    length: number;
    push: (message: { id: string; role: "assistant"; blocks: { type: "text"; data: { content: string } }[] }) => unknown;
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface AssistantPanelProps {
  webMapId: string;
  mcpHubRefreshToken: number;
  isMapReady: boolean;
  mapLoadError: string | null;
  mapHasOperationalData: boolean;
  isAssistantPrepared: boolean;
  embeddingsStatusMessage: string | null;
  embeddingsError: string | null;
  chatPanelTitle: string;
  chatPanelBackground: string;
  chatChromeColor: string;
  chatMessageColor: string;
  chatPanelBorderColor: string;
  showEmptyMapAssistantNotice: boolean;
  onDismissEmptyMapNotice: () => void;
  /** TA5500 mode: the built-in navigation agent is replaced by the TA5500 Map agent. */
  isTa5500: boolean;
  /** Show the assistant's agent-execution log in the chat (`?mode=edit`, for routing tests). */
  logEnabled: boolean;
  /** Rendered inside the message box, in its footer next to the send button. */
  footerContent?: React.ReactNode;
}

/**
 * The floating glass AI panel: a card overlaid on the map containing the
 * arcgis-assistant element plus status/error messages and an empty-map notice.
 */
export function AssistantPanel({
  webMapId,
  mcpHubRefreshToken,
  isMapReady,
  mapLoadError,
  mapHasOperationalData,
  isAssistantPrepared,
  embeddingsStatusMessage,
  embeddingsError,
  chatPanelBackground,
  chatChromeColor,
  chatMessageColor,
  chatPanelBorderColor,
  showEmptyMapAssistantNotice,
  onDismissEmptyMapNotice,
  isTa5500,
  logEnabled,
  footerContent,
}: AssistantPanelProps) {
  const assistantRef = useRef<AssistantElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ x: number; width: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState<number>();
  const minWidth = () => Math.min(280, Math.max(0, window.innerWidth - 72));
  const maxWidth = () => Math.max(minWidth(), window.innerWidth - 72);
  const clampWidth = (value: number) => Math.min(Math.max(value, minWidth()), maxWidth());

  // Install the bubble-styler / link opener whenever the assistant is rendered
  useEffect(() => {
    if (!isMapReady || mapLoadError) return;

    const assistant = document.querySelector(
      "arcgis-assistant",
    ) as HTMLElement | null;
    if (!assistant) return;

    return installAssistantUserBubbleStyler(assistant);
  }, [webMapId, isMapReady, mapLoadError]);

  // Push Hebrew heading/description/entry message/suggested prompts onto the
  // assistant element as DOM properties (suggestedPrompts is an array, so it
  // can't be passed as a plain JSX attribute).
  const applyAssistantCopy = () => {
    const el = assistantRef.current;
    if (!el) return;
    el.heading = ASSISTANT_HEADING;
    el.description = ASSISTANT_DESCRIPTION;
    el.entryMessage = ASSISTANT_ENTRY_MESSAGE;
    el.suggestedPrompts = ASSISTANT_SUGGESTED_PROMPTS;
    el.logEnabled = logEnabled;
    // 5.1: shows the blue assistant icon next to each reply (drawn outside the bubble, see assistantStyler.ts)
    el.assistantAvatarEnabled = true;
    // Only while the chat is empty, so repeated calls never duplicate it or insert it after the user has asked something.
    if (el.messages && el.messages.length === 0) {
      // In 5.1 an assistant message is rendered from its `blocks` only; a plain `content` string draws nothing.
      el.messages.push({
        id: ASSISTANT_FIRST_MESSAGE_ID,
        role: "assistant",
        blocks: [{ type: "text", data: { content: ASSISTANT_FIRST_MESSAGE } }],
      });
    }
  };

  // Applying these properties once is unreliable: the custom element isn't
  // always fully upgraded/ready yet right when we set them (worse on a
  // cold/uncached load, e.g. incognito, or right after clearChatHistory()
  // resets internal state), so the assignment can silently get dropped and
  // the component falls back to its own default ("עוזר"). Retry a few times
  // to self-heal.
  const applyAssistantCopyWithRetries = () => {
    applyAssistantCopy();
    const retryDelays = [50, 150, 300, 600, 1000, 2000, 4000];
    const timers = retryDelays.map((delay) => setTimeout(applyAssistantCopy, delay));
    return () => timers.forEach(clearTimeout);
  };

  useEffect(() => {
    const stopRetries = applyAssistantCopyWithRetries();
    // The assistant resets its message list while it initialises and emits arcgisReady afterwards, so add the first
    // message again at that point; the timers above can run before the reset.
    const el = assistantRef.current;
    const onReady = () => applyAssistantCopy();
    el?.addEventListener("arcgisReady", onReady);
    return () => {
      stopRetries();
      el?.removeEventListener("arcgisReady", onReady);
    };
  }, [webMapId, mcpHubRefreshToken, logEnabled, isMapReady, mapLoadError]);

  const handleNewChat = async () => {
    await assistantRef.current?.clearChatHistory?.();
    if (focusStore.get()) await clearFocusSafely();
    // clearChatHistory() also resets heading/description/entryMessage/suggestedPrompts,
    // so they need to be reapplied afterward or the greeting screen renders blank.
    applyAssistantCopyWithRetries();
  };

  const shouldRenderAssistant = isMapReady && !mapLoadError;

  return (
    <div
      ref={panelRef}
      className={`ds-panel${collapsed ? " ds-panel--collapsed" : ""}`}
      id="assistant-panel"
      style={{ width: collapsed ? undefined : width }}
    >
      <div className="ds-glass-border">
        <div className="ds-glass-inner">
          <div className="ds-panel-strip">
            {/* nb_changed 2026-11-17: new strip text (the old one is kept below, commented out). Size is set in styles.css (.ds-eyebrow). */}
            {/* <span className="ds-eyebrow">עוזר AI גיאוגרפי ומעודכן בחדשות הכי חמות</span> */}
            {!collapsed && <span className="ds-eyebrow">עוזר אישי לרשותך לתחקור שכבות ומסמך תוכנית המתאר תא/5500</span>}
            <span className="ds-spacer" />
            {!collapsed && <span className="ds-live-dot" />}
            <calcite-action
              icon={collapsed ? "speech-bubble" : "chevron-right"}
              scale="s"
              text={collapsed ? "הצגת השיחה" : "קיפול השיחה"}
              title={collapsed ? "הצגת השיחה" : "קיפול השיחה"}
              aria-expanded={!collapsed}
              aria-controls="assistant-panel-body"
              onClick={() => setCollapsed((value) => !value)}
            ></calcite-action>
          </div>
          <div className="ds-panel-body" id="assistant-panel-body" hidden={collapsed}>
            <div
              className="chat-panel-theme"
              style={{
                backgroundColor: chatPanelBackground,
                color: chatMessageColor,
                borderColor: chatPanelBorderColor,
              }}
            >
              {mapLoadError ? (
                <calcite-notice open kind="danger">
                  <div slot="title">טעינת המפה נכשלה</div>
                  <div slot="message">{mapLoadError}</div>
                </calcite-notice>
              ) : !isMapReady ? (
                <calcite-notice open kind="info">
                  <div slot="title">טוען מפה</div>
                  <div slot="message">העוזר יופיע לאחר שתצוגת מפת האינטרנט תהיה מוכנה.</div>
                </calcite-notice>
              ) : (
                <>
                  {!mapHasOperationalData && showEmptyMapAssistantNotice && (
                    <calcite-notice open kind="info" closable onCalciteNoticeClose={onDismissEmptyMapNotice}>
                      <div slot="message">
                        המפה הזו ריקה, ולכן ניווט במפה וחקר נתונים מושבתים עד שיתווספו שכבות או טבלאות.
                        תהליכי עבודה מבוססי MCP ותהליכים מותאמים אישית עדיין זמינים.
                      </div>
                    </calcite-notice>
                  )}

                  {mapHasOperationalData && !isAssistantPrepared && !embeddingsError && (
                    <calcite-notice open kind="info">
                      <div slot="title">מכין כלי עוזר מודעי-מפה</div>
                      <div slot="message">
                        {embeddingsStatusMessage ||
                          "נתוני העוזר הספציפיים למפה עדיין בהכנה. תהליכי עבודה מבוססי MCP ותהליכים מותאמים אישית עדיין זמינים."}
                      </div>
                    </calcite-notice>
                  )}

                  {isTa5500 && <FocusChip />}

                  {shouldRenderAssistant && (
                    <arcgis-assistant
                      key={`${webMapId || "no-map"}:${mcpHubRefreshToken}`}
                      ref={assistantRef}
                      reference-element="#main-map"
                      class="chat-panel-theme__assistant"
                      style={{
                        backgroundColor: chatPanelBackground,
                        color: chatMessageColor,
                        border: "none",
                        borderRadius: "14px",
                        padding: 0,
                        ["--app-chat-panel-bg" as string]: chatPanelBackground,
                        ["--app-chat-chrome-text" as string]: chatChromeColor,
                        ["--app-chat-message-text" as string]: chatMessageColor,
                        ["--app-chat-panel-border" as string]: chatPanelBorderColor,
                      } as React.CSSProperties}
                    >
                      <calcite-action
                        slot="header-actions-end"
                        icon="reset"
                        text="שיחה חדשה"
                        title="שיחה חדשה"
                        onClick={() => void handleNewChat()}
                      ></calcite-action>
                      {footerContent && <div slot="entry-actions-start">{footerContent}</div>}
                      <arcgis-assistant-help-agent></arcgis-assistant-help-agent>
                      {!isTa5500 && <arcgis-assistant-navigation-agent></arcgis-assistant-navigation-agent>}
                      <arcgis-assistant-data-exploration-agent></arcgis-assistant-data-exploration-agent>
                      {/* Custom agents are appended programmatically by useAssistantSetup */}
                    </arcgis-assistant>
                  )}
                </>
              )}

              {embeddingsError && (
                <calcite-notice open kind="danger">
                  <div slot="message">{embeddingsError}</div>
                </calcite-notice>
              )}
            </div>
          </div>
          {!collapsed && (
            <div
              className="ds-panel-resize"
              role="separator"
              aria-label="שינוי רוחב השיחה"
              aria-orientation="vertical"
              aria-valuemin={minWidth()}
              aria-valuemax={maxWidth()}
              aria-valuenow={Math.round(Math.min(width ?? (logEnabled ? 620 : 400), window.innerWidth - 72))}
              tabIndex={0}
              onPointerDown={(event) => {
                resizeRef.current = { x: event.clientX, width: panelRef.current?.getBoundingClientRect().width ?? 400 };
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                const start = resizeRef.current;
                if (start) setWidth(clampWidth(start.width + start.x - event.clientX));
              }}
              onPointerUp={() => { resizeRef.current = null; }}
              onPointerCancel={() => { resizeRef.current = null; }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const current = panelRef.current?.getBoundingClientRect().width ?? 400;
                setWidth(clampWidth(current + (event.key === "ArrowLeft" ? 16 : -16)));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
