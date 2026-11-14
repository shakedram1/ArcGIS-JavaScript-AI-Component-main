// TA5500 Plan agent (spec §5.3): resolve → search → answer → focus. The LLM proposes, code validates:
// only values that passed validateRequest (or came from the plan data / layer 122) reach the RAG and the map.
import { StateGraph, Annotation, START, END } from "@langchain/langgraph/web";
import type { RunnableConfig } from "@langchain/core/runnables";
import { invokeStructuredPrompt } from "@arcgis/ai-components/utils/index.js";
import type Geometry from "@arcgis/core/geometry/Geometry.js";
import { fromJSON as geometryFromJSON } from "@arcgis/core/geometry/support/jsonUtils.js";
import { z } from "zod";
import { agentRuntimeChannels, readAgentRequest, agentResult } from "./agentRuntime";
import { getPlanLocations, searchPlan } from "../ta5500/ragClient";
import type { PlanFilters, PlanLocations, PlanSearchResult } from "../ta5500/types";
import { matchTopicOverrides, TA5500_LAYERS, type LayerKey } from "../ta5500/layers";
import { validateRequest } from "../ta5500/planLogic";
import { planFocus, focusStore, type Place } from "../ta5500/focus";
import {
  getView,
  geocodeInTelAviv,
  resolvePlaceGeometry,
  keepLayersWithFeatures,
  applyFocus,
  resetFocus,
  FocusSupersededError,
} from "../ta5500/mapFocus";
import {
  PLAN_AGENT_DESCRIPTION,
  RESOLVE_PROMPT,
  ANSWER_PROMPT,
  NO_PLACE_NOTE,
  OUTSIDE_TA_REPLY,
  MAP_FAILED_NOTE,
  FOCUS_CLEARED_REPLY,
  shownLine,
} from "../ta5500/prompts";
import {
  answerContext,
  candidateLayers,
  composeOutput,
  conversationText,
  failureReply,
  focusSummary,
  mergeFilters,
  placeFromFilters,
  placeSearchFilters,
} from "../ta5500/planFlow";

const AGENT_ID = "ta5500-plan";

const resolveSchema = z.object({
  question: z.string(),
  areas: z.array(z.string()),
  entities: z.array(z.string()),
  zone_types: z.array(z.string()),
  headings: z.array(z.string()),
  place: z.string().nullable(),
  intent: z.enum(["answer", "refine_focus", "clear_focus"]),
});

const answerSchema = z.object({
  answer: z.string(),
  usedItems: z.array(z.number().int().positive()),
});

const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_prev, next) => next, default: fallback });

function failure(err: unknown) {
  return agentResult(failureReply(err, "ta5500 plan agent"));
}

/** Geometry of the stored focus place: its saved geometry for a geocoded place, else from the plan layers. */
async function storedPlaceGeometry(place: Place): Promise<Geometry | null> {
  const json = focusStore.get()?.geometryJson;
  if (place.kind === "geocoded" && json) {
    try {
      return geometryFromJSON(json as any) as Geometry;
    } catch {
      /* fall through to the plan layers */
    }
  }
  const view = getView();
  return view ? resolvePlaceGeometry(view, place).catch(() => null) : null;
}

export function registerPlanAgent(assistant: HTMLElement, ctx: { baseUrl: string }): void {
  const baseUrl = ctx.baseUrl;

  const createGraph = () => {
    const state = Annotation.Root({
      ...agentRuntimeChannels(),
      done: last<boolean>(() => false),
      question: last<string>(() => ""),
      filters: last<PlanFilters>(() => ({})),
      overrideZoneTypes: last<string[]>(() => []),
      place: last<Place | null>(() => null),
      placeGeometry: last<Geometry | null>(() => null),
      notes: last<string[]>(() => []),
      locations: last<PlanLocations | null>(() => null),
      result: last<PlanSearchResult | null>(() => null),
      answer: last<string>(() => ""),
      usedItems: last<number[]>(() => []),
    });
    type S = typeof state.State;

    async function resolve(s: S, config?: RunnableConfig) {
      try {
        const { request, messages } = readAgentRequest(s);
        const r = await invokeStructuredPrompt({
          promptText: RESOLVE_PROMPT,
          inputVariables: {
            request: conversationText(messages, request),
            currentFocus: focusStore.get()?.label ?? "none",
          },
          schema: resolveSchema,
          temperature: 0,
          config,
        });

        if (r.intent === "clear_focus") {
          const view = getView();
          if (view) await resetFocus(view);
          else focusStore.clear();
          return {
            done: true,
            ...agentResult({ output: FOCUS_CLEARED_REPLY, ok: true, summary: "focus cleared", sharedStatePatch: { ta5500Focus: { value: null } } }),
          };
        }

        const question = r.question.trim() || request;
        const locations = await getPlanLocations(baseUrl);
        const { filters: validated } = validateRequest(
          { areas: r.areas, entities: r.entities, zone_types: r.zone_types, headings: r.headings },
          locations,
        );
        const overrides = matchTopicOverrides(question);
        const notes: string[] = [];

        let place = placeFromFilters(validated, locations);
        let placeGeometry: Geometry | null = null;
        let extraFilters: PlanFilters = {};
        const placeText = r.place?.trim() ?? "";

        if (place) {
          const view = getView();
          placeGeometry = view ? await resolvePlaceGeometry(view, place).catch(() => null) : null;
        } else {
          if (placeText) {
            const view = getView();
            const geo = view ? await geocodeInTelAviv(view, placeText).catch(() => null) : null;
            if (geo && "outside" in geo) {
              return { done: true, ...agentResult({ output: OUTSIDE_TA_REPLY, ok: true, summary: "place outside Tel Aviv-Yafo" }) };
            }
            if (geo) {
              place = geo.place;
              placeGeometry = geo.geometry;
            }
          }
          if (!place && r.intent === "refine_focus") {
            const stored = focusStore.get()?.place;
            if (stored) {
              place = { kind: stored.kind, codes: [...stored.codes], label: stored.label };
              placeGeometry = await storedPlaceGeometry(place);
            }
          }
          if (place) extraFilters = placeSearchFilters(place, locations);
          else if (placeText) notes.push(NO_PLACE_NOTE);
        }

        return {
          question,
          locations,
          filters: mergeFilters(validated, extraFilters, overrides),
          overrideZoneTypes: overrides.zone_types ?? [],
          place,
          placeGeometry,
          notes,
        };
      } catch (err) {
        return { done: true, ...failure(err) };
      }
    }

    async function search(s: S) {
      try {
        return { result: await searchPlan(baseUrl, s.question, s.filters) };
      } catch (err) {
        return { done: true, ...failure(err) };
      }
    }

    async function answer(s: S, config?: RunnableConfig) {
      try {
        const r = await invokeStructuredPrompt({
          promptText: ANSWER_PROMPT,
          inputVariables: { question: s.question, context: answerContext(s.result!) },
          schema: answerSchema,
          temperature: 0,
          config,
        });
        const max = s.result!.hits.length;
        const usedItems = [...new Set(r.usedItems)].filter((i) => max === 0 || i <= max);
        return { answer: r.answer, usedItems };
      } catch (err) {
        return { done: true, ...failure(err) };
      }
    }

    async function focus(s: S) {
      const { place, placeGeometry, locations, result } = s;
      const notes = [...s.notes];
      let line = "";
      let shown: LayerKey[] = [];
      let patch: { label: string; layers: LayerKey[] } | null = null;
      try {
        const candidates = candidateLayers(result!, s.usedItems, s.overrideZoneTypes, locations!);
        const preview = planFocus(place, candidates);
        if (preview.case !== "none") {
          const view = getView();
          if (!view) throw new Error("map view unavailable");
          const { kept, skipped } = candidates.size
            ? await keepLayersWithFeatures(view, candidates, placeGeometry)
            : { kept: candidates, skipped: [] as LayerKey[] };
          const plan = planFocus(place, kept);
          if (plan.case !== "none") {
            const applied = await applyFocus(view, plan, place, placeGeometry);
            shown = applied.layers.map((l) => l.layerKey);
            patch = { label: applied.label, layers: shown };
          }
          line = shownLine(
            place?.label ?? null,
            shown.map((k) => TA5500_LAYERS[k].label),
            skipped.map((k) => TA5500_LAYERS[k].label),
          );
        }
      } catch (err) {
        if (!(err instanceof FocusSupersededError)) {
          console.warn("ta5500 map focus failed:", err);
          notes.push(MAP_FAILED_NOTE);
        }
        line = "";
      }
      return agentResult({
        output: composeOutput(s.answer, line, ...notes),
        ok: true,
        summary: focusSummary(place, shown),
        ...(patch ? { sharedStatePatch: { ta5500Focus: { value: patch } } } : {}),
      });
    }

    const next = (to: string) => (s: S) => (s.done ? END : to);

    return new StateGraph(state)
      .addNode("resolve", resolve)
      .addNode("search", search)
      .addNode("answer", answer)
      .addNode("focus", focus)
      .addEdge(START, "resolve")
      .addConditionalEdges("resolve", next("search"), ["search", END])
      .addConditionalEdges("search", next("answer"), ["answer", END])
      .addConditionalEdges("answer", next("focus"), ["focus", END])
      .addEdge("focus", END);
  };

  const agent = {
    id: AGENT_ID,
    name: "TA5500 Plan",
    description: PLAN_AGENT_DESCRIPTION,
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
