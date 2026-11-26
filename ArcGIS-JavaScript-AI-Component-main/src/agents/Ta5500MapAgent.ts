// TA5500 Map agent (spec §5.2, §5.5): one map action on the Tel Aviv-Yafo master plan map — go to a place,
// show / filter / hide plan layers, reset. The LLM proposes { action, place, topic }; code validates: places
// resolve to plan codes or a geocoded place inside Tel Aviv-Yafo, topics resolve to plan layers only
// (planFlow.topicLayers). Nothing outside the plan is ever acted on.
import { StateGraph, Annotation, START, END } from "@langchain/langgraph/web";
import type { RunnableConfig } from "@langchain/core/runnables";
import { invokeStructuredPrompt } from "@arcgis/ai-components/utils/index.js";
import type Geometry from "@arcgis/core/geometry/Geometry.js";
import type MapView from "@arcgis/core/views/MapView.js";
import { z } from "zod";
import { agentRuntimeChannels, readAgentRequest, agentResult } from "./agentRuntime";
import { getPlanLocations } from "../ta5500/ragClient";
import type { PlanLocations } from "../ta5500/types";
import { TA5500_LAYERS, type LayerKey } from "../ta5500/layers";
import { catalogForPrompt, entriesFromPicks, matchCatalog } from "../ta5500/catalog";
import { planFocus, focusStore, type FocusState, type Place } from "../ta5500/focus";
import {
  getView,
  geocodeInTelAviv,
  resolvePlaceGeometry,
  keepLayersWithFeatures,
  applyFocus,
  resetFocus,
  hideLayers,
  listCatalog,
  FocusSupersededError,
} from "../ta5500/mapFocus";
import {
  MAP_AGENT_DESCRIPTION,
  MAP_LAYER_PICK_PROMPT,
  MAP_RESOLVE_PROMPT,
  NO_PLACE_NOTE,
  NO_TOPIC_NOTE,
  NO_TOPIC_REPLY,
  OUTSIDE_TA_REPLY,
  MAP_FAILED_NOTE,
  MAP_SUPERSEDED_REPLY,
  FOCUS_CLEARED_REPLY,
  HIDE_PARTIAL_REPLY,
  goToLine,
  notInPlanNote,
  shownLine,
  whichAreaQuestion,
  whichGroupQuestion,
} from "../ta5500/prompts";
import {
  composeOutput,
  conversationText,
  failureReply,
  focusSummary,
  hideReply,
  hideTargets,
  mapFailedSummary,
  mapStep,
  missingPlaceGeometry,
  placeTextStep,
  topicLayers,
} from "../ta5500/planFlow";

const AGENT_ID = "ta5500-map";
const TAG = "ta5500 map agent";
const ASK_LAYER_SUMMARY = "asked the user from which drawing to show the layer; waiting for the answer; do not retry";
const ASK_PLACE_SUMMARY = "asked the user which planning area was meant; waiting for the answer; do not retry";

const resolveSchema = z.object({
  action: z.enum(["go_to", "show", "hide", "filter", "reset"]),
  place: z.string().nullable(),
  topic: z.string().nullable(),
});

const pickSchema = z.object({ layers: z.array(z.number().int()) });

const labelsOf = (keys: LayerKey[]) => keys.map((k) => TA5500_LAYERS[k].label);

const focusPatch = (s: FocusState | null) =>
  ({ ta5500Focus: { value: s ? { label: s.label, layers: s.layers.map((l) => l.layerKey) } : null } });

/** A newer map call replaced this one: applyFocus superseded, or view.goTo interrupted by another navigation. */
const isSuperseded = (err: unknown) => err instanceof FocusSupersededError || (err as { name?: string })?.name === "AbortError";

function mapFailed(err: unknown, summary: string) {
  if (isSuperseded(err)) return agentResult({ output: MAP_SUPERSEDED_REPLY, ok: true, summary: `${summary}: superseded` });
  console.warn(`${TAG}: map update failed:`, err);
  // Reported to the user; status "success" so the 5.1 orchestrator does not re-route to another agent
  // (it re-routes after "failed"), and the summary says the map update failed.
  return agentResult({ output: MAP_FAILED_NOTE, ok: true, summary: mapFailedSummary(summary) });
}

type Resolved = { place: Place | null; geometry: Geometry | null } | { outside: true } | { notInPlan: string } | { ambiguous: Place[] };

/**
 * Same order as the Plan agent (planFlow.placeTextStep): plan codes / entities first; an area-shaped code that is
 * not in the plan → notInPlan (never geocoded); then the Tel Aviv geocoder. Geocoder errors → no place.
 */
async function resolvePlace(view: MapView | null, text: string, loc: PlanLocations): Promise<Resolved> {
  const step = placeTextStep(text, loc);
  if (step.kind === "none") return { place: null, geometry: null };
  if (step.kind === "not_in_plan") return { notInPlan: step.code };
  if (step.kind === "ambiguous") return { ambiguous: step.options };
  if (step.kind === "coded") {
    const geometry = view ? await resolvePlaceGeometry(view, step.place).catch(() => null) : null;
    return { place: step.place, geometry };
  }
  if (!view) return { place: null, geometry: null };
  const geo = await geocodeInTelAviv(view, text).catch((err) => {
    console.warn(`${TAG}: geocode failed:`, err);
    return null;
  });
  if (geo && "outside" in geo) return { outside: true };
  return geo ? { place: geo.place, geometry: geo.geometry } : { place: null, geometry: null };
}

export function registerTa5500MapAgent(assistant: HTMLElement, ctx: { baseUrl: string }): void {
  const baseUrl = ctx.baseUrl;

  const createGraph = () => {
    const state = Annotation.Root({ ...agentRuntimeChannels() });
    type S = typeof state.State;

    async function run(s: S, config?: RunnableConfig) {
      let r: z.infer<typeof resolveSchema>;
      let locations: PlanLocations | null = null;
      let convo = "";
      try {
        const { request, messages } = readAgentRequest(s);
        convo = conversationText(messages, request);
        r = await invokeStructuredPrompt({
          promptText: MAP_RESOLVE_PROMPT,
          inputVariables: {
            request: convo,
            currentFocus: focusStore.get()?.label ?? "none",
          },
          schema: resolveSchema,
          temperature: 0,
          config,
        });
        if (r.action !== "reset") locations = await getPlanLocations(baseUrl);
      } catch (err) {
        return agentResult(failureReply(err, TAG));
      }

      const view = getView();

      if (r.action === "reset") {
        try {
          if (view) await resetFocus(view);
          else focusStore.clear();
        } catch (err) {
          return mapFailed(err, "reset");
        }
        return agentResult({ output: FOCUS_CLEARED_REPLY, ok: true, summary: "focus cleared", sharedStatePatch: focusPatch(null) });
      }

      const loc = locations!;
      const placeText = r.place?.trim() ?? "";
      const topicText = r.topic?.trim() ?? "";
      // Catalog layers (the map's own layer titles, by drawing) win over the six known plan layers for show / filter;
      // hide keeps acting on the known layers only.
      const entries = view && r.action !== "hide" ? listCatalog(view) : [];
      let catalog = entries.length ? matchCatalog(topicText, entries) : { layers: [], ambiguous: [] };
      let useCatalog = catalog.layers.length > 0 || catalog.ambiguous.length > 0;
      const layers = useCatalog ? new Map<LayerKey, string[]>() : topicLayers(topicText, loc);
      // Last resort for a show / filter topic that names no layer or group ("השכבות הרלוונטיות"): the LLM picks layers
      // by number from the map's own catalog; only valid numbers survive, so nothing outside the plan is drawn.
      if (!useCatalog && !layers.size && topicText && entries.length) {
        try {
          const pick = await invokeStructuredPrompt({
            promptText: MAP_LAYER_PICK_PROMPT,
            inputVariables: { request: convo, topic: topicText, catalog: catalogForPrompt(entries) },
            schema: pickSchema,
            temperature: 0,
            config,
          });
          catalog = { layers: entriesFromPicks(pick.layers, entries), ambiguous: [] };
          useCatalog = catalog.layers.length > 0;
        } catch (err) {
          return agentResult(failureReply(err, TAG));
        }
      }
      const wholeUids = catalog.layers.map((e) => e.uid);

      // The place is resolved for every action (hide too: a place outside Tel Aviv-Yafo is declined).
      let place: Place | null = null;
      let geometry: Geometry | null = null;
      let outside = false;
      let notInPlan: string | null = null;
      let ambiguous: Place[] | null = null;
      if (placeText) {
        const resolved = await resolvePlace(view, placeText, loc);
        if ("outside" in resolved) outside = true;
        else if ("ambiguous" in resolved) ambiguous = resolved.ambiguous;
        else if ("notInPlan" in resolved) notInPlan = resolved.notInPlan;
        else ({ place, geometry } = resolved);
      }

      const step = mapStep(r.action, { placeText, place, layers, outside, notInPlan: !!notInPlan, ambiguousPlace: !!ambiguous, ambiguousLayers: catalog.ambiguous.length > 0, wholeLayers: wholeUids.length });
      switch (step) {
        case "outside":
          return agentResult({ output: OUTSIDE_TA_REPLY, ok: true, summary: "place outside Tel Aviv-Yafo" });
        case "ask_place":
          return agentResult({ output: whichAreaQuestion(placeText, ambiguous!), ok: true, summary: ASK_PLACE_SUMMARY });
        case "ask_layer":
          return agentResult({ output: whichGroupQuestion(catalog.ambiguous), ok: true, summary: ASK_LAYER_SUMMARY });
        case "not_in_plan":
          return agentResult({ output: notInPlanNote(notInPlan!), ok: true, summary: `${r.action}: area ${notInPlan} not in the plan` });
        case "no_place":
          return agentResult({ output: NO_PLACE_NOTE, ok: true, summary: `${r.action}: place not resolved` });
        case "no_topic":
          return agentResult({ output: NO_TOPIC_REPLY, ok: true, summary: `${r.action}: no plan layer for the topic` });
        case "hide_partial":
          return agentResult({ output: HIDE_PARTIAL_REPLY, ok: true, summary: "hide: only part of a layer, not supported" });

        case "go_to": {
          try {
            if (!view) throw new Error("map view unavailable");
            const target = geometry?.extent?.clone().expand(1.2);
            if (!target) throw new Error(`no geometry for ${place!.label}`);
            await view.goTo(target);
          } catch (err) {
            return mapFailed(err, "go_to");
          }
          return agentResult({ output: goToLine(place!.label), ok: true, summary: `go_to ${place!.label}` });
        }

        case "hide": {
          const { whole, partial } = hideTargets(layers);
          let hidden: LayerKey[];
          let st: FocusState | null;
          try {
            if (!view) throw new Error("map view unavailable");
            ({ hidden, state: st } = hideLayers(view, whole));
          } catch (err) {
            return mapFailed(err, "hide");
          }
          return agentResult({
            output: hideReply({
              hidden: labelsOf(hidden),
              missing: labelsOf(whole.filter((k) => !hidden.includes(k))),
              partial: labelsOf(partial),
              placeLabel: place?.label ?? null,
            }),
            ok: true,
            summary: `hidden: ${hidden.length ? hidden.join(", ") : "none"}`,
            ...(hidden.length ? { sharedStatePatch: focusPatch(st) } : {}),
          });
        }

        case "focus": {
          let line = "";
          let shown: LayerKey[] = [];
          let applied: FocusState | null = null;
          try {
            if (!view) throw new Error("map view unavailable");
            // A place focus needs the place geometry; without it no focus is applied and the failure is reported.
            if (missingPlaceGeometry(place, geometry)) throw new Error(`no geometry for ${place!.label}`);
            const { kept, skipped } = layers.size
              ? await keepLayersWithFeatures(view, layers, geometry)
              : { kept: layers, skipped: [] as LayerKey[] };
            const plan = planFocus(place, kept, wholeUids);
            if (plan.case !== "none") {
              applied = await applyFocus(view, plan, place, geometry);
              shown = applied.layers.map((l) => l.layerKey);
            }
            line = shownLine(place?.label ?? null, [...labelsOf(shown), ...(applied?.wholeLayers.map((w) => w.title) ?? [])], labelsOf(skipped));
          } catch (err) {
            return mapFailed(err, r.action);
          }
          const topicNote = topicText && !layers.size && !wholeUids.length ? NO_TOPIC_NOTE : "";
          return agentResult({
            output: composeOutput(line, topicNote) || NO_TOPIC_REPLY,
            ok: true,
            summary: focusSummary(place, shown),
            ...(applied ? { sharedStatePatch: focusPatch(applied) } : {}),
          });
        }
      }
    }

    return new StateGraph(state).addNode("run", run).addEdge(START, "run").addEdge("run", END);
  };

  const agent = {
    id: AGENT_ID,
    name: "TA5500 Map",
    description: MAP_AGENT_DESCRIPTION,
    createGraph,
    workspace: {},
  } as any;

  const existing = assistant.querySelector(`[data-agent-id="${AGENT_ID}"]`);
  if (existing) existing.remove();

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", AGENT_ID);
  agentEl.agent = agent;
  assistant.appendChild(agentEl);
}
