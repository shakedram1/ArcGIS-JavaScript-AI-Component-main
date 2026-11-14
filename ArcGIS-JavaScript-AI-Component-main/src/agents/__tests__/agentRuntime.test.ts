import test from "node:test";
import assert from "node:assert/strict";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph/web";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { agentRuntimeChannels, agentResult, readAgentRequest, seedAgentMessages } from "../agentRuntime";

test("graph node sees the 5.1 request", async () => {
  const State = Annotation.Root({ ...agentRuntimeChannels() });
  const graph = new StateGraph(State)
    .addNode("n", (state: any) => agentResult({ output: readAgentRequest(state).request, ok: true }))
    .addEdge(START, "n")
    .addEdge("n", END)
    .compile();
  const q = "אילו נקודות תשתית מתוכננות בנאות אפקה?";
  const out: any = await graph.invoke({
    agentExecutionContext: { userRequest: q, assignedTask: "", messages: [], priorSteps: [], sharedState: {} },
  } as any);
  assert.equal(out.outputMessage, q);
  assert.equal(out.status, "success");
});

test("assignedTask wins over userRequest", () => {
  const r = readAgentRequest({ agentExecutionContext: { assignedTask: "t1", userRequest: "u" } });
  assert.equal(r.request, "t1");
});

test("falls back to last human message", () => {
  const r = readAgentRequest({
    agentExecutionContext: { messages: [new HumanMessage("a"), new AIMessage("b"), new HumanMessage("c")] },
  });
  assert.equal(r.request, "c");
});

test("agentResult failed", () => {
  const r = agentResult({ output: "x", ok: false });
  assert.equal(r.status, "failed");
  assert.equal(r.summary, "x");
});

test("seedAgentMessages adds the request to an empty history", () => {
  const seeded = seedAgentMessages([], "אילו נקודות תשתית מתוכננות בנאות אפקה?");
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]._getType(), "human");
  assert.equal(seeded[0].content, "אילו נקודות תשתית מתוכננות בנאות אפקה?");
});

test("seedAgentMessages keeps history that already ends with the request", () => {
  const history = [new HumanMessage("a"), new AIMessage("b"), new HumanMessage("q")];
  const seeded = seedAgentMessages(history, "q");
  assert.deepEqual(seeded, history);
});

test("seedAgentMessages appends the request when the last human message differs", () => {
  const history = [new HumanMessage("q"), new AIMessage("b")];
  const seeded = seedAgentMessages(history, "assigned task");
  assert.equal(seeded.length, 3);
  assert.equal(seeded[2].content, "assigned task");
  assert.equal(seedAgentMessages(history, "").length, 2);
});
