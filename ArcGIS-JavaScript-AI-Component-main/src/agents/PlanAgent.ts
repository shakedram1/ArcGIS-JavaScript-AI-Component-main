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
import { setLastTa5500Hits } from "../utils/assistantState";
import { getActiveFocus, getFocusState, setFocusEnabled } from "../utils/focusStore";
import { findClauseHit, loadTa5500ChunkIndex, regionsOf } from "../utils/ta5500Chunks";
import type { PlanFilters, PlanLocations, PlanSearchResult } from "../ta5500/types";
import { matchTopicOverrides, TA5500_LAYERS, type LayerKey } from "../ta5500/layers";
import { validateRequest } from "../ta5500/planLogic";
import { matchCatalog } from "../ta5500/catalog";
import { planFocus, focusStore, type Place } from "../ta5500/focus";
import {
  getView,
  geocodeInTelAviv,
  resolvePlaceGeometry,
  keepLayersWithFeatures,
  applyFocus,
  resetFocus,
  listCatalog,
  FocusSupersededError,
} from "../ta5500/mapFocus";
import {
  PLAN_AGENT_DESCRIPTION,
  RESOLVE_PROMPT,
  ANSWER_PROMPT,
  OUTSIDE_TA_REPLY,
  MAP_FAILED_NOTE,
  FOCUS_CLEARED_REPLY,
  shownLine,
  whichAreaQuestion,
} from "../ta5500/prompts";
import {
  answerContext,
  candidateLayers,
  composeOutput,
  conversationText,
  failureReply,
  focusSummary,
  mapFailedSummary,
  mergeFilters,
  missingPlaceGeometry,
  placeFromFilters,
  placeSearchFilters,
  placeTextStep,
  planCatalogUids,
  planPlaceNote,
  planViewerHits,
  unplannedAreaCode,
  useStoredPlace,
} from "../ta5500/planFlow";

const AGENT_ID = "ta5500-plan";

const resolveSchema = z.object({
  question: z.string(),
  areas: z.array(z.string()),
  entities: z.array(z.string()),
  zone_types: z.array(z.string()),
  headings: z.array(z.string()),
  place: z.string().nullable(),
  intent: z.enum(["answer", "pdf_clause", "pdf_topic", "polygon_only", "refine_focus", "clear_focus"]),
  pdfClause: z.string().nullable(),
  polygonAction: z.enum(["none", "enable", "disable"]),
});

const answerSchema = z.object({
  answer: z.string(),
  usedItems: z.array(z.number().int().positive()),
});

const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_prev, next) => next, default: fallback });

/** RAG outage → "failed" with a do-not-retry summary; any other error → ok with a do-not-retry summary (failureReply). */
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
      wholeLayerUids: last<string[]>(() => []),
      place: last<Place | null>(() => null),
      placeGeometry: last<Geometry | null>(() => null),
      placeText: last<string>(() => ""),
      unplannedArea: last<string | null>(() => null),
      locations: last<PlanLocations | null>(() => null),
      result: last<PlanSearchResult | null>(() => null),
      pdfOnly: last<boolean>(() => false),
      answer: last<string>(() => ""),
      usedItems: last<number[]>(() => []),
    });
    type S = typeof state.State;

    async function resolve(s: S, config?: RunnableConfig) {
      try {
        const { request, userRequest, messages } = readAgentRequest(s);
        const r = await invokeStructuredPrompt({
          promptText: RESOLVE_PROMPT,
          inputVariables: {
            request: conversationText(messages, request),
            currentFocus: `${focusStore.get()?.label ?? "none"}; drawn polygon: ${getFocusState().polygon ? getFocusState().status : "none"}; polygon filter: ${getFocusState().enabled ? "on" : "off"}`,
          },
          schema: resolveSchema,
          temperature: 0,
          config,
        });

        if (r.intent === "pdf_clause") {
          const index = await loadTa5500ChunkIndex();
          const hit = findClauseHit(index, r.pdfClause ?? "", userRequest || request);
          if (!hit) {
            return { done: true, ...agentResult({ output: "לא נמצא במסמך סעיף מזוהה עם מיקום להצגה. ניתן לציין מספר סעיף מדויק.", ok: true }) };
          }
          setLastTa5500Hits([hit]);
          return { done: true, ...agentResult({ output: `הסעיף ${hit.id} מוצג במסמך.`, ok: true }) };
        }

        if (r.polygonAction === "disable") setFocusEnabled(false);
        if (r.polygonAction === "enable") {
          const polygon = getFocusState();
          if (!polygon.polygon) return { done: true, ...agentResult({ output: "יש לשרטט פוליגון לפני השימוש בו כמסנן.", ok: true }) };
          if (polygon.status !== "ready") return { done: true, ...agentResult({ output: "חישוב החיתוך של הפוליגון עדיין לא זמין. ניתן לנסות שוב לאחר השלמתו.", ok: true }) };
          setFocusEnabled(true);
        }
        if (r.intent === "polygon_only") {
          const output = r.polygonAction === "enable" ? "הפוליגון משמש כמסנן לשאילתות." : r.polygonAction === "disable" ? "הפוליגון אינו משמש עוד כמסנן לשאילתות." : "ניתן לציין אם להשתמש בפוליגון כמסנן.";
          return { done: true, ...agentResult({ output, ok: true }) };
        }

        if (r.intent === "clear_focus") {
          try {
            const view = getView();
            if (view) await resetFocus(view);
            else focusStore.clear();
          } catch (err) {
            console.warn("ta5500 plan agent: clear focus failed:", err);
            return { done: true, ...agentResult({ output: MAP_FAILED_NOTE, ok: true, summary: mapFailedSummary("clear focus") }) };
          }
          return {
            done: true,
            ...agentResult({ output: FOCUS_CLEARED_REPLY, ok: true, summary: "focus cleared", sharedStatePatch: { ta5500Focus: { value: null } } }),
          };
        }

        const question = r.question.trim() || request;
        if (r.intent === "pdf_topic") return { question, pdfOnly: true };
        const locations = await getPlanLocations(baseUrl);
        const { filters: validated, dropped } = validateRequest(
          { areas: r.areas, entities: r.entities, zone_types: r.zone_types, headings: r.headings },
          locations,
        );
        const overrides = matchTopicOverrides(question);
        const placeText = r.place?.trim() ?? "";
        const view = getView();

        // Place order: validated filters, then the free-text place (plan code / entity, else the Tel Aviv
        // geocoder; an area-shaped code not in the plan is never geocoded), then — for refine_focus only — the
        // stored focus place when the request names no other place.
        let place = placeFromFilters(validated, locations);
        let placeGeometry: Geometry | null = null;
        let extraFilters: PlanFilters = {};
        let unplannedArea = place ? null : unplannedAreaCode(dropped, locations);

        if (place) {
          placeGeometry = view ? await resolvePlaceGeometry(view, place).catch(() => null) : null;
        } else {
          const step = placeTextStep(placeText, locations);
          if (step.kind === "coded") {
            place = step.place;
            placeGeometry = view ? await resolvePlaceGeometry(view, place).catch(() => null) : null;
          } else if (step.kind === "ambiguous") {
            return {
              done: true,
              ...agentResult({
                output: whichAreaQuestion(placeText, step.options),
                ok: true,
                summary: "asked the user which planning area was meant; waiting for the answer; do not retry",
              }),
            };
          } else if (step.kind === "not_in_plan") {
            unplannedArea = step.code;
          } else if (step.kind === "geocode") {
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
            if (stored && useStoredPlace(placeText, stored)) {
              place = { kind: stored.kind, codes: [...stored.codes], label: stored.label };
              placeGeometry = await storedPlaceGeometry(place);
            }
          }
          if (place) {
            extraFilters = placeSearchFilters(place, locations);
            unplannedArea = null;
          }
        }

        return {
          question,
          locations,
          filters: mergeFilters(validated, extraFilters, overrides),
          overrideZoneTypes: overrides.zone_types ?? [],
          wholeLayerUids: view ? planCatalogUids(matchCatalog(request, listCatalog(view))) : [],
          place,
          placeGeometry,
          placeText,
          unplannedArea,
        };
      } catch (err) {
        return { done: true, ...failure(err) };
      }
    }

    async function search(s: S) {
      try {
        const polygon = getFocusState();
        const focus = getActiveFocus();
        if (polygon.enabled && (!focus || polygon.failed.length || polygon.truncated.length || !Object.values(focus.filters).some((values) => values.length))) {
          return { done: true, ...agentResult({ output: "לא ניתן להחיל את מסנן הפוליגון: תוצאות החיתוך אינן זמינות או אינן מספיקות לחיפוש בתוכנית.", ok: true }) };
        }
        const result = await searchPlan(baseUrl, s.question, s.filters, focus ?? undefined);
        const hits = planViewerHits(result);
        if (s.pdfOnly) {
          const index = await loadTa5500ChunkIndex();
          const located = hits.filter((hit) => {
            const chunk = index.get(hit.id);
            return chunk && regionsOf(chunk).length;
          });
          if (result.band === "low" || !located.length) {
            return { done: true, ...agentResult({ output: "לא נמצא במסמך סעיף תואם בביטחון מספיק. ניתן לציין נושא מדויק יותר או מספר סעיף.", ok: true }) };
          }
          setLastTa5500Hits(located);
          return { done: true, ...agentResult({ output: "הסעיפים המתאימים מוצגים במסמך.", ok: true }) };
        }
        setLastTa5500Hits(hits);
        return { result };
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
      const notes: string[] = [];
      let line = "";
      let shown: LayerKey[] = [];
      let wholeTitles: string[] = [];
      let patch: { label: string; layers: LayerKey[] } | null = null;
      try {
        const candidates = candidateLayers(result!, s.usedItems, s.overrideZoneTypes, locations!);
        const preview = planFocus(place, candidates, s.wholeLayerUids);
        if (preview.case !== "none") {
          const view = getView();
          if (!view) throw new Error("map view unavailable");
          // A place focus needs the place geometry; without it no focus is applied and the map failure is reported.
          if (missingPlaceGeometry(place, placeGeometry)) throw new Error(`no geometry for ${place!.label}`);
          const { kept, skipped } = candidates.size
            ? await keepLayersWithFeatures(view, candidates, placeGeometry)
            : { kept: candidates, skipped: [] as LayerKey[] };
          const plan = planFocus(place, kept, s.wholeLayerUids);
          if (plan.case !== "none") {
            const applied = await applyFocus(view, plan, place, placeGeometry);
            shown = applied.layers.map((l) => l.layerKey);
            wholeTitles = applied.wholeLayers.map((w) => w.title);
            patch = { label: applied.label, layers: shown };
          }
          line = shownLine(
            place?.label ?? null,
            [...shown.map((k) => TA5500_LAYERS[k].label), ...wholeTitles],
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
      const placeNote = planPlaceNote({
        placeResolved: !!place,
        placeText: s.placeText,
        unplannedArea: s.unplannedArea,
        focusApplied: !!patch,
      });
      return agentResult({
        output: composeOutput(s.answer, line, placeNote, ...notes),
        ok: true,
        summary: focusSummary(place, shown),
        ...(patch ? { sharedStatePatch: { ta5500Focus: { value: patch } } } : {}),
      });
    }

    const next = (to: string) => (s: S) => (s.done ? END : to);

    return new StateGraph(state)
      .addNode("resolve", resolve)
      .addNode("search", search)
      .addNode("answerQuestion", answer)
      .addNode("focus", focus)
      .addEdge(START, "resolve")
      .addConditionalEdges("resolve", next("search"), ["search", END])
      .addConditionalEdges("search", next("answerQuestion"), ["answerQuestion", END])
      .addConditionalEdges("answerQuestion", next("focus"), ["focus", END])
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
