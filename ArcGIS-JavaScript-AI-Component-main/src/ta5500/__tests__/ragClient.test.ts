import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPlanLocations, parsePlanLocations, parseSearchPlanResult, PlanServiceError, searchPlan } from "../ragClient";
import type { McpToolResult } from "../../utils/mcpClient";

const fixture = (name: string): McpToolResult =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const SERVICE_DOWN = "שירות תוכנית המתאר אינו זמין כרגע. נסו שוב בעוד מספר דקות.";

test("parses structured search", () => {
  const r = parseSearchPlanResult(fixture("search-610.json"));
  assert.ok(["high", "medium", "low"].includes(r.band));
  assert.ok(r.location.areas.includes("610"));
  assert.ok(r.hits.length > 0);
  assert.ok(r.text.startsWith("רמת התאמה"));
  assert.equal(typeof r.hits[0].citation, "string");
  assert.equal(typeof r.hits[0].heading_path, "string");
});

test("isError throws PlanServiceError", () => {
  assert.throws(
    () => parseSearchPlanResult({ isError: true, content: [{ type: "text", text: "x" }] }),
    (e: unknown) => e instanceof PlanServiceError && e.message === SERVICE_DOWN,
  );
});

test("missing text throws PlanServiceError", () => {
  assert.throws(() => parseSearchPlanResult({ content: [] }), PlanServiceError);
});

test("text without structuredContent still parses with empty location", () => {
  const r = parseSearchPlanResult({ content: [{ type: "text", text: "רמת התאמה: נמוכה\n\nטקסט" }] });
  assert.equal(r.band, "low");
  assert.deepEqual(r.location, { areas: [], subareas: [], zone_types: [], entities: [] });
  assert.deepEqual(r.hits, []);
});

test("parses plan locations", () => {
  const loc = parsePlanLocations(fixture("locations.json"));
  assert.ok(loc.areas.length > 0);
  assert.ok(loc.zone_types.length > 0);
  assert.ok(loc.gis_codes.every((g) => g.key === "zone_types" || g.key === "headings"));
});

// A fake MCP hub: records tools/call requests and answers from `reply`.
function stubHub(reply: (name: string, args: any) => unknown) {
  const calls: { name: string; args: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const req = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = {};
    if (req.method === "tools/call") {
      calls.push({ name: req.params.name, args: req.params.arguments });
      result = reply(req.params.name, req.params.arguments);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id ?? 1, result }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("searchPlan calls ta5500__search_plan with the question and non-empty filters", async () => {
  const hub = stubHub(() => fixture("search-610.json"));
  try {
    const r = await searchPlan("/api/mcp-search-test", " מה מותר? ", { areas: ["610"], zone_types: [] });
    assert.deepEqual(hub.calls, [{ name: "ta5500__search_plan", args: { question: "מה מותר?", areas: ["610"] } }]);
    assert.ok(r.hits.length > 0);
  } finally {
    hub.restore();
  }
});

test("getPlanLocations calls ta5500__get_plan_locations once per session", async () => {
  const hub = stubHub(() => fixture("locations.json"));
  try {
    const a = await getPlanLocations("/api/mcp-locations-test");
    const b = await getPlanLocations("/api/mcp-locations-test");
    assert.equal(a, b);
    assert.deepEqual(hub.calls.map((c) => c.name), ["ta5500__get_plan_locations"]);
  } finally {
    hub.restore();
  }
});

test("a failed locations load throws PlanServiceError and is retried", async () => {
  let fail = true;
  const hub = stubHub(() => (fail ? { isError: true, content: [{ type: "text", text: "down" }] } : fixture("locations.json")));
  try {
    await assert.rejects(getPlanLocations("/api/mcp-retry-test"), PlanServiceError);
    fail = false;
    assert.ok((await getPlanLocations("/api/mcp-retry-test")).areas.length > 0);
  } finally {
    hub.restore();
  }
});
