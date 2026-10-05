import type { SimEvent } from "./events.ts";
import { sortEvents } from "./events.ts";

/**
 * Reference event model: an independent, deliberately plain fold over the
 * sorted event log. It shares only the event type definitions with the
 * engine — none of the engine's code — so reconciliation is meaningful.
 */

export interface ModelDecision {
  tick: number;
  seq: number;
  kind: SimEvent["kind"];
  decision: "accepted" | "rejected";
  rule: string;
}

export interface ModelTransfer {
  status: "active" | "paused" | "completed";
  committed: number[];
}

export interface ModelResult {
  decisions: ModelDecision[];
  transfers: Record<string, ModelTransfer>;
  published: Record<string, string[]>;
}

interface ModelTransferState {
  principal: string;
  objectId: string;
  totalChunks: number;
  status: "active" | "paused" | "completed";
  committed: Set<number>;
  batches: Map<string, { chunks: number[]; boundVersion: number; committed: boolean }>;
}

export function runModel(events: readonly SimEvent[]): ModelResult {
  const ordered = sortEvents(events);
  const grants = new Map<string, boolean>();
  let version = 0;
  const transfers = new Map<string, ModelTransferState>();
  const published = new Map<string, string[]>();
  const decisions: ModelDecision[] = [];

  const key = (p: string, o: string) => `${p}${o}`;
  const granted = (p: string, o: string) => grants.get(key(p, o)) === true;

  const decide = (
    e: SimEvent,
    decision: "accepted" | "rejected",
    rule: string,
  ): void => {
    decisions.push({ tick: e.tick, seq: e.seq, kind: e.kind, decision, rule });
  };

  for (const e of ordered) {
    switch (e.kind) {
      case "grant":
        grants.set(key(e.principal, e.objectId), true);
        version += 1;
        decide(e, "accepted", "GRANT_APPLIED");
        break;
      case "revoke":
        grants.set(key(e.principal, e.objectId), false);
        version += 1;
        decide(e, "accepted", "REVOKE_APPLIED");
        break;
      case "begin": {
        if (!granted(e.principal, e.objectId)) {
          decide(e, "rejected", "BEGIN_NO_PERMISSION");
        } else if (transfers.has(e.transferId)) {
          decide(e, "rejected", "DUPLICATE_TRANSFER");
        } else {
          transfers.set(e.transferId, {
            principal: e.principal,
            objectId: e.objectId,
            totalChunks: e.totalChunks,
            status: "active",
            committed: new Set(),
            batches: new Map(),
          });
          decide(e, "accepted", "TRANSFER_BEGUN");
        }
        break;
      }
      case "submitBatch": {
        const t = transfers.get(e.transferId);
        if (!t) decide(e, "rejected", "UNKNOWN_TRANSFER");
        else if (t.status !== "active") decide(e, "rejected", "TRANSFER_NOT_ACTIVE");
        else if (t.batches.has(e.batchId)) decide(e, "rejected", "DUPLICATE_BATCH");
        else {
          t.batches.set(e.batchId, {
            chunks: [...e.chunks],
            boundVersion: version,
            committed: false,
          });
          decide(e, "accepted", "BATCH_CACHED");
        }
        break;
      }
      case "pause": {
        const t = transfers.get(e.transferId);
        if (!t) decide(e, "rejected", "UNKNOWN_TRANSFER");
        else if (t.status !== "active") decide(e, "rejected", "TRANSFER_NOT_ACTIVE");
        else {
          t.status = "paused";
          decide(e, "accepted", "TRANSFER_PAUSED");
        }
        break;
      }
      case "resume": {
        const t = transfers.get(e.transferId);
        if (!t) decide(e, "rejected", "UNKNOWN_TRANSFER");
        else if (t.status !== "paused") decide(e, "rejected", "TRANSFER_NOT_PAUSED");
        else if (!granted(t.principal, t.objectId)) {
          decide(e, "rejected", "RESUME_PERMISSION_REVOKED");
        } else {
          t.status = "active";
          decide(e, "accepted", "RESUME_RECHECKED");
        }
        break;
      }
      case "commitBatch": {
        const t = transfers.get(e.transferId);
        if (!t) {
          decide(e, "rejected", "UNKNOWN_TRANSFER");
          break;
        }
        const b = t.batches.get(e.batchId);
        if (!b) decide(e, "rejected", "UNKNOWN_BATCH");
        else if (b.committed) decide(e, "rejected", "BATCH_ALREADY_COMMITTED");
        else if (t.status !== "active") decide(e, "rejected", "TRANSFER_NOT_ACTIVE");
        else if (!granted(t.principal, t.objectId)) decide(e, "rejected", "PERMISSION_REVOKED");
        else if (b.boundVersion !== version) decide(e, "rejected", "STALE_VERSION");
        else {
          for (const c of b.chunks) {
            if (c >= 0 && c < t.totalChunks) t.committed.add(c);
          }
          b.committed = true;
          if (t.committed.size === t.totalChunks) t.status = "completed";
          decide(e, "accepted", "BATCH_COMMITTED");
        }
        break;
      }
      case "publish": {
        if (!granted(e.principal, e.objectId)) {
          decide(e, "rejected", "PUBLISH_NO_PERMISSION");
        } else {
          const h = published.get(e.objectId) ?? [];
          h.push(e.payload);
          published.set(e.objectId, h);
          decide(e, "accepted", "PUBLISHED");
        }
        break;
      }
    }
  }

  const transferOut: Record<string, ModelTransfer> = {};
  for (const [id, t] of transfers) {
    transferOut[id] = {
      status: t.status,
      committed: [...t.committed].sort((a, b) => a - b),
    };
  }
  const publishedOut: Record<string, string[]> = {};
  for (const [id, h] of published) publishedOut[id] = [...h];

  return { decisions, transfers: transferOut, published: publishedOut };
}
