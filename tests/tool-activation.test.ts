import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolActivation } from "../src/tool-activation.js";
import { createAcpExtension } from "../src/index.js";

function fakeActiveApi(initial: string[]) {
  let active = [...initial];
  return {
    api: {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active = [...names];
      },
    },
    get active() {
      return [...active];
    },
  };
}

test("tool activation: deferred tools stay hidden until a block exists", () => {
  const h = fakeActiveApi(["read", "compress", "decompress", "search_context", "acp_status", "acp_cache"]);
  const controller = createToolActivation(h.api as any);

  controller.sync("s", true);
  assert.deepEqual(h.active, ["read", "compress", "acp_status", "acp_cache"]);
  assert.equal(controller.deferredVisible("s"), false);

  controller.noteBlocks("s", 1);
  controller.sync("s", true);
  assert.deepEqual(h.active, ["read", "compress", "acp_status", "acp_cache", "decompress", "search_context"]);
  assert.equal(controller.deferredVisible("s"), true);
});

test("tool activation: model gate removes the ACP surface and restores it on switch", () => {
  const h = fakeActiveApi(["read", "compress", "decompress", "search_context", "acp_status"]);
  const controller = createToolActivation(h.api as any);

  controller.sync("s", false);
  assert.deepEqual(h.active, ["read"], "all ACP tools removed");

  controller.sync("s", true);
  assert.deepEqual(h.active, ["read", "compress", "acp_status"], "remembered tools restored; deferred still hidden");

  controller.noteBlocks("s", 1);
  controller.sync("s", true);
  assert.deepEqual(h.active, ["read", "compress", "acp_status", "decompress", "search_context"]);
});

test("tool activation: reset forgets the unlocked deferred state", () => {
  const h = fakeActiveApi(["read", "compress"]);
  const controller = createToolActivation(h.api as any);
  controller.noteBlocks("s", 2);
  controller.sync("s", true);
  assert.ok(h.active.includes("decompress"));

  controller.reset("s");
  controller.sync("s", true);
  assert.ok(!h.active.includes("decompress"));
  assert.ok(!h.active.includes("search_context"));
});

test("tool activation: hosts without getActiveTools/setActiveTools are a no-op", () => {
  const controller = createToolActivation({} as any);
  assert.doesNotThrow(() => controller.sync("s", false));
});

function fakeExtensionApi(initialActive: string[]) {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  let active = [...initialActive];
  const tools: any[] = [];
  const api = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: any) {
      tools.push(tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    registerCommand() {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    getAllTools: () => tools,
  };
  return { api, handlers, tools, get active() { return [...active]; } };
}

function fakeCtx(model: { provider: string; id: string }) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: process.cwd(),
    ui: { notify() {} },
    model: { ...model, contextWindow: 200_000, maxTokens: 8_000 },
    sessionManager: {
      getSessionId: () => "activation-test",
      getSessionFile: () => undefined,
      getBranch: () => [],
      buildContextEntries: () => [],
    },
  };
}

function withExtension(prefix: string, initialActive: string[], fn: (h: ReturnType<typeof fakeExtensionApi>) => void): void {
  const h = fakeExtensionApi(initialActive);
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = `/tmp/bcp-activation-empty-${prefix}`;
  try {
    createAcpExtension({
      autoUpdate: false,
      compress: {
        providers: {
          openrouter: {
            models: { "deepseek/x": { enabled: false } },
          },
        },
      },
    })(h.api as any);
    fn(h);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

test("extension: per-model compress.enabled=false hides the ACP surface and prompt", () => {
  withExtension("disabled", ["read"], (h) => {
    const ctx = fakeCtx({ provider: "openrouter", id: "deepseek/x" });
    h.handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, ctx);
    assert.ok(!h.active.includes("compress"), "compress deactivated");
    assert.ok(!h.active.includes("acp_status"), "acp_status deactivated");
    assert.ok(!h.active.includes("decompress"), "decompress deactivated");

    const compact = h.handlers.get("session_before_compact")![0]!({ reason: "threshold" }, ctx);
    assert.equal(compact, undefined, "native compaction left alone for a disabled model");
  });
});

test("extension: switching to an enabled model restores the surface, deferred after compress", () => {
  withExtension("enabled", ["read"], (h) => {
    const disabled = fakeCtx({ provider: "openrouter", id: "deepseek/x" });
    h.handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, disabled);
    assert.ok(!h.active.includes("compress"));

    const enabled = fakeCtx({ provider: "openrouter", id: "other" });
    h.handlers.get("model_select")![0]!({}, enabled);
    assert.ok(h.active.includes("compress"), "compress restored");
    assert.ok(h.active.includes("acp_status"), "acp_status restored");
    assert.ok(!h.active.includes("decompress"), "decompress still deferred");
    assert.ok(!h.active.includes("search_context"), "search_context still deferred");

    const prompt = h.handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, enabled);
    assert.ok(prompt.systemPrompt.includes("compress"));
    assert.ok(!prompt.systemPrompt.includes("- decompress —"), "prompt hides deferred tools");

    const resultEvent = { isError: false, toolName: "compress", toolCallId: "call-1", input: {}, content: [{ type: "text", text: "▣ ACP | 10K → 5K tokens (~5K reclaimed, blocks: b1=m00001–m00010)" }] };
    for (const handler of h.handlers.get("tool_result")!) handler(resultEvent, enabled);
    assert.ok(h.active.includes("decompress"), "decompress activated after first compress");
    assert.ok(h.active.includes("search_context"), "search_context activated after first compress");

    const after = h.handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, enabled);
    assert.ok(after.systemPrompt.includes("- decompress —"), "prompt exposes deferred tools after first compress");
  });
});
