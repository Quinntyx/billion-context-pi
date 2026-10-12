import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "../src/index.js";
import { extractText } from "../src/messages.js";
import { compressionAnchorStaleness } from "../src/floor-stale.js";
import { clearLiveContextUsage, getLiveContextUsage } from "../src/contract.js";

(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";

type Message = SessionMessageEntry["message"];
type ContextHandler = (event: { type: "context"; messages: Message[] }, ctx: ExtensionContext) => Promise<{ messages: Message[] } | undefined>;
type Tool = { name: string; execute: (id: string, args: object, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: unknown }> };
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

const WINDOW = 1_048_576;
const INFLATED = 952_000;
const REAL = 40_000;
const BULK = "lorem ".repeat(1800);

function message(id: string, body: object): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-10-10T21:09:02.801Z", message: { timestamp: 1, ...body } } as SessionMessageEntry;
}

function usedAssistant(id: string, input: number): SessionMessageEntry {
  return message(id, { role: "assistant", content: [{ type: "text", text: BULK }], stopReason: "stop", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input } });
}

function stream(failure?: "error" | "aborted" | "zero", real = REAL): SessionEntry[] {
  const entries: SessionEntry[] = Array.from({ length: 18 }, (_, i) => message(`e${i}`, { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: BULK }] }));
  if (real > 0) entries.push(usedAssistant("anchor", real));
  if (failure) {
    entries.push(message("failed", { role: "assistant", content: [], stopReason: failure === "zero" ? "stop" : failure, errorMessage: "Stream idle timeout", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }));
    entries.push({ type: "context_edit", id: "omit", parentId: "failed", timestamp: "2026-10-10T21:09:02.801Z", targetId: "failed", replacement: null } as SessionEntry);
  }
  return entries;
}

function setup(entries: SessionEntry[], reported = INFLATED) {
  const handlers = new Map<string, ContextHandler>();
  const allHandlers = new Map<string, ContextHandler[]>();
  const tools: Tool[] = [];
  const commands = new Map<string, Command>();
  const api = {
    on(name: string, handler: ContextHandler) {
      handlers.set(name, handler);
      allHandlers.set(name, [...(allHandlers.get(name) ?? []), handler]);
    },
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
  };
  createAcpExtension({ modelContextLimit: WINDOW, delegate: { enabled: false } })(api as unknown as ExtensionAPI);
  const notices: string[] = [];
  const ctx = {
    mode: "rpc", hasUI: false,
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "" },
    model: { id: "after-model-switch", contextWindow: WINDOW, maxTokens: 131_072 },
    sessionManager: { buildContextEntries: () => entries, getBranch: () => entries, getSessionId: () => "retry-test", getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: reported, contextWindow: WINDOW, percent: reported / WINDOW * 100 }),
    getSystemPrompt: () => "",
  } as unknown as ExtensionCommandContext;
  return { handlers, allHandlers, tools, commands, ctx, notices };
}

async function contextText(s: ReturnType<typeof setup>, entries: SessionEntry[]): Promise<string> {
  const result = await s.handlers.get("context")!({ type: "context", messages: entries.filter((e): e is SessionMessageEntry => e.type === "message" && e.id !== "failed").map(e => e.message) }, s.ctx);
  return (result?.messages ?? []).map(m => extractText(m.content)).join("\n");
}

async function statusText(s: ReturnType<typeof setup>): Promise<string> {
  const result = await s.tools.find(t => t.name === "acp_status")!.execute("status", {}, undefined, undefined, s.ctx);
  return extractText(result.content);
}

for (const failure of ["error", "aborted", "zero"] as const) {
  test(`context hook rejects 952k retry fallback after ${failure}, preserving the 40k anchor`, async () => {
    const entries = stream(failure);
    const s = setup(entries);
    assert.doesNotMatch(await contextText(s, entries), /Context limit reached/);
  });
  test(`acp_status rejects 952k retry fallback after ${failure}`, async () => {
    const text = await statusText(setup(stream(failure)));
    assert.match(text, /Nudge: idle/);
    assert.match(text, /Last valid usage: 40\.0k/);
    assert.doesNotMatch(text, /Provider-reported: 952\.0k/);
  });
  for (const command of ["acp", "acp-status"]) {
    test(`/${command} rejects 952k retry fallback after ${failure}`, async () => {
      const s = setup(stream(failure));
      await s.commands.get(command)!.handler("", s.ctx);
      const text = s.notices.at(-1) ?? "";
      assert.match(text, /Nudge:\s+idle/);
      assert.doesNotMatch(text, /952\.0K|952\.0k|952,000/);
    });
  }
}

test("fresh provider usage still triggers emergency pressure on every surface", async () => {
  const entries = stream(undefined, INFLATED);
  const s = setup(entries);
  assert.match(await contextText(s, entries), /Context limit reached/);
  assert.match(await statusText(s), /Nudge: ACTIVE/);
  for (const command of ["acp", "acp-status"]) {
    await s.commands.get(command)!.handler("", s.ctx);
    assert.match(s.notices.at(-1) ?? "", /Nudge:\s+ACTIVE/);
  }
});

test("no provider anchor never imports the raw host fallback", async () => {
  const entries = stream(undefined, 0);
  const s = setup(entries);
  assert.doesNotMatch(await contextText(s, entries), /Context limit reached/);
  assert.match(await statusText(s), /Nudge: idle/);
});

test("recovery to a fresh assistant restores the live host count", async () => {
  const entries = [...stream("error"), usedAssistant("recovered", INFLATED)];
  const s = setup(entries);
  assert.match(await contextText(s, entries), /Context limit reached/);
  assert.match(await statusText(s), /Provider-reported: 952\.0k/);
});

test("failed usage containing nonzero tokens is not a valid anchor", () => {
  const entries = [...stream(), message("failed", { role: "assistant", content: [], stopReason: "error", usage: { totalTokens: INFLATED } })];
  const result = compressionAnchorStaleness(entries, [], () => 0);
  assert.equal(result.lastRealTokens, REAL);
  assert.equal(result.fresh, false);
});

const liveQuery = { sessionId: "retry-test", modelId: "after-model-switch" };
async function fire(s: ReturnType<typeof setup>, name: string, event: object = {}): Promise<unknown> {
  let result: unknown;
  for (const callback of s.allHandlers.get(name) ?? []) {
    const handler = callback as unknown as (event: object, ctx: ExtensionContext) => unknown;
    result = (await handler(event, s.ctx)) ?? result;
  }
  return result;
}

for (const lifecycle of ["session_start", "session_shutdown", "session_tree", "model_select", "session_before_switch"]) {
  test(`${lifecycle} invalidates published usage`, async () => {
    const s = setup(stream("error"));
    await contextText(s, stream("error"));
    assert.ok(getLiveContextUsage(liveQuery));
    await fire(s, lifecycle);
    assert.equal(getLiveContextUsage(liveQuery), undefined);
  });
}

test("SDK final transcript includes substantial real schemas and sections", async () => {
  const s = setup(stream("error"));
  const schema = "schema ".repeat(800_000);
  const system = { role: "system", content: "real prompt", sections: { instructions: "instructions" }, toolsAdded: [{ name: "huge", description: schema, parameters: { type: "object" } }] };
  await fire(s, "context_with_system", { messages: [system, { role: "user", content: "go" }] });
  assert.ok(getLiveContextUsage(liveQuery)!.tokens > WINDOW);
  assert.ok(getLiveContextUsage(liveQuery)!.percent > 100);
  clearLiveContextUsage(liveQuery.sessionId);
});

test("failed context transform clears the prior published record", async () => {
  const s = setup(stream("error"));
  await contextText(s, stream("error"));
  Object.assign(s.ctx.sessionManager, { buildContextEntries: () => { throw new Error("projection failed"); } });
  await assert.rejects(contextText(s, stream("error")), /projection failed/);
  assert.equal(getLiveContextUsage(liveQuery), undefined);
});

test("late proxy stand-down clears usage and allows native compaction", async () => {
  const s = setup(stream("error"));
  await contextText(s, stream("error"));
  Object.assign(s.ctx.model!, { baseUrl: "http://127.0.0.1:1234/bili/https://provider.example" });
  assert.equal(await fire(s, "session_before_compact", { reason: "overflow", willRetry: true }), undefined);
  assert.equal(getLiveContextUsage(liveQuery), undefined);
});

for (const reason of ["threshold", "overflow", "manual"]) test(`${reason} compaction never aborts a quota-pending agent`, async () => {
  const s = setup(stream("error"));
  let aborts = 0;
  Object.assign(s.ctx, { abort: () => { aborts++; } });
  assert.deepEqual(await fire(s, "session_before_compact", { reason, willRetry: true }), reason === "overflow" ? undefined : { cancel: true });
  assert.equal(aborts, 0);
});

test("fresh stable calibration cannot hide large new projected growth", async () => {
  const entries = stream();
  const s = setup(entries);
  for (let i = 0; i < 5; i++) await contextText(s, entries);
  entries.push(message("large-growth", { role: "user", content: "new ".repeat(1_300_000) }));
  assert.match(await contextText(s, entries), /Context limit reached/);
  assert.ok(getLiveContextUsage(liveQuery)!.tokens > WINDOW);
});
