// MCP JSON-RPC client over fetch: initialize handshake, tools/list and tools/call, with per-endpoint caches,
// request timeouts and a shared registry of in-flight requests (abortActiveMcpRequests cancels them all).
// Moved from McpPassthroughAgent.ts so other modules (the TA5500 RAG client) share the same transport.
// Uses only fetch/AbortController/setTimeout, so it loads in Node (tsx --test) as well as the browser.
// Absolute http(s) MCP URLs are rewritten to the dev-only Vite relay (/dev-mcp-relay/...).
import { normalizeUrl, resolveHubServersUrl, type McpToolDef } from "../agents/mcpAgentCore";

export type McpToolResult = { content?: unknown; structuredContent?: unknown; isError?: boolean };

export interface HubServerSummary {
  id: string;
  label: string;
  status?: string;
}

const activeMcpAbortControllers = new Set<AbortController>();
// Timeout timers are cleared when a request ends, so a finished request leaves no pending timer
// (in Node a pending timer would also keep the process, e.g. the test runner, alive until it fires).
const mcpAbortTimers = new WeakMap<AbortController, ReturnType<typeof setTimeout>>();
const MCP_DISCOVERY_TIMEOUT_MS = 8_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 15_000;
const MCP_NOTIFY_TIMEOUT_MS = 3_000;
const HUB_SERVERS_TIMEOUT_MS = 4_000;

export function beginMcpAbortController(timeoutMs?: number): AbortController {
  const controller = new AbortController();
  activeMcpAbortControllers.add(controller);
  if (timeoutMs && timeoutMs > 0) {
    mcpAbortTimers.set(controller, globalThis.setTimeout(() => controller.abort(`timeout:${timeoutMs}`), timeoutMs));
  }
  return controller;
}

export function endMcpAbortController(controller: AbortController): void {
  activeMcpAbortControllers.delete(controller);
  const timer = mcpAbortTimers.get(controller);
  if (timer !== undefined) globalThis.clearTimeout(timer);
}

export function abortActiveMcpRequests(): void {
  for (const controller of activeMcpAbortControllers) {
    controller.abort();
  }
  activeMcpAbortControllers.clear();
}

export function isAbortLikeError(error: unknown): boolean {
  const name = (error as any)?.name;
  const message = String((error as any)?.message ?? "");
  return name === "AbortError" || /abort/i.test(message);
}

function toRelayUrl(absoluteUrl: string): string {
  try {
    const url = new URL(absoluteUrl);
    const scheme = url.protocol.replace(":", "");
    return `/dev-mcp-relay/${scheme}/${url.host}${url.pathname}`;
  } catch {
    return absoluteUrl;
  }
}

export function resolveFetchUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? toRelayUrl(url) : url;
}

async function mcpPost(fetchUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const timeoutMs = typeof body.__timeoutMs === "number" ? Number(body.__timeoutMs) : undefined;
  const payload = { ...body } as Record<string, unknown>;
  delete payload.__timeoutMs;
  const controller = beginMcpAbortController(timeoutMs);
  try {
    const response = await fetch(fetchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {}
      throw new Error(`MCP server returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const parsed: any = JSON.parse(line.slice(6).trim());
        if (parsed.error) throw new Error(String(parsed.error.message ?? "MCP RPC error"));
        if ("result" in parsed) return parsed.result;
      }
      throw new Error("No JSON-RPC result found in MCP SSE response.");
    }

    const json: any = await response.json();
    if (json.error) throw new Error(String(json.error.message ?? "MCP RPC error"));
    return json.result;
  } catch (error) {
    if (isAbortLikeError(error) && timeoutMs) {
      throw new Error(`MCP request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    endMcpAbortController(controller);
  }
}

export function mcpRequest(endpointUrl: string, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  return mcpPost(url, { jsonrpc: "2.0", id: 1, method, params, __timeoutMs: timeoutMs });
}

async function mcpNotify(endpointUrl: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  const controller = beginMcpAbortController(MCP_NOTIFY_TIMEOUT_MS);
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    signal: controller.signal,
  }).catch(() => {}).finally(() => {
    endMcpAbortController(controller);
  });
}

const initializedEndpoints = new Set<string>();
const mcpToolsCache = new Map<string, { tools: McpToolDef[]; at: number }>();
const hubServersCache = new Map<string, { servers: HubServerSummary[]; at: number }>();
const TOOL_CACHE_TTL_MS = 300_000;
const HUB_SERVERS_CACHE_TTL_MS = 60_000;

export async function ensureInitialized(endpointUrl: string): Promise<void> {
  const key = normalizeUrl(endpointUrl);
  if (initializedEndpoints.has(key)) return;
  await mcpRequest(endpointUrl, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "mcp-passthrough-agent", version: "1.0.0" },
  }, MCP_DISCOVERY_TIMEOUT_MS);
  await mcpNotify(endpointUrl, "notifications/initialized");
  initializedEndpoints.add(key);
}

export function clearMcpCaches(endpointUrl: string): void {
  const key = normalizeUrl(endpointUrl);
  initializedEndpoints.delete(key);
  mcpToolsCache.delete(key);
  hubServersCache.delete(key);
}

export async function listMcpTools(endpointUrl: string): Promise<McpToolDef[]> {
  const key = normalizeUrl(endpointUrl);
  const cached = mcpToolsCache.get(key);
  if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/list", {}, MCP_DISCOVERY_TIMEOUT_MS);
  const tools: McpToolDef[] = Array.isArray(result?.tools) ? result.tools : [];
  mcpToolsCache.set(key, { tools, at: Date.now() });
  return tools;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return JSON.stringify(part);
      })
      .join("\n")
      .trim();
  }
  return content != null ? JSON.stringify(content) : "";
}

/** The raw `tools/call` result, for callers that read `structuredContent` or handle `isError` themselves. */
export async function callMcpToolRaw(endpointUrl: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/call", { name, arguments: args }, MCP_TOOL_CALL_TIMEOUT_MS);
  return (result ?? {}) as McpToolResult;
}

export async function callMcpTool(endpointUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  const result: any = await callMcpToolRaw(endpointUrl, name, args);
  if (result?.isError) {
    return `Tool returned an error: ${extractText(result.content) || "Unknown tool error."}`;
  }
  return extractText(result?.content) || JSON.stringify(result ?? "");
}

export async function listHubServers(endpointUrl: string): Promise<HubServerSummary[]> {
  const cacheKey = normalizeUrl(endpointUrl);
  const cached = hubServersCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HUB_SERVERS_CACHE_TTL_MS) {
    return cached.servers;
  }
  const serversUrl = resolveHubServersUrl(endpointUrl);
  if (!serversUrl) return [];

  const controller = beginMcpAbortController(HUB_SERVERS_TIMEOUT_MS);
  try {
    const response = await fetch(resolveFetchUrl(serversUrl), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json: any = await response.json();
    const servers = Array.isArray(json?.servers)
      ? json.servers.map((server: any) => ({
          id: String(server.id ?? ""),
          label: String(server.label ?? server.id ?? ""),
          status: server.status ? String(server.status) : undefined,
        }))
      : [];
    hubServersCache.set(cacheKey, { servers, at: Date.now() });
    return servers;
  } catch {
    return [];
  } finally {
    endMcpAbortController(controller);
  }
}
