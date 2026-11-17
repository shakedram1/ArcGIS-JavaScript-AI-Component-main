import type { Ta5500Hit } from "./ta5500Chunks"; // nb_changed 2026-11-16: type only, for the new lastTa5500Hits field

export interface AssistantResultLink {
  url: string;
  label: string;
}

export interface AssistantResultField {
  label: string;
  value: string;
}

export interface AssistantResultEntity {
  kind: "point" | "country" | "region" | "named" | "extent";
  origin: "source" | "context";
  label: string;
  lat?: number;
  lon?: number;
  west?: number;
  south?: number;
  east?: number;
  north?: number;
  description?: string;
  summary?: string;
  links?: AssistantResultLink[];
  fields?: AssistantResultField[];
}

export interface AssistantGeoMemorySnapshot {
  title: string;
  responseText: string;
  entities: AssistantResultEntity[];
  updatedAt: string;
}

export interface CreatedFeatureLayerSnapshot {
  title: string;
  serviceUrl: string;
  layerUrl: string;
  geometryType: string;
  serviceItemId?: string;
  updatedAt: string;
}

// nb_changed 2026-11-16: ranked chunk hits of the last TA5500 RAG answer (read by the PDF viewer window).
export interface Ta5500HitsSnapshot {
  hits: Ta5500Hit[];
  updatedAt: string;
}

interface AssistantStateShape {
  lastGeoSnapshot?: AssistantGeoMemorySnapshot;
  lastCreatedFeatureLayer?: CreatedFeatureLayerSnapshot;
  lastTa5500Hits?: Ta5500HitsSnapshot; // nb_changed 2026-11-16: new field for the PDF viewer
}

function getAssistantState(): AssistantStateShape {
  const root = globalThis as typeof globalThis & {
    __arcgisAssistantState__?: AssistantStateShape;
  };
  if (!root.__arcgisAssistantState__) {
    root.__arcgisAssistantState__ = {};
  }
  return root.__arcgisAssistantState__;
}

export function setLastAssistantGeoSnapshot(snapshot: AssistantGeoMemorySnapshot): void {
  const state = getAssistantState();
  state.lastGeoSnapshot = snapshot;
}

export function getLastAssistantGeoSnapshot(): AssistantGeoMemorySnapshot | null {
  return getAssistantState().lastGeoSnapshot ?? null;
}

export function clearLastAssistantGeoSnapshot(): void {
  delete getAssistantState().lastGeoSnapshot;
}

export function setLastCreatedFeatureLayer(snapshot: CreatedFeatureLayerSnapshot): void {
  const state = getAssistantState();
  state.lastCreatedFeatureLayer = snapshot;
}

export function getLastCreatedFeatureLayer(): CreatedFeatureLayerSnapshot | null {
  return getAssistantState().lastCreatedFeatureLayer ?? null;
}

// nb_changed 2026-11-16: stores the ranked chunk hits of a TA5500 RAG answer and tells the PDF viewer window (which listens on
// window) that new hits are available, so it can open and jump to the first chunk.
export function setLastTa5500Hits(hits: Ta5500Hit[]): void {
  getAssistantState().lastTa5500Hits = { hits, updatedAt: new Date().toISOString() };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ta5500-hits-changed"));
  }
}

// nb_changed 2026-11-16: lets the viewer read the hits when it mounts after the event was fired.
export function getLastTa5500Hits(): Ta5500HitsSnapshot | null {
  return getAssistantState().lastTa5500Hits ?? null;
}