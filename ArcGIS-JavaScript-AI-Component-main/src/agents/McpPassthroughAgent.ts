import { invokeToolPrompt } from "@arcgis/ai-components/utils/index.js";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
import { buildToolPromptText, dedupeGeoEntities, deriveGeoEntities, enrichGeoEntityContext, excludeHubServers, excludeServerTools, prioritizeRequestedGeoFocus, type McpToolDef } from "./mcpAgentCore";
import { MCP_NOT_PLAN_SUFFIX } from "../ta5500/prompts";
import { abortActiveMcpRequests, callMcpTool, clearMcpCaches, isAbortLikeError, listHubServers, listMcpTools, type HubServerSummary } from "../utils/mcpClient";
import { inputSchemaToZod, normalizeToolArgsForCall, truncateDescription } from "../utils/mcpZodSchema";
import { clearMcpGeoLayer, renderMcpGeoEntities, type GeoEntity } from "../utils/mcpGeoRenderer";
import { setLastAssistantGeoSnapshot } from "../utils/assistantState";
import { agentRuntimeChannels, agentResult, readAgentRequest, seedAgentMessages } from "./agentRuntime";
import { normalizeMessages, contentToText, getLastAiMessage, isAiMessageLike, isToolMessageLike, hasToolCalls, extractMessageText } from "../utils/agentHelpers";

export interface McpPassthroughAgentContext {
  baseUrl?: string;
  serverName?: string;
  /** TA5500 mode: append MCP_NOT_PLAN_SUFFIX to the routing description. */
  ta5500Mode?: boolean;
}

// The Plan agent owns the ta5500 RAG server's tools (`ta5500__*`); this agent never sees them.
// Filtered at use time so the per-endpoint tool cache in mcpClient stays untouched.
const HIDDEN_SERVER_IDS = ["ta5500"] as const;

function visibleTools(tools: McpToolDef[]): McpToolDef[] {
  return excludeServerTools(tools, HIDDEN_SERVER_IDS);
}

function visibleHubServers(servers: HubServerSummary[]): HubServerSummary[] {
  return excludeHubServers(servers, HIDDEN_SERVER_IDS);
}

function withModeSuffix(description: string, ta5500Mode: boolean): string {
  return ta5500Mode ? `${description}\n${MCP_NOT_PLAN_SUFFIX}` : description;
}

interface ToolAliasMap {
  [alias: string]: string;
}

let latestGeoRenderToken = 0;
let pendingGeoRenderTimer: ReturnType<typeof setTimeout> | null = null;
let latestMcpRunToken = 0;
const cancelBoundAssistants = new WeakSet<HTMLElement>();
// Hard cap on agent<->tools round trips per run. LangGraph's own default
// recursionLimit (25 graph steps ≈ ~12 rounds) is the only thing that stopped
// a runaway loop before this — and it crashes with an unhandled error instead
// of responding with whatever was gathered so far.
const MAX_MCP_TOOL_ROUNDS = 8;

/**
 * Single LLM call that both extracts named places from the response text AND
 * decides which structured entities (coords/polygons from tool outputs) to keep.
 * Schema is intentionally minimal — just names + indices — so the model output
 * is small and fast. Context/descriptions are filled in afterwards by
 * enrichGeoEntityContext working from the full corpus.
 */
const geoExtractAndSelectTool = tool(
  async (args: any) => JSON.stringify(args ?? {}),
  {
    name: "extract_and_select_geo_entities",
    description: "Extract geocodable place names from the assistant response and select which structured candidates to keep on the map.",
    schema: z.object({
      namedPlaces: z.array(z.string()).max(20).describe(
        "Canonical geocodable place names found anywhere in the response: cities, towns, villages, countries, landmarks, regions. " +
        "Include locations of events, article subjects, and result records. " +
        "Exclude product names, company names, acronyms, and non-geographic nouns.",
      ),
      keepStructuredIndices: z.array(z.number().int().nonnegative()).describe(
        "0-based indices from the structured candidates list to keep. Keep candidates whose place is central to the answer.",
      ),
    }),
  },
);

async function extractAndSelectGeoEntities(
  responseText: string,
  userText: string,
  structuredEntities: GeoEntity[],
  toolOutputTexts: string[] = [],
): Promise<GeoEntity[]> {
  if (!responseText.trim()) return structuredEntities;

  // Parse all tool output JSON arrays into structured { title, description, url } items.
  // These are used both as the LLM's source digest AND to build per-entity popup context.
  interface SourceItem { title: string; description: string; url: string; line: string }

  function parseSourceItems(raw: string): SourceItem[] {
    const TEXT_KEYS = ["title", "name", "headline", "description", "summary", "content", "snippet", "abstract", "label", "location", "city", "country", "region"];
    const URL_KEYS  = ["url", "link", "href", "articleUrl", "thumbnailUrl", "urlToImage"];
    function extractItemArrays(value: unknown): Array<Record<string, unknown>> {
      if (Array.isArray(value)) return value.filter((v) => v && typeof v === "object") as Array<Record<string, unknown>>;
      if (value && typeof value === "object") {
        for (const v of Object.values(value as Record<string, unknown>)) {
          const sub = extractItemArrays(v);
          if (sub.length > 1) return sub;
        }
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      const items = extractItemArrays(parsed);
      if (!items.length) return [];
      return items.slice(0, 30).map((item) => {
        let title = "", description = "", url = "";
        for (const k of TEXT_KEYS) {
          const v = item[k] ?? item[k.toLowerCase()];
          if (typeof v === "string" && v.trim()) {
            if (!title) { title = v.trim().slice(0, 160); continue; }
            if (!description) { description = v.trim().slice(0, 200); break; }
          }
        }
        for (const k of URL_KEYS) {
          const v = item[k] ?? item[k.toLowerCase()];
          if (typeof v === "string" && /^https?:\/\//i.test(v.trim()) && !/thumbnail|image|photo/i.test(k)) {
            url = v.trim(); break;
          }
        }
        const line = [title, description, url].filter(Boolean).join(" | ");
        return { title, description, url, line };
      }).filter((item) => item.line);
    } catch {
      return [];
    }
  }

  const allSourceItems: SourceItem[] = toolOutputTexts.flatMap(parseSourceItems);

  // Compact text digest for the LLM (all articles fit in one context window)
  const digestText = allSourceItems.length
    ? allSourceItems.map((item) => item.line).join("\n") + "\n\n" + responseText.slice(0, 600)
    : responseText.slice(0, 3000);

  const structuredSummary = structuredEntities.length
    ? structuredEntities
        .slice(0, 15)
        .map((e, i) => {
          const label = e.kind === "point" || e.kind === "extent" ? e.label : e.name;
          return `${i}. ${JSON.stringify(label)} (kind=${e.kind})`;
        })
        .join("\n")
    : "(none)";

  try {
    const response = await invokeToolPrompt({
      promptText:
        "You are building the geographic layer for an ArcGIS map. " +
        "Given the assistant response and raw source data, do TWO things: " +
        "(1) List every distinct geocodable place name — especially locations of events, incidents, articles, and data records. " +
        "(2) From the structured candidates, return indices of places central to the answer.",
      messages: [
        new HumanMessage(
          [
            `User request:\n${userText || ""}`,
            `Source data + response:\n${digestText}`,
            `Structured candidates:\n${structuredSummary}`,
          ].join("\n\n"),
        ),
      ],
      tools: [geoExtractAndSelectTool],
      temperature: 0,
    });

    const toolCalls = Array.isArray((response as any)?.tool_calls) ? (response as any).tool_calls : [];
    const call = toolCalls.find((tc: any) => tc?.name === "extract_and_select_geo_entities");
    if (!call?.args) return structuredEntities;

    const { namedPlaces = [] } = call.args as {
      namedPlaces?: string[];
      keepStructuredIndices?: number[];
    };

    // NOTE: keepStructuredIndices (the model's own "which structured points are
    // central to the answer" judgment) is intentionally NOT used to filter
    // structuredEntities anymore. Confirmed twice in practice: for a direct
    // "find X" MCP call, every structured point already IS the answer, and the
    // model has unreliably dropped ALL of them in favor of one or two garbled
    // "named" places (once extracting the literal server label "Israel", once
    // extracting a fragment of the user's own prompt text) — silently replacing
    // dozens of precise, real-coordinate points with a single wrong marker.
    // Structured points are numeric, source-verified data; they always survive.

    // Build per-entity context directly from the matched source items rather than
    // running regex over the raw JSON corpus. This gives each popup the specific
    // article(s) that mention that place — no repetition, no JSON fragments.
    function buildContextForPlace(name: string): import("../utils/mcpGeoRenderer").GeoContext | undefined {
      if (!allSourceItems.length) return undefined;
      const nameLower = name.toLowerCase().replace(/,.*$/, "").trim(); // "Beirut, Lebanon" → "Beirut"
      const matches = allSourceItems.filter(
        (item) => item.title.toLowerCase().includes(nameLower) || item.description.toLowerCase().includes(nameLower),
      );
      if (!matches.length) return undefined;
      // Prefer the fewest matches (most specific). If >6 matches the name is too generic — skip context.
      if (matches.length > 6) return undefined;
      const top = matches.slice(0, 2);
      return {
        summary: top.map((m) => m.description).filter(Boolean).join(" — ").slice(0, 320),
        links: top
          .filter((m) => m.url)
          .map((m) => ({ url: m.url, label: m.title || name }))
          .slice(0, 2),
      };
    }

    const namedGeo: import("../utils/mcpGeoRenderer").GeoNamedPlace[] = (namedPlaces as string[])
      .map((n) => n?.trim())
      .filter(Boolean)
      .filter((name) => !structuredEntities.some((e) => {
        const label = e.kind === "point" || e.kind === "extent" ? e.label : e.kind === "named" ? e.name : "";
        return label.toLowerCase() === name.toLowerCase();
      }))
      .map((name) => {
        const context = buildContextForPlace(name);
        return {
          kind: "named" as const,
          origin: "source" as const,
          name,
          ...(context ? { context } : {}),
        };
      });

    // For places with no source-item context, try the prose response as fallback
    const noCtx = namedGeo.filter((e) => !e.context);
    if (noCtx.length) {
      enrichGeoEntityContext(noCtx, responseText);
    }

    return dedupeGeoEntities([...structuredEntities, ...namedGeo]);
  } catch {
    return structuredEntities;
  }
}

function isMcpRunStale(runToken: number): boolean {
  return runToken !== latestMcpRunToken;
}

export function cancelPendingMcpGeoRender(): void {
  latestMcpRunToken += 1;
  abortActiveMcpRequests();
  latestGeoRenderToken += 1;
  if (pendingGeoRenderTimer != null) {
    globalThis.clearTimeout(pendingGeoRenderTimer);
    pendingGeoRenderTimer = null;
  }
  clearMcpGeoLayer();
}

function bindAssistantCancel(assistant: HTMLElement): void {
  if (cancelBoundAssistants.has(assistant)) return;
  assistant.addEventListener("arcgisCancel", () => {
    cancelPendingMcpGeoRender();
  });
  cancelBoundAssistants.add(assistant);
}

function parseQualifiedToolName(name: string): { serverId: string | null; toolName: string } {
  const idx = name.indexOf("__");
  if (idx < 0) return { serverId: null, toolName: name };
  return { serverId: name.slice(0, idx), toolName: name.slice(idx + 2) };
}

function summarizeToolDescription(def: McpToolDef, serverLabel?: string): string {
  const { toolName } = parseQualifiedToolName(def.name);
  const summary = truncateDescription(def.description, 240) || `Tool: ${toolName}`;
  return serverLabel
    ? `[Server: ${serverLabel}] ${summary} (MCP tool: ${toolName})`
    : `${summary} (MCP tool: ${toolName})`;
}

const MCP_ROUTING_BASE_DESCRIPTION =
  "Primary agent for external, non-map questions that need MCP tools or live data sources. " +
  "Use this when the answer depends on connected MCP tools, external services, or structured remote data rather than only what is already visible in the active map. " +
  "Prefer this agent whenever the answer is not already visible in the active map layers or current web map. " +
  "This agent already plots any geocodable results (points, addresses, areas) directly on the map as graphics with popups, as part of answering the question — it does not need a separate layer, FeatureServer, or map-editing agent to display or add its own results. " +
  "Do not additionally select a map layer, data-exploration, or feature-layer-editing agent for the same request just because the user asked to see the results on the map or in a popup — this agent alone fully covers that.";

function buildDescriptionFromTools(tools: McpToolDef[], serverName: string, hubServers: HubServerSummary[] = []): string {
  if (!tools.length) {
    return `${MCP_ROUTING_BASE_DESCRIPTION} Connected server: ${serverName}.`;
  }

  const serverLabels = new Map(hubServers.map((server) => [server.id, server.label]));
  const summarizedTools = tools.slice(0, 18).map((toolDef) => {
    const { serverId, toolName } = parseQualifiedToolName(toolDef.name);
    const toolServerLabel = serverId ? (serverLabels.get(serverId) || serverId) : serverName;
    const summary = truncateDescription(toolDef.description, 140) || `Tool for ${toolName.replace(/[_-]+/g, " ")}`;
    return `${toolServerLabel}: ${toolName} - ${summary}`;
  });

  const serverSummary = hubServers.length
    ? `Connected MCP sources: ${hubServers.map((server) => server.label).join(", ")}.`
    : `Connected MCP source: ${serverName}.`;

  return [
    MCP_ROUTING_BASE_DESCRIPTION,
    serverSummary,
    "Choose tools by matching the user's requested source, operation, and geographic focus.",
    "Available MCP tool coverage:",
    ...summarizedTools.map((line) => `- ${line}`),
    tools.length > summarizedTools.length ? `- ...and ${tools.length - summarizedTools.length} more MCP tools.` : "",
  ].filter(Boolean).join("\n");
}

export async function refreshMcpAgentDescription(assistant: HTMLElement): Promise<void> {
  const agentEl = assistant.querySelector('[data-agent-id="mcp-passthrough-agent"]') as any;
  if (!agentEl?.agent) return;

  const baseUrl: string = agentEl._mcpBaseUrl ?? "";
  const serverName: string = agentEl.agent.name ?? "MCP Server";
  const ta5500Mode = Boolean(agentEl._ta5500Mode);
  if (!baseUrl) return;

  try {
    clearMcpCaches(baseUrl);
    const [allTools, allHubServers] = await Promise.all([
      listMcpTools(baseUrl),
      listHubServers(baseUrl),
    ]);
    const tools = visibleTools(allTools);
    if (tools.length) {
      agentEl.agent = {
        ...agentEl.agent,
        description: withModeSuffix(buildDescriptionFromTools(tools, serverName, visibleHubServers(allHubServers)), ta5500Mode),
      };
    }
  } catch {}
}

function sanitizeMessagesForPrompt(messages: any[]): any[] {
  const flattened = normalizeMessages(messages);
  const sanitized: any[] = [];
  let awaitingToolResponses = false;

  for (const message of flattened) {
    if (!message) continue;
    if (isToolMessageLike(message)) {
      if (awaitingToolResponses) sanitized.push(message);
      continue;
    }
    sanitized.push(message);
    awaitingToolResponses = isAiMessageLike(message) && hasToolCalls(message);
  }

  let tailToolBlockStart = -1;
  if (sanitized.length) {
    let index = sanitized.length - 1;
    while (index >= 0 && isToolMessageLike(sanitized[index])) index -= 1;
    if (index >= 0 && index < sanitized.length - 1 && isAiMessageLike(sanitized[index]) && hasToolCalls(sanitized[index])) {
      tailToolBlockStart = index;
    }
  }

  const visibleHistory = sanitized.filter((message) => !isToolMessageLike(message) && !(isAiMessageLike(message) && hasToolCalls(message)));
  const recentVisibleHistory: any[] = [];
  let totalChars = 0;
  for (let index = visibleHistory.length - 1; index >= 0; index -= 1) {
    const message = visibleHistory[index];
    const messageText = extractMessageText(message);
    const nextTotal = totalChars + messageText.length;
    if (recentVisibleHistory.length >= 8 || nextTotal > 16000) break;
    recentVisibleHistory.unshift(message);
    totalChars = nextTotal;
  }

  if (tailToolBlockStart >= 0) {
    return [...recentVisibleHistory, ...sanitized.slice(tailToolBlockStart)];
  }
  return recentVisibleHistory;
}

function extractLastHumanMessageText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const isHuman =
      HumanMessage.isInstance(message) ||
      message.getType?.() === "human" ||
      message.lc_kwargs?.type === "human" ||
      message.kwargs?.type === "human" ||
      message.role === "user";
    if (!isHuman) continue;
    if (typeof message.lc_kwargs?.content === "string" && message.lc_kwargs.content.trim()) return message.lc_kwargs.content.trim();
    if (typeof message.kwargs?.content === "string" && message.kwargs.content.trim()) return message.kwargs.content.trim();
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
  }
  return "";
}

function makeSafeToolAlias(index: number): string {
  return `mcp_tool_${index + 1}`;
}

function deriveSnapshotTitle(text: string): string {
  const cleaned = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Latest assistant results";
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0]?.trim() || cleaned;
  return firstSentence.length > 88 ? `${firstSentence.slice(0, 85).trimEnd()}...` : firstSentence;
}

export function registerMcpPassthroughAgent(
  assistant: HTMLElement,
  ctx: McpPassthroughAgentContext = {},
) {
  bindAssistantCancel(assistant);

  const agentId = "mcp-passthrough-agent";

  const createGraph = () => {
    const state = Annotation.Root({
      ...agentRuntimeChannels(),
      // Own message loop (history + AI tool calls + tool results). In 5.1 the
      // orchestrator passes only agentExecutionContext, so agentNode seeds this
      // channel from it on the first pass.
      messages: Annotation({
        reducer: (current: any[] = [], update: any) => {
          const next = Array.isArray(update) ? update : [update];
          return [...current, ...next.filter(Boolean)];
        },
        default: () => [],
      }),
      toolAliasMap: Annotation({
        reducer: (current: ToolAliasMap = {}, update: ToolAliasMap | undefined) => ({ ...current, ...(update ?? {}) }),
        default: () => ({}),
      }),
      toolCallArgsList: Annotation({
        reducer: (_current: Record<string, unknown>[] = [], update: Record<string, unknown>[] | undefined) => update ?? [],
        default: () => [],
      }),
      toolOutputTextList: Annotation({
        reducer: (_current: string[] = [], update: string[] | undefined) => update ?? [],
        default: () => [],
      }),
      canceled: Annotation({
        reducer: (_current: boolean = false, update: boolean | undefined) => Boolean(update),
        default: () => false,
      }),
      toolRoundCount: Annotation({
        reducer: (_current: number = 0, update: number | undefined) => update ?? 0,
        default: () => 0,
      }),
    });

    async function agentNode(agentState: any) {
      const runToken = latestMcpRunToken;
      try {
        const request = readAgentRequest(agentState);
        const ownMessages = normalizeMessages(agentState?.messages);
        // First pass: the own loop is empty — seed it from the 5.1 run context.
        const seedMessages = ownMessages.length ? [] : seedAgentMessages(request.messages, request.request);
        const messages = ownMessages.length ? ownMessages : seedMessages;
        const promptMessages = sanitizeMessagesForPrompt(messages);
        const serverLabel = ctx.serverName || "MCP";
        const resolvedUrl = ctx.baseUrl || "";
        const userText = request.request || extractLastHumanMessageText(messages);

        let mcpToolDefs: McpToolDef[] = [];
        let discoveryError: string | null = null;
        try {
          mcpToolDefs = visibleTools(await listMcpTools(resolvedUrl));
          if (isMcpRunStale(runToken)) {
            return { messages: [], outputMessage: "", canceled: true };
          }
        } catch (err: any) {
          if (isMcpRunStale(runToken) || isAbortLikeError(err)) {
            return { messages: [], outputMessage: "", canceled: true };
          }
          discoveryError = err?.message ?? "Failed to discover tools from the MCP server.";
        }

        if (discoveryError || !mcpToolDefs.length) {
          return {
            ...agentResult({
              output: discoveryError
                ? `Could not connect to the ${serverLabel}: ${discoveryError}`
                : `The ${serverLabel} did not expose any tools.`,
              ok: false,
            }),
            messages: [],
          };
        }

        const aliasMap: ToolAliasMap = {};
        const hubServers = visibleHubServers(await listHubServers(resolvedUrl));
        const serverLabels = new Map(hubServers.map((server) => [server.id, server.label]));
        const priorToolRounds = Number(agentState?.toolRoundCount ?? 0);
        const langchainTools = mcpToolDefs.map((def, index) => {
          const alias = makeSafeToolAlias(index);
          aliasMap[alias] = def.name;
          const { serverId } = parseQualifiedToolName(def.name);
          const toolServerLabel = serverId ? (serverLabels.get(serverId) || serverId) : undefined;
          return tool(
            async (args: any) => callMcpTool(
              resolvedUrl,
              def.name,
              normalizeToolArgsForCall(def.inputSchema, (args as Record<string, unknown>) || {}),
            ),
            {
              name: alias,
              description: summarizeToolDescription(def, toolServerLabel),
              schema: inputSchemaToZod(def.inputSchema) as any,
            },
          );
        });

        const response = await invokeToolPrompt({
          promptText: `${buildToolPromptText(serverLabel, hubServers, mcpToolDefs.length, priorToolRounds)}${userText ? `\n\nCurrent user request: ${userText}` : ""}`,
          messages: promptMessages,
          tools: langchainTools,
          temperature: 0,
        });

        if (isMcpRunStale(runToken)) {
          return { messages: [], outputMessage: "", canceled: true };
        }

        return {
          messages: [...seedMessages, response],
          toolAliasMap: aliasMap,
          canceled: false,
          toolRoundCount: priorToolRounds,
        };
      } catch (err: any) {
        if (isMcpRunStale(runToken) || isAbortLikeError(err)) {
          return { messages: [], outputMessage: "", canceled: true };
        }
        return {
          ...agentResult({
            output: `MCP agent failed to process the request: ${err?.message ?? "Unknown error."}`,
            ok: false,
          }),
          messages: [],
        };
      }
    }

    async function toolsNode(agentState: any) {
      const runToken = latestMcpRunToken;
      try {
        const messages = normalizeMessages(agentState?.messages);
        const lastAiMessage = getLastAiMessage(messages);
        if (!lastAiMessage?.tool_calls?.length) return {};

        const aliasMap = (agentState?.toolAliasMap ?? {}) as ToolAliasMap;
        const resolvedUrl = ctx.baseUrl || "";
        const priorArgs: Record<string, unknown>[] = Array.isArray(agentState?.toolCallArgsList) ? agentState.toolCallArgsList : [];
        const priorOutputs: string[] = Array.isArray(agentState?.toolOutputTextList) ? agentState.toolOutputTextList : [];
        const collectedArgs: Record<string, unknown>[] = [];
        const collectedOutputs: string[] = [];

        const toolMessages = await Promise.all(
          lastAiMessage.tool_calls.map(async (toolCall: any) => {
            try {
              const originalToolName = aliasMap[toolCall.name] || toolCall.name;
              const args = (toolCall.args as Record<string, unknown>) || {};
              collectedArgs.push(args);
              const result = await callMcpTool(resolvedUrl, originalToolName, args);
              if (isMcpRunStale(runToken)) return null;
              if (result) collectedOutputs.push(result);
              return new ToolMessage({ content: result, tool_call_id: toolCall.id ?? toolCall.name });
            } catch (error: any) {
              if (isMcpRunStale(runToken) || isAbortLikeError(error)) return null;
              return new ToolMessage({
                content: error?.message || `Failed to call ${toolCall.name} on the ${ctx.serverName || "MCP"} server.`,
                tool_call_id: toolCall.id ?? toolCall.name,
                status: "error",
              });
            }
          }),
        );

        return {
          messages: toolMessages.filter(Boolean),
          toolCallArgsList: [...priorArgs, ...collectedArgs],
          toolOutputTextList: [...priorOutputs, ...collectedOutputs],
          canceled: false,
          toolRoundCount: Number(agentState?.toolRoundCount ?? 0) + 1,
        };
      } catch (err: any) {
        if (isMcpRunStale(runToken) || isAbortLikeError(err)) {
          return { messages: [], canceled: true };
        }
        return {
          messages: [
            new ToolMessage({
              content: `MCP tools execution failed: ${err?.message ?? "Unknown error."}`,
              tool_call_id: "mcp-tools-node-error",
              status: "error",
            }),
          ],
        };
      }
    }

    function routeAfterAgent(agentState: any) {
      try {
        if (agentState?.canceled) return "respond";
        const messages = normalizeMessages(agentState?.messages);
        const lastAiMessage = getLastAiMessage(messages);
        if (!lastAiMessage) return "respond";
        if (!lastAiMessage.tool_calls?.length) return "respond";
        // Hard stop, not just a prompt hint: without this, a broad/open-ended
        // query can make the model keep calling tools indefinitely, and the
        // only thing that ever stopped it was LangGraph's own external
        // recursionLimit (default 25 steps ≈ ~12 rounds) — which crashes with
        // an unhandled GraphRecursionError instead of degrading gracefully.
        const roundsSoFar = Number(agentState?.toolRoundCount ?? 0);
        if (roundsSoFar >= MAX_MCP_TOOL_ROUNDS) return "respond";
        return "tools";
      } catch {
        return "respond";
      }
    }

    function respondNode(agentState: any) {
      if (agentState?.canceled) {
        return agentResult({ output: "", summary: "Canceled.", ok: false });
      }
      // agentNode already reported a failure (discovery error / exception) via
      // agentResult; keep that result instead of appending a generic fallback.
      if (agentState?.status === "failed") {
        return {};
      }

      const messages = normalizeMessages(agentState?.messages);
      const userText = readAgentRequest(agentState).request || extractLastHumanMessageText(messages);
      const lastAiMessage = getLastAiMessage(messages);
      const aiText = contentToText(lastAiMessage?.content);
      const text = aiText || `The ${ctx.serverName || "MCP"} server did not return a response.`;
      const toolArgs: Record<string, unknown>[] = agentState?.toolCallArgsList ?? [];
      const toolOutputs: string[] = agentState?.toolOutputTextList ?? [];

      latestGeoRenderToken += 1;
      const currentToken = latestGeoRenderToken;
      if (pendingGeoRenderTimer != null) {
        globalThis.clearTimeout(pendingGeoRenderTimer);
      }

      pendingGeoRenderTimer = globalThis.setTimeout(() => {
        pendingGeoRenderTimer = null;

        void (async () => {
          try {
            // Structured data (coords/bbox from tool outputs) is extracted
            // deterministically first. Then a single LLM call both extracts
            // named places from the response text AND decides which structured
            // entities to keep — replacing the former extract+prune two-call pattern.
            const structuredEntities = await deriveGeoEntities(text, toolArgs, toolOutputs);
            const selectedEntities = await extractAndSelectGeoEntities(text, userText, structuredEntities, toolOutputs);
            const entities = prioritizeRequestedGeoFocus(selectedEntities, userText, toolArgs);
            // TEMP DIAGNOSTIC — remove once the datagov station-count drop is confirmed fixed.
            const kindCounts = (list: GeoEntity[]) =>
              list.reduce((acc: Record<string, number>, e) => {
                acc[e.kind] = (acc[e.kind] ?? 0) + 1;
                return acc;
              }, {});
            console.warn("[mcp-geo-render] counts", {
              structured: structuredEntities.length,
              structuredKinds: kindCounts(structuredEntities),
              selected: selectedEntities.length,
              selectedKinds: kindCounts(selectedEntities),
              final: entities.length,
              finalKinds: kindCounts(entities),
              finalSample: entities.slice(0, 3),
            });
            if (currentToken !== latestGeoRenderToken) return;

            setLastAssistantGeoSnapshot({
              title: deriveSnapshotTitle(text),
              responseText: text,
              updatedAt: new Date().toISOString(),
              entities: entities.map((entity: GeoEntity) => ({
                kind: entity.kind,
                origin: entity.origin,
                label: entity.kind === "point" || entity.kind === "extent" ? entity.label : entity.name,
                lat: entity.kind === "point" ? entity.lat : undefined,
                lon: entity.kind === "point" ? entity.lon : undefined,
                west: entity.kind === "extent" ? entity.west : undefined,
                south: entity.kind === "extent" ? entity.south : undefined,
                east: entity.kind === "extent" ? entity.east : undefined,
                north: entity.kind === "extent" ? entity.north : undefined,
                description: entity.description,
                summary: entity.context?.summary,
                links: entity.context?.links,
                fields: entity.context?.mcpFields,
              })),
            });

            if (!entities.length) {
              clearMcpGeoLayer();
              return;
            }

            await renderMcpGeoEntities(entities);
          } catch (err) {
            // This catch previously swallowed everything silently — log it so
            // render failures are visible instead of just "nothing happened".
            console.error("[mcp-geo-render] render pipeline failed:", err);
          }
        })();
      }, 0);

      return agentResult({ output: text, ok: Boolean(aiText) });
    }

    return new StateGraph(state)
      .addNode("agent", agentNode)
      .addNode("tools", toolsNode)
      .addNode("respond", respondNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeAfterAgent, ["tools", "respond"])
      .addEdge("tools", "agent")
      .addEdge("respond", END);
  };

  const serverLabel = ctx.serverName || "MCP Server";
  const agent = {
    id: agentId,
    name: serverLabel,
    description: withModeSuffix(
      `${MCP_ROUTING_BASE_DESCRIPTION} Connected server: ${serverLabel}. Do not use this for questions about the active map, current layers, or content already loaded in the app.`,
      Boolean(ctx.ta5500Mode),
    ),
    createGraph,
    workspace: {},
  } as any;

  const existing = assistant.querySelector(`[data-agent-id="${agentId}"]`);
  if (existing) {
    const outgoingUrl = (existing as any)._mcpBaseUrl;
    if (outgoingUrl) clearMcpCaches(outgoingUrl);
    existing.remove();
  }

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", agentId);
  agentEl._mcpBaseUrl = ctx.baseUrl ?? "";
  agentEl._ta5500Mode = Boolean(ctx.ta5500Mode);
  agentEl.agent = agent;
  assistant.appendChild(agentEl);
}
