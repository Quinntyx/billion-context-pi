import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debug } from "./log.js";

/** The ACP surface. Deactivated when the active model sets
 *  `compress.enabled: false`, restored on model switch. Mirrors the top-level
 *  `enabled: false` master switch, which registers none of these at all. */
const ACP_CORE_TOOL_NAMES = [
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "acp_cache",
  "acp_rule",
  "acp_delegate",
  "acp_delegate_wait",
  "acp_delegate_cancel",
] as const;

/** Tools that are useless before the first compression exists: decompress has
 *  no block to restore and search_context has no summaries to search. They
 *  stay registered (Pi cannot unregister) but inactive until a block exists. */
export const DEFERRED_TOOL_NAMES = ["decompress", "search_context"] as const;

export interface ToolActivationController {
  /** Forget per-session bookkeeping (new session / session switch). */
  reset(sessionId: string): void;
  /** Mark deferred tools available once the session actually has blocks. */
  noteBlocks(sessionId: string, count: number): void;
  /** Whether decompress/search_context should be visible to the model. */
  deferredVisible(sessionId: string): boolean;
  /** Apply the model gate + deferred gate to Pi's active tool set. */
  sync(sessionId: string, acpEnabled: boolean): void;
}

export function createToolActivation(pi: ExtensionAPI): ToolActivationController {
  const supportsActiveSet = typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function";
  const removedByGate = new Map<string, Set<string>>();
  const deferredUnlocked = new Set<string>();

  function commit(sessionId: string, next: string[]): void {
    const current = pi.getActiveTools();
    if (current.length === next.length && current.every((name, i) => name === next[i])) return;
    debug.event("tool-activation", { sid: sessionId, from: current.join(","), to: next.join(",") });
    pi.setActiveTools(next);
  }

  function sync(sessionId: string, acpEnabled: boolean): void {
    if (!supportsActiveSet) return;
    const next = [...pi.getActiveTools()];
    const present = new Set(next);

    if (!acpEnabled) {
      const removed = removedByGate.get(sessionId) ?? new Set<string>();
      for (const name of ACP_CORE_TOOL_NAMES) {
        const index = next.indexOf(name);
        if (index < 0) continue;
        next.splice(index, 1);
        present.delete(name);
        removed.add(name);
      }
      removedByGate.set(sessionId, removed);
      commit(sessionId, next);
      return;
    }

    const removed = removedByGate.get(sessionId);
    if (removed) {
      for (const name of removed) {
        if (present.has(name)) continue;
        next.push(name);
        present.add(name);
      }
      removedByGate.delete(sessionId);
    }

    if (deferredUnlocked.has(sessionId)) {
      for (const name of DEFERRED_TOOL_NAMES) {
        if (present.has(name)) continue;
        next.push(name);
        present.add(name);
      }
    } else {
      for (const name of DEFERRED_TOOL_NAMES) {
        const index = next.indexOf(name);
        if (index < 0) continue;
        next.splice(index, 1);
        present.delete(name);
      }
    }
    commit(sessionId, next);
  }

  return {
    reset(sessionId: string): void {
      removedByGate.delete(sessionId);
      deferredUnlocked.delete(sessionId);
    },
    noteBlocks(sessionId: string, count: number): void {
      if (count > 0) deferredUnlocked.add(sessionId);
    },
    deferredVisible(sessionId: string): boolean {
      return deferredUnlocked.has(sessionId);
    },
    sync,
  };
}
