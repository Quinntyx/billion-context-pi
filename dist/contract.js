// src/contract.ts
var SIDECAR_SCHEMA_VERSION = 1;
function sidecarProducer() {
  return `billion-context-pi@${true ? "0.1.83" : "dev"}`;
}
var LIVE_CONTEXT_USAGE_SYMBOL = /* @__PURE__ */ Symbol.for("billion-context-pi.live-context-usage.v1");
function usageKey(query) {
  return JSON.stringify([query.sessionId, query.provider ?? "", query.modelId]);
}
function isRegistry(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return candidate.version === 1 && typeof candidate.get === "function" && typeof candidate.publish === "function" && typeof candidate.clear === "function" && typeof candidate.revision === "function";
}
function registry() {
  const current = Reflect.get(globalThis, LIVE_CONTEXT_USAGE_SYMBOL);
  if (isRegistry(current)) return current;
  const records = /* @__PURE__ */ new Map();
  const revisions = /* @__PURE__ */ new Map();
  const created = {
    version: 1,
    get(query) {
      const record = records.get(usageKey(query));
      return record ? { ...record } : void 0;
    },
    publish(usage) {
      for (const [key, record] of records) if (record.sessionId === usage.sessionId) records.delete(key);
      records.set(usageKey(usage), { ...usage });
    },
    clear(sessionId) {
      for (const [key, record] of records) if (record.sessionId === sessionId) records.delete(key);
      revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
    },
    revision(sessionId) {
      return revisions.get(sessionId) ?? 0;
    }
  };
  Reflect.set(globalThis, LIVE_CONTEXT_USAGE_SYMBOL, created);
  return created;
}
function getLiveContextUsage(query) {
  return registry().get(query);
}
function publishLiveContextUsage(usage, revision) {
  if (revision !== void 0 && revision !== liveContextUsageRevision(usage.sessionId)) return;
  if (!Number.isFinite(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    clearLiveContextUsage(usage.sessionId);
    return;
  }
  registry().publish({ ...usage, percent: usage.tokens / usage.contextWindow * 100 });
}
function liveContextUsageRevision(sessionId) {
  return registry().revision(sessionId);
}
function clearLiveContextUsage(sessionId) {
  registry().clear(sessionId);
}
export {
  LIVE_CONTEXT_USAGE_SYMBOL,
  SIDECAR_SCHEMA_VERSION,
  clearLiveContextUsage,
  getLiveContextUsage,
  liveContextUsageRevision,
  publishLiveContextUsage,
  sidecarProducer
};
//# sourceMappingURL=contract.js.map