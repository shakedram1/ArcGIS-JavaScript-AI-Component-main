// TA5500 Scope agent (spec §5.2, §5.5): requests about places outside Tel Aviv-Yafo or topics unrelated to the
// plan and its map get a short Hebrew decline saying what the assistant can do. No LLM call, no map change.
import { StateGraph, Annotation, START, END } from "@langchain/langgraph/web";
import { agentRuntimeChannels, agentResult } from "./agentRuntime";
import { SCOPE_AGENT_DESCRIPTION, SCOPE_REPLY } from "../ta5500/prompts";

const AGENT_ID = "ta5500-scope";

export function registerScopeAgent(assistant: HTMLElement): void {
  const createGraph = () => {
    const state = Annotation.Root({ ...agentRuntimeChannels() });
    const reply = () => agentResult({ output: SCOPE_REPLY, ok: true, summary: "out of scope" });
    return new StateGraph(state).addNode("reply", reply).addEdge(START, "reply").addEdge("reply", END);
  };

  const agent = {
    id: AGENT_ID,
    name: "Out of scope",
    description: SCOPE_AGENT_DESCRIPTION,
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
