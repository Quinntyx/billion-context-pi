/**
 * Machine-readable contract for the `<sessionFile>.acp.json` sidecar (#368).
 *
 * Downstream tools (e.g. pi-billion-memory) glob the sidecar directly instead
 * of running inside pi. To keep that stable across releases:
 *
 *  - `schemaVersion` is written on every save. A MISSING version means v1
 *    (pre-contract files). An unknown NEWER version means "fields may have
 *    changed" — skip it, log once, never rewrite the file.
 *  - `producer` identifies the writer (`billion-context-pi@x.y.z`).
 *  - The file is replaced atomically (tmp + rename), so a reader either sees
 *    the previous or the next complete file, never a torn write.
 *  - Blocks are stored verbatim as the kernel's CompressionBlock; unknown
 *    extra fields are additive and must be ignored by readers.
 */
export const SIDECAR_SCHEMA_VERSION = 1;

/**
 * One compressed block, as persisted in the sidecar's `blocks[]`. Mirrors the
 * kernel's CompressionBlock (acp-kernel 0.0.81) — inlined rather than aliased
 * so this subpath carries no type dependency on acp-kernel (dev-only, bundled
 * at build time). Fields the kernel adds later are additive; tests assert the
 * kernel shape still covers this one.
 */
export interface BcpBlockV1 {
  blockId: string;
  runId: string;
  tier: 1 | 2 | 3;
  topic?: string;
  summary: string;
  directMessageIds: string[];
  effectiveMessageIds: string[];
  directBlockIds: string[];
  compressedTokens: number;
  createdAt: number;
  survivedCount: number;
  generation: "young" | "old";
  active: boolean;
  expanded?: boolean;
  durationMs?: number;
  compressCallId?: string;
  startRef?: string;
  endRef?: string;
}

/** Top-level shape of the sidecar (state fields beyond the contract allowed). */
export interface BcpSidecarV1 {
  schemaVersion: number;
  producer: string;
  blocks: BcpBlockV1[];
  [extra: string]: unknown;
}

export function sidecarProducer(): string {
  return `billion-context-pi@${typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : "dev"}`;
}

export const LIVE_CONTEXT_USAGE_SYMBOL = Symbol.for("billion-context-pi.live-context-usage.v1");

export interface LiveContextUsageQuery {
  sessionId: string;
  modelId: string;
  provider?: string;
}

export interface LiveContextUsage extends LiveContextUsageQuery {
  tokens: number;
  contextWindow: number;
  percent: number;
  source: "sent-view-estimate";
  updatedAt: number;
}

export interface LiveContextUsageRegistry {
  version: 1;
  get(query: LiveContextUsageQuery): LiveContextUsage | undefined;
}

interface MutableLiveContextUsageRegistry extends LiveContextUsageRegistry {
  publish(usage: LiveContextUsage): void;
  clear(sessionId: string): void;
  revision(sessionId: string): number;
}

function usageKey(query: LiveContextUsageQuery): string {
  return JSON.stringify([query.sessionId, query.provider ?? "", query.modelId]);
}

function isRegistry(value: unknown): value is MutableLiveContextUsageRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MutableLiveContextUsageRegistry>;
  return candidate.version === 1 && typeof candidate.get === "function" && typeof candidate.publish === "function" && typeof candidate.clear === "function" && typeof candidate.revision === "function";
}

function registry(): MutableLiveContextUsageRegistry {
  const current = Reflect.get(globalThis, LIVE_CONTEXT_USAGE_SYMBOL);
  if (isRegistry(current)) return current;
  const records = new Map<string, LiveContextUsage>();
  const revisions = new Map<string, number>();
  const created: MutableLiveContextUsageRegistry = {
    version: 1,
    get(query) {
      const record = records.get(usageKey(query));
      return record ? { ...record } : undefined;
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
    },
  };
  Reflect.set(globalThis, LIVE_CONTEXT_USAGE_SYMBOL, created);
  return created;
}

export function getLiveContextUsage(query: LiveContextUsageQuery): LiveContextUsage | undefined {
  return registry().get(query);
}

export function publishLiveContextUsage(usage: LiveContextUsage, revision?: number): void {
  if (revision !== undefined && revision !== liveContextUsageRevision(usage.sessionId)) return;
  if (!Number.isFinite(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    clearLiveContextUsage(usage.sessionId);
    return;
  }
  registry().publish({ ...usage, percent: usage.tokens / usage.contextWindow * 100 });
}

export function liveContextUsageRevision(sessionId: string): number {
  return registry().revision(sessionId);
}

export function clearLiveContextUsage(sessionId: string): void {
  registry().clear(sessionId);
}

declare const CURRENT_VERSION: string;
