import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { defaultCountTokens } from "acp-kernel";
import { clearLiveContextUsage, getLiveContextUsage, publishLiveContextUsage, LIVE_CONTEXT_USAGE_SYMBOL } from "../src/contract.js";
import { estimateOutboundTokens, toolDefinitionTokens } from "../src/outbound-usage.js";
import { compressionAnchorStaleness } from "../src/floor-stale.js";

type Message = SessionMessageEntry["message"];
const query = { sessionId: "usage-contract", provider: "test", modelId: "gpt" };
const model = { input: ["text", "image"] };
const tool = { name: "large-tool", description: "instructions ".repeat(2000), parameters: { type: "object", properties: { payload: { type: "string", description: "schema ".repeat(10000) } } } };
const msg = (body: object): Message => ({ timestamp: 1, ...body }) as Message;

function publish(tokens = 300_000): void {
  publishLiveContextUsage({ ...query, tokens, contextWindow: 272_000, percent: 0, source: "sent-view-estimate", updatedAt: 1 });
}

test("v1 getter is scoped to session/provider/model and preserves genuine overflow", () => {
  publish();
  assert.equal(Reflect.get(globalThis, LIVE_CONTEXT_USAGE_SYMBOL).version, 1);
  assert.equal(getLiveContextUsage(query)?.tokens, 300_000);
  assert.ok(getLiveContextUsage(query)!.percent > 100);
  for (const mismatch of [{ sessionId: "other" }, { provider: "other" }, { modelId: "other" }, { provider: undefined }]) assert.equal(getLiveContextUsage({ ...query, ...mismatch }), undefined);
  clearLiveContextUsage(query.sessionId);
});

test("records are snapshots, model replacement evicts old scope, clear is session-local", () => {
  publish();
  const returned = getLiveContextUsage(query)!;
  returned.tokens = 1;
  assert.equal(getLiveContextUsage(query)?.tokens, 300_000);
  publishLiveContextUsage({ ...getLiveContextUsage(query)!, sessionId: "other" });
  publishLiveContextUsage({ ...getLiveContextUsage(query)!, modelId: "new" });
  assert.equal(getLiveContextUsage(query), undefined);
  clearLiveContextUsage(query.sessionId);
  assert.equal(getLiveContextUsage({ ...query, modelId: "new" }), undefined);
  assert.equal(getLiveContextUsage({ ...query, sessionId: "other" })?.tokens, 300_000);
  clearLiveContextUsage("other");
});

for (const tokens of [NaN, Infinity, -1]) test(`invalid token count ${tokens} clears rather than publishing false affordability`, () => {
  publish();
  publishLiveContextUsage({ ...getLiveContextUsage(query)!, tokens });
  assert.equal(getLiveContextUsage(query), undefined);
});

test("legacy outbound estimate includes complete active tool schemas and system once", () => {
  const messages = [msg({ role: "user", content: "hello" })];
  const expected = defaultCountTokens("hello") + defaultCountTokens("system") + toolDefinitionTokens([tool]);
  assert.equal(estimateOutboundTokens(messages, "system", model, [tool]), expected);
  assert.ok(expected > 10_000);
});

test("SDK transcript counts real system sections/tools, not a duplicate fallback prompt/loadout", () => {
  const systems = [msg({ role: "system", content: "actual", sections: { large: "x ".repeat(5000), removed: null }, toolsAdded: [tool] }), msg({ role: "user", content: "hello" })];
  const expected = defaultCountTokens("actual") + defaultCountTokens("x ".repeat(5000)) + defaultCountTokens("hello") + toolDefinitionTokens([tool]);
  assert.equal(estimateOutboundTokens(systems, "unused ".repeat(50000), model, [tool, tool]), expected);
});

test("outbound meter includes compress calls/results, thinking, images and all tool arguments exactly once", () => {
  const calls = [msg({ role: "assistant", content: [{ type: "text", text: "prose" }, { type: "thinking", thinking: "reasoning" }, { type: "toolCall", name: "compress", id: "c1", arguments: { summary: "one" } }, { type: "toolCall", name: "read", id: "c2", arguments: { path: "two" } }] }), msg({ role: "toolResult", toolName: "compress", toolCallId: "c1", content: [{ type: "text", text: "receipt" }, { type: "image", data: "not-counted", mimeType: "image/png" }] })];
  const expected = ["prose", "reasoning", "receipt", JSON.stringify({ name: "compress", arguments: { summary: "one" } }), JSON.stringify({ name: "read", arguments: { path: "two" } })].reduce((sum, text) => sum + defaultCountTokens(text), 1600);
  assert.equal(estimateOutboundTokens(calls, "", model, []), expected);
  assert.equal(estimateOutboundTokens(calls, "", { input: ["text"] }, []), expected - 1600);
});

test("provider anchors are scoped, finite and invalidated by native compaction", () => {
  const anchor = { type: "message", message: { role: "assistant", provider: "a", model: "gpt", stopReason: "stop", usage: { totalTokens: 90_000 } } };
  assert.equal(compressionAnchorStaleness([anchor], [], defaultCountTokens, { id: "other", provider: "a" }).lastRealTokens, 0);
  assert.equal(compressionAnchorStaleness([anchor], [], defaultCountTokens, { id: "gpt", provider: "b" }).fresh, false);
  assert.equal(compressionAnchorStaleness([anchor, { type: "compaction" }], [], defaultCountTokens).lastRealTokens, 0);
  assert.equal(compressionAnchorStaleness([{ ...anchor, message: { ...anchor.message, usage: { totalTokens: Infinity } } }], [], defaultCountTokens).lastRealTokens, 0);
});
