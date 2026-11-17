import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentRuntimeChannels } from "../agentRuntime";

// LangGraph refuses a node that has the same name as a state channel ("answer is already being used as a state
// attribute …") — at graph build time, i.e. the agent fails on its first run. The agents build their graph inside
// register…(), which needs the DOM, so this reads their source.
const AGENTS = ["PlanAgent.ts", "Ta5500MapAgent.ts", "ScopeAgent.ts"];

for (const file of AGENTS) {
  test(`${file}: no graph node is named like a state channel`, () => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const channels = new Set([...Object.keys(agentRuntimeChannels()), ...[...src.matchAll(/^\s+(\w+): last</gm)].map((m) => m[1])]);
    const nodes = [...src.matchAll(/\.addNode\("([^"]+)"/g)].map((m) => m[1]);
    assert.ok(file === "ScopeAgent.ts" || nodes.length > 0, "found the graph nodes");
    assert.deepEqual(nodes.filter((n) => channels.has(n)), []);
  });
}
