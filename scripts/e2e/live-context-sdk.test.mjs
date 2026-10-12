import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInitialState, defaultCountTokens } from "acp-kernel";
import { createAcpExtension } from "../../dist/index.js";
import { getLiveContextUsage } from "../../dist/contract.js";

const sdkPath = process.env.BCP_TEST_SDK ?? "/home/zlare/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const sdk = await import(pathToFileURL(sdkPath).href);
const sdkRoot = resolve(dirname(sdkPath), "..");
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdkRoot, "../pi-ai/dist/utils/event-stream.js")).href);
process.env.ACP_AUTO_UPDATE = "false";

const WINDOW = 272_000;
const model = { id: "fixture-model", name: "SDK context regression", api: "openai-completions", provider: "openai", baseUrl: "https://invalid.example/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: WINDOW, maxTokens: 32_000 };
const usage = (input = 0, cacheRead = 0) => ({ input, output: 0, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (text, stopReason = "stop", tokens = 0) => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason, usage: usage(tokens), timestamp: Date.now() });

function cacheBytes(messages) {
  return JSON.stringify(messages, (key, value) => key === "timestamp" || key === "durationMs" || key === "usage" ? undefined : value);
}
function commonPrefix(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
}

test("real SDK 1.1.0: raw durable history over window, folded outbound under window, bounded cancellation and stable cache prefix", { timeout: 60_000 }, async () => {
  assert.equal(JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")).version, "1.1.0");
  const dir = await mkdtemp(join(tmpdir(), "bcp-sdk-context-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }, retry: { enabled: false }, cacheWarming: "off" });
  const manager = sdk.SessionManager.create(dir, join(dir, "sessions"));
  const ids = [];
  for (let i = 0; i < 48; i++) ids.push(manager.appendMessage(i % 2 ? assistant(`history-${i} ` + "payload ".repeat(10_000)) : { role: "user", content: [{ type: "text", text: `history-${i} ` + "payload ".repeat(10_000) }], timestamp: Date.now() }));
  const covered = ids.slice(0, 44);
  const summary = "Durable history was folded; preserve the current task.";
  // Real ACP retains the summary in its compression turn, not a duplicate
  // synthetic message. A sidecar alone is not a faithful durable fixture.
  manager.appendMessage({ ...assistant("", "toolUse"), content: [{ type: "toolCall", id: "fold-history", name: "compress", arguments: { content: [{ startId: covered[0], endId: covered.at(-1), summary }] } }] });
  manager.appendMessage({ role: "toolResult", toolCallId: "fold-history", toolName: "compress", content: [{ type: "text", text: "Durable history compressed into b0." }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant("last real provider response", "stop", 40_000));
  const failed = manager.appendMessage({ ...assistant("", "error"), errorMessage: "reservation rejected after stream abort" });
  manager.appendContextEdit(failed, null);
  const state = createInitialState();
  state.blocks.push({ blockId: "b0", runId: "r0", tier: 1, summary, directMessageIds: covered, effectiveMessageIds: covered, directBlockIds: [], compressedTokens: covered.reduce((sum, id) => sum + defaultCountTokens(manager.getEntry(id).message.content[0].text), 0), createdAt: Date.now(), survivedCount: 0, generation: "old", active: true });
  await writeFile(manager.getSessionFile() + ".acp.json", JSON.stringify({ ...state, schemaVersion: 1, producer: "sdk-regression" }));

  let extensionContext;
  let cancels = 0;
  let requests = 0;
  const outbound = [];
  const events = [];
  const checkpoints = [];
  const observer = pi => {
    pi.on("session_start", (_event, ctx) => { extensionContext = ctx; });
    pi.on("context_with_system", (event, ctx) => {
      outbound.push(structuredClone(event.messages));
      checkpoints.push(getLiveContextUsage({ sessionId: manager.getSessionId(), provider: ctx.model.provider, modelId: ctx.model.id }));
    });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [createAcpExtension({ delegate: { enabled: false } }), observer], systemPrompt: "A stable test system prompt." });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey(model.provider, "offline-fixture-key");
  const largeSchema = { name: "schema-heavy-tool", label: "Schema fixture", description: "Tool instructions ".repeat(2000), parameters: { type: "object", properties: { payload: { type: "string", description: "schema ".repeat(8000) } } }, execute: async () => ({ content: [{ type: "text", text: "unused" }], details: null }) };
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir, model, modelRuntime, settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "builtin", customTools: [largeSchema] });
  await session.bindExtensions({ abortHandler: () => session.abort(), onError: error => assert.fail(error.message) });
  session.subscribe(event => {
    if (event.type.startsWith("compaction_")) events.push(event);
    if (event.type === "compaction_start" && event.reason !== "manual") cancels++;
  });
  const query = { sessionId: manager.getSessionId(), provider: model.provider, modelId: model.id };
  const rawBefore = session.getContextUsage().tokens;
  assert.ok(rawBefore > WINDOW, `raw durable size ${rawBefore}`);
  session.agent.streamFunction = (_model, context) => {
    requests++;
    assert.ok(requests <= 3, "cancelled automatic compaction retried indefinitely");
    const stream = new AssistantMessageEventStream();
    const result = requests === 1 ? { ...assistant("", "error"), errorMessage: "reservation rejected: insufficient balance" } : assistant("completed", "stop", 40_000);
    if (requests > 1) {
      const previous = cacheBytes(outbound.at(-2));
      const current = cacheBytes(outbound.at(-1));
      const hitRate = commonPrefix(previous, current) / previous.length;
      result.usage = usage(Math.ceil(40_000 * (1 - hitRate)), Math.floor(40_000 * hitRate));
    }
    stream.push({ type: result.stopReason === "error" ? "error" : "done", reason: result.stopReason, ...(result.stopReason === "error" ? { error: result } : { message: result }) });
    stream.end(result);
    return stream;
  };
  try {
    await session.prompt("Continue the existing task.");
    assert.equal(requests, 1);
    assert.ok(cancels >= 1 && cancels <= 2, `automatic cancellations ${cancels}`);
    assert.ok(session.isIdle);
    const live = getLiveContextUsage(query);
    assert.ok(live && live.tokens < WINDOW, `folded estimate ${live?.tokens}`);
    assert.ok(live.tokens > 40_000, "tool schemas and outbound tail must not be omitted");
    assert.ok(session.getContextUsage().tokens > WINDOW, "raw history must remain durable/unclamped");
    assert.ok(outbound[0].some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === largeSchema.name)));
    assert.ok(!JSON.stringify(outbound[0]).includes("history-1 " + "payload ".repeat(100)));
    assert.ok(JSON.stringify(outbound[0]).includes("Durable history was folded"));
    await session.prompt("Continue the existing task again.");
    assert.equal(requests, 2);
    const cacheRate = session.agent.state.messages.filter(message => message.role === "assistant").at(-1).usage.cacheRead / 40_000;
    assert.ok(cacheRate > 0.95, `deterministic provider cache hit rate ${cacheRate}`);
    assert.ok(events.every(event => event.type !== "compaction_end" || event.willRetry === false));
    await extensionContext.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(getLiveContextUsage(query), undefined);
    const checkpoint = { sdk: "1.1.0", rawBefore, rawAfter: session.getContextUsage().tokens, window: WINDOW, sentTokens: checkpoints.map(record => record?.tokens), requests, automaticCancellations: cancels, cacheRate, compactionEnds: events.filter(event => event.type === "compaction_end").map(event => ({ aborted: event.aborted, willRetry: event.willRetry })) };
    await writeFile(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2));
    console.log("SDK_CHECKPOINT", join(dir, "checkpoint.json"), JSON.stringify(checkpoint));
  } finally {
    session.dispose();
  }
});

const replayPath = process.env.BCP_REPLAY_SESSION;
test("real SDK 1.1.0: isolated durable live-session replay after abort", { skip: !replayPath, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bcp-sdk-replay-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const source = await readFile(replayPath, "utf8");
  const split = source.indexOf("\n");
  const header = JSON.parse(source.slice(0, split));
  const sessionId = randomUUID();
  const sessionFile = join(dir, "isolated.jsonl");
  const { parentSession: _parent, ...isolatedHeader } = header;
  await writeFile(sessionFile, JSON.stringify({ ...isolatedHeader, id: sessionId, cwd: dir }) + source.slice(split), { mode: 0o600 });
  const sidecar = await readFile(replayPath + ".acp.json", "utf8");
  await writeFile(sessionFile + ".acp.json", sidecar, { mode: 0o600 });
  const manager = sdk.SessionManager.open(sessionFile, dir, dir);
  assert.notEqual(manager.getSessionId(), header.id);
  const messageEntries = manager.getBranch().filter(entry => entry.type === "message");
  const messages = messageEntries.map(entry => entry.message);
  const durableTokens = defaultCountTokens(JSON.stringify(messages));
  assert.ok(durableTokens > WINDOW, `durable history ${durableTokens}`);
  const lastAssistant = messages.filter(message => message.role === "assistant").at(-1);
  const lastGood = messages.filter(message => message.role === "assistant" && !["aborted", "error"].includes(message.stopReason) && message.usage?.totalTokens > 0).at(-1);
  assert.equal(lastAssistant.stopReason, "aborted");
  // Run the captured history offline, not through its original OAuth provider.
  // The unique fixture model avoids registry replacement or real credential use.
  const replayModel = { ...model, id: "offline-durable-replay" };
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }, retry: { enabled: false }, cacheWarming: "off" });
  const outboundSizes = [];
  const checkpoints = [];
  let extensionContext;
  const observer = pi => {
    pi.on("session_start", (_event, ctx) => { extensionContext = ctx; });
    pi.on("context_with_system", (event, ctx) => {
      outboundSizes.push(event.messages.length);
      checkpoints.push(getLiveContextUsage({ sessionId, provider: ctx.model.provider, modelId: ctx.model.id }));
    });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [createAcpExtension({ delegate: { enabled: false } }), observer], systemPrompt: "Isolated replay of existing durable context." });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey(replayModel.provider, "offline-fixture-key");
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir, model: replayModel, modelRuntime, settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "builtin" });
  await session.bindExtensions({ abortHandler: () => session.abort(), onError: error => assert.fail(error.message) });
  // A newer host may retain the successful provider's meter after abort. Do
  // not insist that it reproduce an older host's broken raw-history meter.
  const rawBefore = session.getContextUsage().tokens;
  const events = [];
  let requests = 0;
  session.subscribe(event => { if (event.type.startsWith("compaction_")) events.push({ type: event.type, reason: event.reason, aborted: event.aborted, willRetry: event.willRetry }); });
  session.agent.streamFunction = () => {
    assert.ok(++requests <= 1, "aborted history started repeated provider requests");
    const result = { ...assistant("", "aborted"), provider: replayModel.provider, model: replayModel.id };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "error", reason: "aborted", error: result });
    stream.end(result);
    return stream;
  };
  const query = { sessionId, provider: replayModel.provider, modelId: replayModel.id };
  try {
    await session.prompt("Continue the existing task in this isolated replay.");
    assert.equal(requests, 1);
    assert.ok(session.isIdle);
    const live = getLiveContextUsage(query);
    assert.ok(live && live.tokens < WINDOW, `live replay sent view ${live?.tokens}`);
    for (const entry of messageEntries) assert.deepEqual(manager.getEntry(entry.id).message, entry.message, "durable original message was modified");
    assert.ok(events.filter(event => event.type === "compaction_start").length <= 2);
    assert.ok(events.every(event => event.type !== "compaction_end" || event.willRetry === false));
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(getLiveContextUsage(query), undefined);
    await extensionContext.abort();
    const checkpoint = { sdk: "1.1.0", isolatedSessionId: sessionId, sourceBytes: Buffer.byteLength(source), durableTokens, durableEntries: manager.getEntries().length, durableMessages: messages.length, activeBlocks: JSON.parse(sidecar).blocks.filter(block => block.active).length, window: WINDOW, rawBefore, rawAfter: session.getContextUsage().tokens, sentTokens: checkpoints.map(record => record?.tokens), outboundMessages: outboundSizes, requests, compactions: events };
    await writeFile(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
    console.log("REPLAY_CHECKPOINT", join(dir, "checkpoint.json"), JSON.stringify(checkpoint));
    assert.equal(await readFile(replayPath, "utf8"), source, "original durable session was modified");
    assert.equal(await readFile(replayPath + ".acp.json", "utf8"), sidecar, "original compression state was modified");
  } finally {
    session.dispose();
  }
});
