import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { readContextEntries, isPiHost } from "../src/runtime.js";
import { entriesToCoreMessages, EntryProjectionCache } from "../src/messages.js";

type Message = SessionMessageEntry["message"];
const timestamp = "2026-10-12T00:00:00.000Z";
function entry(id: string, message: Message): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp, message };
}
function manager(rows: { sourceEntry: SessionEntry; messages: Message[] }[], durable: SessionEntry[] = rows.map(row => row.sourceEntry)) {
  return {
    getBranch: () => durable,
    buildContextEntries: () => durable,
    buildSessionProjection: () => ({ entries: rows }),
  } as unknown as ExtensionContext["sessionManager"];
}

test("native canonical projection keeps recovery summaries and checkpoint identities", () => {
  const compact: SessionEntry = { type: "compaction", id: "compact", parentId: null, timestamp, firstKeptEntryId: "kept", summary: "COMPACTED_SAFE_CONTEXT", tokensBefore: 3_000_000 };
  const checkpoint: Message = { role: "system", content: "CHECKPOINT", timestamp: 1 };
  const summary: Message = { role: "compactionSummary", summary: compact.summary, tokensBefore: compact.tokensBefore, timestamp: 1 };
  const kept = entry("kept", { role: "user", content: "KEPT_CONTENT", timestamp: 1 });
  const sm = manager([{ sourceEntry: compact, messages: [checkpoint, summary] }, { sourceEntry: kept, messages: [kept.message] }]);
  assert.equal(isPiHost(sm), true);
  const projected = readContextEntries(sm);
  assert.deepEqual(projected.map(row => row.id), ["compact#system", "compact", "kept"]);
  assert.ok(entriesToCoreMessages(projected).some(message => message.text === "COMPACTED_SAFE_CONTEXT"));
  assert.deepEqual(readContextEntries(sm).map(row => row.id), projected.map(row => row.id));
});

test("native context edits cannot resurrect removed or replaced raw payloads", () => {
  const removed = entry("removed", { role: "assistant", content: [{ type: "text", text: "REMOVED_OVERSIZED_CONTENT" }], timestamp: 1 } as Message);
  const old = entry("edited", { role: "user", content: "RAW_OVERSIZED_CONTENT", timestamp: 1 });
  const replacement: Message = { role: "user", content: "SMALL_REPLACEMENT", timestamp: 1 };
  const sm = manager([{ sourceEntry: removed, messages: [] }, { sourceEntry: old, messages: [replacement] }]);
  const projected = readContextEntries(sm);
  assert.deepEqual(projected.map(row => row.id), ["edited"]);
  assert.deepEqual(entriesToCoreMessages(projected).map(message => message.text), ["SMALL_REPLACEMENT"]);
});

test("canonical native recovery preserves incremental/full projection equivalence", () => {
  const source: SessionEntry = { type: "branch_summary", id: "branch", parentId: null, timestamp, fromId: "parent", summary: "BRANCH_SAFE_CONTEXT" };
  const rows = [{ sourceEntry: source, messages: [{ role: "branchSummary", summary: source.summary, fromId: source.fromId, timestamp: 1 } as Message] }];
  const sm = manager(rows);
  const cache = new EntryProjectionCache();
  assert.deepEqual(cache.project(readContextEntries(sm)), entriesToCoreMessages(readContextEntries(sm)));
  const next = entry("next", { role: "user", content: "FOLLOWUP", timestamp: 1 });
  rows.push({ sourceEntry: next, messages: [next.message] });
  assert.deepEqual(cache.project(readContextEntries(sm)), entriesToCoreMessages(readContextEntries(sm)));
});

test("appended native edits invalidate cached earlier bodies without changing refs", () => {
  const original = entry("edited-cache", { role:"user", content:"OLD_BODY", timestamp:1 });
  const rows: {sourceEntry:SessionEntry;messages:Message[]}[] = [{sourceEntry:original,messages:[original.message]}];
  const sm = manager(rows);
  const cache = new EntryProjectionCache();
  assert.ok(cache.project(readContextEntries(sm)).some(message=>message.text==="OLD_BODY"));
  rows[0]!.messages=[{role:"user",content:"NEW_BODY",timestamp:1}];
  rows.push({sourceEntry:{type:"context_edit",id:"edit",parentId:"edited-cache",timestamp,targetId:"edited-cache",replacement:{content:"NEW_BODY"}},messages:[]});
  const next=readContextEntries(sm);
  assert.deepEqual(cache.project(next),entriesToCoreMessages(next));
  assert.equal(cache.project(next)[0]!.id,"edited-cache");
  assert.equal(cache.project(next)[0]!.text,"NEW_BODY");
});
