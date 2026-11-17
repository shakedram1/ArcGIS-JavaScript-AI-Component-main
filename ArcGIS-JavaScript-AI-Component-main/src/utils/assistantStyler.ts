// CSS injected into shadow roots of arcgis-assistant and its chat cards.

const ASSISTANT_USER_BUBBLE_STYLE_ID = "assistant-user-bubble-wrap-style";
const ASSISTANT_USER_BUBBLE_CSS = `
.assistant-chat-card__prompt-container {
  max-width: min(100%, 34rem) !important;
  width: auto !important;
  box-sizing: border-box;
  align-items: flex-start;
}

.assistant-chat-card__prompt-container > div:first-child {
  min-width: 0;
  white-space: normal !important;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.45;
}

/* The component hardcodes text-align:left on its own response container
   (not text-align:start), so it never follows the app's dir="rtl" — Hebrew
   assistant replies stayed left-aligned even though the user's own prompt
   bubble (aligned via margin-left:auto, a layout property) looked correct. */
.assistant-chat-card__response-container {
  align-items: flex-end !important;
  text-align: right !important;
}

/* nb_changed 2026-11-17: thin outline on every chat bubble. The class is written twice on purpose: it raises the specificity so these
   border colours win over the theme rule below (ASSISTANT_THEME_CSS), which forces border-color on every [class*="container"] and
   [class*="prompt"] element with !important. Nothing above was removed or changed. */

/* nb_changed 2026-11-17: USER bubble - thin light-grey outline (the user's avatar colour is generated from their name and is too
   pale to be seen as a line, so a fixed light grey is used) and offset 0.5cm in from the right edge. The component keeps
   margin-left:auto, so the bubble stays right-aligned, just 0.5cm in. The component's own border-radius is kept. */
/* nb_changed 2026-11-17 (second pass): outline is now 2px and in Calcite's default avatar grey #f3f3f3 (an experiment to see how the
   avatar grey looks; it is very pale on a white panel). The corners are much rounder: 24px (the component's own radius is
   var(--calcite-border-radius), about 4px). The previous 1px #cacaca line is kept below, commented out. */
.assistant-chat-card__prompt-container.assistant-chat-card__prompt-container {
  /* border: 1px solid #cacaca !important; */
  /* border: 2px solid #f3f3f3 !important; */
  /* nb_changed 2026-11-17 (third pass): outline colour is now #E8E6F8 (the previous #f3f3f3 line is kept above, commented out). */
  /* border: 2px solid #E8E6F8 !important; */
  /* border-radius: 24px !important; */
  /* margin-right: 0.5cm !important; */
  /* nb_changed 2026-11-17 (fourth pass): new design "המיקס" (square corner + light fills + 1.5px outline). The outline/fill now belong to
     the text part of the card (rule right below), so the avatar sits OUTSIDE the bubble like in the mock-up. This container is made
     invisible: no border, radius or padding, and a transparent background (the theme rule below forces a white background on it with
     !important, hence !important here too). The 0.5cm right offset is switched off (the mock-up has none); restore it by un-commenting
     the margin-right line above. The three old values above are kept as comments. */
  border: 0 !important;
  border-radius: 0 !important;
  padding: 0 !important;
  background: transparent !important;
}

/* nb_changed 2026-11-17 (fourth pass): the USER bubble itself = the text part of the card. Light lavender fill, 1.5px outline, 14px
   corners, and the corner next to the avatar (top-right; the avatar is on the right) squared to 4px. The class is doubled for specificity. */
.assistant-chat-card__prompt-container.assistant-chat-card__prompt-container > div:first-child {
  background: #f6f5fd;
  border: 1.5px solid #c9c5ee;
  border-radius: 14px;
  border-top-right-radius: 4px;
  padding: 10px 14px;
}

/* nb_changed 2026-11-17 (third pass): the user's avatar circle moves to the other side of its text. The card is a flex row
   [text][avatar]; on this right-to-left page the first item (text) sits on the right, so the avatar was on the left. order:-1 makes the
   avatar the first item, which places it on the right (the start side), next to the text, like the assistant's icon below. */
.assistant-chat-card__prompt-avatar {
  order: -1;
}

/* nb_changed 2026-11-17: ASSISTANT bubble (icon + text + footer) - thin blue outline using the same colour token as the blue circle
   icon (--calcite-color-brand). The assistant had no box before, so a border radius (same as the user bubble) and padding (same as the
   user bubble) are added so the text does not touch the outline. */
/* nb_changed 2026-11-17 (second pass): outline is now 2px, corners 24px (same as the user bubble), and the padding is larger
   (--calcite-spacing-lg, about 16px) so the text does not touch the bigger curves. The previous values are kept, commented out. */
.assistant-chat-card__response-container.assistant-chat-card__response-container {
  box-sizing: border-box;
  /* border: 1px solid var(--calcite-color-brand) !important; */
  /* border: 2px solid var(--calcite-color-brand) !important; */
  /* border-radius: var(--calcite-border-radius); */
  /* border-radius: 24px; */
  /* padding: var(--calcite-spacing-md); */
  /* padding: var(--calcite-spacing-lg); */
  /* nb_changed 2026-11-17 (fourth pass): new design "המיקס". The assistant outline/fill now belong to the text part of the card
     (.assistant-chat-card__content-container below), so the blue circle sits OUTSIDE the bubble. This container is made invisible
     (no border, radius or padding, transparent background; the theme rule forces a white background with !important, hence !important).
     The 2px blue border, 24px radius and larger padding above are kept as comments. */
  border: 0 !important;
  border-radius: 0;
  padding: 0;
  background: transparent !important;
  /* nb_changed 2026-11-17 (third pass): the assistant's blue circle icon now sits BESIDE its text (a row) instead of above it (the
     component's own layout is a column). In this right-to-left page the first item (the icon) is on the right. align-items is set to
     flex-start so icon and text both start at the top of the row; this wins over the older align-items:flex-end rule at the top of this
     block, which was written for the column layout and would push the text to the bottom of a row. */
  flex-direction: row !important;
  align-items: flex-start !important;
}

/* nb_changed 2026-11-17 (third pass): in the row layout the blue circle must keep its round shape and not be squeezed by long text. */
.assistant-chat-card__response-icon {
  flex-shrink: 0;
}

/* nb_changed 2026-11-17 (third pass): lets the text block shrink and wrap inside the row (flex items otherwise keep their content
   width). The component already gives this block flex:1. */
/* nb_changed 2026-11-17 (fourth pass): this block is now the ASSISTANT bubble itself: light blue fill, 1.5px outline, 14px corners with the
   corner next to the icon (top-right) squared to 4px. The class is doubled for specificity because the theme rule forces a white
   background on every [class*="content"] / [class*="container"] element with !important. width:auto, flex:0 1 auto and max-width:90% make
   short replies compact and long ones at most 90% wide (the component's own values were flex:1 and width:100%). Padding is 10px 6px:
   the text inside already adds about 8px on each side, so the total is about 14px like the user bubble. */
.assistant-chat-card__content-container.assistant-chat-card__content-container {
  min-width: 0;
  background: #f3f9fd !important;
  border: 1.5px solid #b9dcf1 !important;
  border-radius: 14px;
  border-top-right-radius: 4px;
  padding: 10px 6px;
  width: auto;
  flex: 0 1 auto;
  max-width: 90%;
}

/* nb_changed 2026-11-17 (fourth pass): the (empty) footer inside the assistant bubble would paint a white strip, because the theme rule
   forces a white background on every [class*="footer"] element; make it transparent so the blue fill shows through. */
.assistant-chat-card__footer.assistant-chat-card__footer {
  background: transparent !important;
}

/* nb_changed 2026-11-17 (third pass): removes the "extra line" after the response. The last child of the assistant card is an empty div the
   component only uses as a scroll target for its (disabled here) log view; because the card lays out its children with a gap, that
   empty div added blank space under the text, inside the outline. :empty makes sure only that div is hidden, never the text block. */
.assistant-chat-card__response-container > div:last-child:empty {
  display: none;
}
`;

const ASSISTANT_THEME_STYLE_ID = "assistant-theme-style";
const ASSISTANT_THEME_CSS = `
:host {
  display: block;
  height: 100%;
  min-height: 0;
  --calcite-color-background: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-background-2: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-foreground-1: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-foreground-2: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-text-1: var(--app-chat-message-text, #203040);
  --calcite-color-text-2: var(--app-chat-message-text, #203040);
  --calcite-color-border-1: var(--app-chat-panel-border, #d8e4ee);
  background: var(--app-chat-panel-bg, #ffffff);
  color: var(--app-chat-message-text, #203040);
}

[class*="container"],
[class*="panel"],
[class*="content"],
[class*="shell"],
[class*="messages"],
[class*="body"] {
  min-height: 0 !important;
  background: var(--app-chat-panel-bg, #ffffff) !important;
  color: var(--app-chat-message-text, #203040) !important;
  border-color: var(--app-chat-panel-border, #d8e4ee) !important;
}

[class*="header"],
[class*="footer"],
[class*="composer"],
[class*="prompt"] {
  position: relative;
  z-index: 1;
  background: var(--app-chat-panel-bg, #ffffff) !important;
  color: var(--app-chat-chrome-text, #395164) !important;
  border-color: var(--app-chat-panel-border, #d8e4ee) !important;
}

[class*="header"] *,
[class*="footer"] *,
[class*="composer"] *,
[class*="prompt"] *,
textarea,
input::placeholder {
  color: var(--app-chat-chrome-text, #395164) !important;
}

arcgis-assistant-chat-card,
[class*="message"],
[class*="response"],
[class*="body"] {
  color: var(--app-chat-message-text, #203040) !important;
}

button,
calcite-button {
  color: inherit;
}
`;

// Hide the entry-screen description line — it duplicates text already shown
// in the app's own floating header above the map. Applied to every shadow
// root the styler walks (not just arcgis-assistant/chat-card) since it's
// unclear which nested component actually renders this text.
const HIDE_DESCRIPTION_STYLE_ID = "assistant-hide-description-style";
const HIDE_DESCRIPTION_CSS = `
[class*="description" i] {
  display: none !important;
}
`;

// nb_changed 2026-11-17: compact top area of the chat. Injected into every shadow root the styler walks (like the description rule
// above); each rule only matches a class that exists in one specific component, so it does nothing in the other roots.
const COMPACT_HEADER_STYLE_ID = "assistant-compact-header-style";
const COMPACT_HEADER_CSS = `
/* calcite-panel header: the heading is now the short label "התחל שיחה חדשה", shown small. Class names come from calcite-panel. */
.heading.heading {
  font-size: 13px !important; /* previous: calcite default (about 16px) */
}
/* less vertical padding in the header row, so the header is shorter (the refresh button keeps its own size) */
.header-content.header-content {
  padding-block: 0.25rem !important; /* previous: calcite default (about 0.875rem) */
}
/* arcgis-assistant-chat: messages used to be pushed to the BOTTOM of the chat area (justify-content: flex-end), which left a big
   empty gap under the header. flex-start puts the first message right under the header. */
.assistant-chat__messages-list.assistant-chat__messages-list {
  /* justify-content: flex-end; */
  justify-content: flex-start;
}
`;

// ── Shadow DOM helpers ────────────────────────────────────────────────────────

// nb_changed 2026-11-17: injects the compact-header CSS above into a shadow root (once).
function ensureCompactHeaderStyle(element: Element): void {
  const sr = (element as HTMLElement).shadowRoot;
  if (!sr || sr.getElementById(COMPACT_HEADER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = COMPACT_HEADER_STYLE_ID;
  style.textContent = COMPACT_HEADER_CSS;
  sr.appendChild(style);
}

// 5.1 message structure (the older arcgis-assistant-chat-card, which the rules above target, no longer exists in 5.1):
// arcgis-assistant-message / arcgis-assistant-user-message each have their own shadow root. Same "המיקס" design as above:
// assistant = light-blue bubble, user = lavender bubble, the corner next to the icon/avatar (top-right, RTL) squared to 4px.
const ASSISTANT_MESSAGE_STYLE_ID = "assistant-message-bubble-style-51";
const ASSISTANT_MESSAGE_CSS = `
.container.container {
  flex-direction: row;
  align-items: flex-start;
  max-width: 90%;
  direction: rtl;
  text-align: right;
}
.content-container.content-container {
  flex: 0 1 auto;
  width: auto;
  min-width: 0;
  background: #f3f9fd;
  border: 1.5px solid #b9dcf1;
  border-radius: 14px;
  border-top-right-radius: 4px;
  padding: 10px 14px;
  box-sizing: border-box;
}
`;
const MESSAGE_TEXT_STYLE_ID = "assistant-message-text-rtl-style-51";
const MESSAGE_TEXT_CSS = `
.container, .content {
  direction: rtl;
  text-align: right;
}
`;
const USER_MESSAGE_STYLE_ID = "assistant-user-message-bubble-style-51";
const USER_MESSAGE_CSS = `
/* the component's own container paints a pale box (brand 15%) with padding around the message; the bubble below replaces it */
/* !important and the doubled class: the component's styles are adopted stylesheets, which beat an appended <style> at equal specificity */
.container.container {
  background: transparent !important;
  padding: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  margin-left: 0;
  margin-right: auto;
  justify-content: flex-start;
  align-items: flex-start;
}
.container {
  direction: rtl;
}
.container.container > div:first-child {
  direction: rtl;
  text-align: right;
  background: #ececec;
  border: 1.5px solid #cfcfcf;
  border-radius: 14px;
  border-top-right-radius: 4px;
  padding: 10px 14px;
}
.avatar {
  order: -1;
}
`;

function ensureStyle(element: Element, id: string, css: string): void {
  const sr = (element as HTMLElement).shadowRoot;
  if (!sr || sr.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  sr.appendChild(style);
}

function ensureAssistantUserBubbleStyle(cardElement: Element): void {
  const sr = (cardElement as HTMLElement).shadowRoot;
  if (!sr || sr.getElementById(ASSISTANT_USER_BUBBLE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = ASSISTANT_USER_BUBBLE_STYLE_ID;
  style.textContent = ASSISTANT_USER_BUBBLE_CSS;
  sr.appendChild(style);
}

function ensureAssistantThemeStyle(element: Element): void {
  const sr = (element as HTMLElement).shadowRoot;
  if (!sr || sr.getElementById(ASSISTANT_THEME_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = ASSISTANT_THEME_STYLE_ID;
  style.textContent = ASSISTANT_THEME_CSS;
  sr.appendChild(style);
}

function ensureDescriptionHiddenStyle(element: Element): void {
  const sr = (element as HTMLElement).shadowRoot;
  if (!sr || sr.getElementById(HIDE_DESCRIPTION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_DESCRIPTION_STYLE_ID;
  style.textContent = HIDE_DESCRIPTION_CSS;
  sr.appendChild(style);
}

function ensureLinksOpenInNewTab(root: Element | ShadowRoot): void {
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
}

/**
 * Installs a MutationObserver on the arcgis-assistant element that:
 * - Injects theme CSS into shadow roots
 * - Injects user-bubble layout CSS into chat-card shadow roots
 * - Forces external links to open in a new tab
 * - Intercepts link clicks to use window.open instead of navigation
 *
 * Returns a cleanup function that removes the observer and listener.
 */
export function installAssistantUserBubbleStyler(assistant: HTMLElement): () => void {
  const handleClick = (event: Event) => {
    const path =
      typeof (event as any).composedPath === "function"
        ? (event as any).composedPath()
        : [];
    const anchor = path.find(
      (node: unknown) => node instanceof HTMLAnchorElement,
    ) as HTMLAnchorElement | undefined;
    const href = anchor?.href?.trim() ?? "";
    if (!anchor || !/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(href, "_blank", "noopener,noreferrer");
  };

  assistant.addEventListener("click", handleClick, true);

  const observer = new MutationObserver(() => {
    scanTree(assistant);
    if (assistant.shadowRoot) scanTree(assistant.shadowRoot);
  });

  const observedRoots = new WeakSet<Node>();

  function observeRoot(root: Element | ShadowRoot): void {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
    root.querySelectorAll("*").forEach((node) => {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) observeRoot(sr);
    });
  }

  function scanTree(root: Element | ShadowRoot): void {
    ensureLinksOpenInNewTab(root);

    if (root instanceof Element && root.matches("arcgis-assistant")) {
      ensureAssistantThemeStyle(root);
    }

    root.querySelectorAll("arcgis-assistant-chat-card").forEach((card) => {
      ensureAssistantThemeStyle(card);
      ensureAssistantUserBubbleStyle(card);
    });

    root.querySelectorAll("*").forEach((node) => {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) {
        if (node.matches("arcgis-assistant-message")) ensureStyle(node, ASSISTANT_MESSAGE_STYLE_ID, ASSISTANT_MESSAGE_CSS);
        if (node.matches("arcgis-assistant-message-text")) ensureStyle(node, MESSAGE_TEXT_STYLE_ID, MESSAGE_TEXT_CSS);
        if (node.matches("arcgis-assistant-user-message")) ensureStyle(node, USER_MESSAGE_STYLE_ID, USER_MESSAGE_CSS);
        ensureDescriptionHiddenStyle(node);
        ensureCompactHeaderStyle(node); // nb_changed 2026-11-17: compact header + top-aligned messages
        observeRoot(sr);
        scanTree(sr);
      }
    });
  }

  ensureDescriptionHiddenStyle(assistant);
  observeRoot(assistant);
  scanTree(assistant);
  if (assistant.shadowRoot) {
    observeRoot(assistant.shadowRoot);
    scanTree(assistant.shadowRoot);
  }

  return () => {
    assistant.removeEventListener("click", handleClick, true);
    observer.disconnect();
  };
}
