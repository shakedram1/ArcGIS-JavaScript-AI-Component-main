import { Annotation } from "@langchain/langgraph/web";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

export type SharedState = Record<string, { value: unknown }>;

export type AgentRunContext = {
  userRequest: string;
  assignedTask: string;
  messages: BaseMessage[];
  priorSteps: unknown[];
  sharedState: SharedState;
};

export type AgentStatus = "success" | "failed" | "unknown" | undefined;

/** Channels of the 5.1 agent runtime contract. Spread into Annotation.Root({ ...agentRuntimeChannels(), ...own }). */
export function agentRuntimeChannels() {
  return {
    agentExecutionContext: Annotation<AgentRunContext | undefined>({
      reducer: (_prev, next) => next,
      default: () => undefined,
    }),
    outputMessage: Annotation<string>({
      reducer: (prev, next) => (prev ? (next ? `${prev}\n\n${next}` : prev) : next ?? ""),
      default: () => "",
    }),
    summary: Annotation<string>({
      reducer: (_prev, next) => next,
      default: () => "",
    }),
    status: Annotation<AgentStatus>({
      reducer: (_prev, next) => next,
      default: () => undefined,
    }),
    sharedStatePatch: Annotation<SharedState>({
      reducer: (prev, next) => ({ ...(prev ?? {}), ...(next ?? {}) }),
      default: () => ({}),
    }),
  };
}

function textOf(m: BaseMessage | undefined): string {
  if (!m) return "";
  const c: unknown = (m as any).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  }
  return "";
}

export function readAgentRequest(state: { agentExecutionContext?: Partial<AgentRunContext> }): {
  request: string;
  userRequest: string;
  messages: BaseMessage[];
  sharedState: SharedState;
} {
  const ctx = state?.agentExecutionContext ?? {};
  const messages = ctx.messages ?? [];
  const userRequest = (ctx.userRequest ?? "").trim();
  let request = (ctx.assignedTask ?? "").trim() || userRequest;
  if (!request) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i];
      const type = typeof m._getType === "function" ? m._getType() : m.type;
      if (type === "human") {
        request = textOf(messages[i]).trim();
        break;
      }
    }
  }
  return { request, userRequest, messages, sharedState: ctx.sharedState ?? {} };
}

function isHumanMessage(m: any): boolean {
  if (!m) return false;
  const type = typeof m._getType === "function" ? m._getType() : m.type;
  return type === "human" || m.role === "user";
}

/**
 * Seed an agent's own message loop from the 5.1 run context: the orchestrator's
 * history, plus the request as a trailing human message when the last human
 * message in that history is not already the request (the history may be empty).
 */
export function seedAgentMessages(history: BaseMessage[] | undefined, request: string): BaseMessage[] {
  const messages = Array.isArray(history) ? history.filter(Boolean) : [];
  const text = request.trim();
  if (!text) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanMessage(messages[i])) {
      if (textOf(messages[i]).trim() === text) return messages;
      break;
    }
  }
  return [...messages, new HumanMessage(text)];
}

export function agentResult(p: {
  output: string;
  summary?: string;
  ok: boolean;
  sharedStatePatch?: SharedState;
}) {
  return {
    outputMessage: p.output,
    summary: p.summary ?? p.output.slice(0, 120),
    status: (p.ok ? "success" : "failed") as "success" | "failed",
    ...(p.sharedStatePatch ? { sharedStatePatch: p.sharedStatePatch } : {}),
  };
}
