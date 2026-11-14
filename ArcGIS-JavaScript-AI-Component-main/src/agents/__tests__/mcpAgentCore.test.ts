import test from "node:test";
import assert from "node:assert/strict";
import { excludeHubServers, excludeServerTools, toolServerId } from "../mcpAgentCore";

test("toolServerId reads the hub namespace", () => {
  assert.equal(toolServerId("ta5500__search_plan"), "ta5500");
  assert.equal(toolServerId("news__a__b"), "news");
  assert.equal(toolServerId("plain_tool"), null);
});

test("excludeServerTools hides only the listed servers", () => {
  const tools = [
    { name: "ta5500__search_plan" },
    { name: "ta5500__locations" },
    { name: "news__headlines" },
    { name: "plain_tool" },
    { name: "ta5500x__other" },
  ];
  assert.deepEqual(
    excludeServerTools(tools, ["ta5500"]).map((t) => t.name),
    ["news__headlines", "plain_tool", "ta5500x__other"],
  );
  assert.equal(excludeServerTools(tools, []), tools);
});

test("excludeHubServers hides only the listed servers", () => {
  const servers = [{ id: "ta5500", label: "TA5500" }, { id: "news", label: "News" }];
  assert.deepEqual(excludeHubServers(servers, ["ta5500"]).map((s) => s.id), ["news"]);
});

test("outside TA5500 mode (empty id list) nothing is hidden", () => {
  const tools = [{ name: "ta5500__search_plan" }, { name: "news__headlines" }];
  const servers = [{ id: "ta5500", label: "TA5500" }, { id: "news", label: "News" }];
  assert.deepEqual(excludeServerTools(tools, []), tools);
  assert.deepEqual(excludeHubServers(servers, []), servers);
});
