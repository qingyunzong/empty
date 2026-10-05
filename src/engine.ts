import type { SimEvent } from "./events.ts";
import { compareEvents, sortEvents } from "./events.ts";
import type { Evidence } from "./evidence.ts";

/**
 * Permission ledger. Every grant/revoke event bumps the ledger version,
 * so a batch bound to version N becomes stale the moment any permission
 * event lands afterwards — including a revoke followed by a re-grant.
 */
export class PermissionLedger {
  private readonly granted = new Map<string, boolean>();
  version = 0;

  private static key(principal: string, objectId: string): string {
    return `${principal}${objectId}`;
  }

  grant(principal: string, objectId: string): void {
    this.granted.set(PermissionLedger.key(principal, objectId), true);
    this.version += 1;
  }

  revoke(principal: string, objectId: string): void {
    this.granted.set(PermissionLedger.key(principal, objectId), false);
    this.version += 1;
  }

  isGranted(principal: string, objectId: string): boolean {
    return this.granted.get(PermissionLedger.key(principal, objectId)) === true;
  }
}

export type TransferStatus = "active" | "paused" | "completed";

export interface BatchState {
  batchId: string;
  chunks: number[];
  /** Permission version captured when the batch was cached. */
  boundVersion: number;
  status: "cached" | "committed";
}

export interface TransferState {
  transferId: string;
  principal: string;
  objectId: string;
  totalChunks: number;
  status: TransferStatus;
  committed: ReadonlySet<number>;
  batches: ReadonlyMap<string, BatchState>;
  /** Ledger version at the moment the transfer was paused. */
  pausedAtVersion: number | null;
}

export interface PublishedVersion {
  version: number;
  payload: string;
  tick: number;
  seq: number;
}

interface MutableTransfer {
  transferId: string;
  principal: string;
  objectId: string;
  totalChunks: number;
  status: TransferStatus;
  committed: Set<number>;
  batches: Map<string, BatchState>;
  pausedAtVersion: number | null;
}

export class TransferEngine {
  readonly ledger = new PermissionLedger();
  private readonly transfers = new Map<string, MutableTransfer>();
  private readonly published = new Map<string, PublishedVersion[]>();
  private readonly evidenceLog: Evidence[] = [];
  private lastTick = -1;
  private lastSeq = -1;

  /**
   * Dispatch a single event. Events must arrive in non-decreasing
   * (tick, seq) order; within one tick, event order decides outcomes.
   */
  dispatch(event: SimEvent): Evidence {
    if (event.tick < this.lastTick || (event.tick === this.lastTick && event.seq <= this.lastSeq)) {
      throw new Error(
        `out-of-order event t${event.tick}#${event.seq} after t${this.lastTick}#${this.lastSeq}`,
      );
    }
    this.lastTick = event.tick;
    this.lastSeq = event.seq;

    const evidence = this.apply(event);
    this.evidenceLog.push(evidence);
    return evidence;
  }

  /** Sort events into (tick, seq) order and dispatch them all. */
  runAll(events: readonly SimEvent[]): Evidence[] {
    return sortEvents(events).map((e) => this.dispatch(e));
  }

  getEvidence(): readonly Evidence[] {
    return this.evidenceLog;
  }

  getTransfer(transferId: string): TransferState | undefined {
    return this.transfers.get(transferId);
  }

  /** Published history is immutable and survives permission revocation. */
  getHistory(objectId: string): readonly PublishedVersion[] {
    return this.published.get(objectId) ?? [];
  }

  private record(
    event: SimEvent,
    decision: "accepted" | "rejected",
    rule: string,
    detail: string,
    extra?: { boundVersion?: number; granted?: boolean },
  ): Evidence {
    const evidence: Evidence = {
      tick: event.tick,
      seq: event.seq,
      kind: event.kind,
      decision,
      rule,
      permissionVersion: this.ledger.version,
      detail,
    };
    if (extra?.boundVersion !== undefined) evidence.boundVersion = extra.boundVersion;
    if (extra?.granted !== undefined) evidence.granted = extra.granted;
    return evidence;
  }

  private apply(event: SimEvent): Evidence {
    switch (event.kind) {
      case "grant": {
        this.ledger.grant(event.principal, event.objectId);
        return this.record(event, "accepted", "GRANT_APPLIED",
          `grant ${event.principal} on ${event.objectId}`);
      }
      case "revoke": {
        this.ledger.revoke(event.principal, event.objectId);
        return this.record(event, "accepted", "REVOKE_APPLIED",
          `revoke ${event.principal} on ${event.objectId}`);
      }
      case "begin":
        return this.applyBegin(event);
      case "submitBatch":
        return this.applySubmitBatch(event);
      case "pause":
        return this.applyPause(event);
      case "resume":
        return this.applyResume(event);
      case "commitBatch":
        return this.applyCommitBatch(event);
      case "publish":
        return this.applyPublish(event);
    }
  }

  private applyBegin(event: Extract<SimEvent, { kind: "begin" }>): Evidence {
    const granted = this.ledger.isGranted(event.principal, event.objectId);
    if (!granted) {
      return this.record(event, "rejected", "BEGIN_NO_PERMISSION",
        `begin ${event.transferId}: ${event.principal} lacks permission on ${event.objectId}`,
        { granted });
    }
    if (this.transfers.has(event.transferId)) {
      return this.record(event, "rejected", "DUPLICATE_TRANSFER",
        `begin ${event.transferId}: transfer already exists`, { granted });
    }
    this.transfers.set(event.transferId, {
      transferId: event.transferId,
      principal: event.principal,
      objectId: event.objectId,
      totalChunks: event.totalChunks,
      status: "active",
      committed: new Set(),
      batches: new Map(),
      pausedAtVersion: null,
    });
    return this.record(event, "accepted", "TRANSFER_BEGUN",
      `begin ${event.transferId} (${event.totalChunks} chunks)`, { granted });
  }

  private applySubmitBatch(event: Extract<SimEvent, { kind: "submitBatch" }>): Evidence {
    const transfer = this.transfers.get(event.transferId);
    if (!transfer) {
      return this.record(event, "rejected", "UNKNOWN_TRANSFER",
        `submit ${event.batchId}: no such transfer ${event.transferId}`);
    }
    if (transfer.status !== "active") {
      return this.record(event, "rejected", "TRANSFER_NOT_ACTIVE",
        `submit ${event.batchId}: transfer is ${transfer.status}`);
    }
    if (transfer.batches.has(event.batchId)) {
      return this.record(event, "rejected", "DUPLICATE_BATCH",
        `submit ${event.batchId}: batch already cached`);
    }
    // Bind the current permission version to the cached batch.
    const boundVersion = this.ledger.version;
    transfer.batches.set(event.batchId, {
      batchId: event.batchId,
      chunks: [...event.chunks],
      boundVersion,
      status: "cached",
    });
    return this.record(event, "accepted", "BATCH_CACHED",
      `cached ${event.chunks.length} chunk(s) bound to permission version`,
      { boundVersion });
  }

  private applyPause(event: Extract<SimEvent, { kind: "pause" }>): Evidence {
    const transfer = this.transfers.get(event.transferId);
    if (!transfer) {
      return this.record(event, "rejected", "UNKNOWN_TRANSFER",
        `pause: no such transfer ${event.transferId}`);
    }
    if (transfer.status !== "active") {
      return this.record(event, "rejected", "TRANSFER_NOT_ACTIVE",
        `pause: transfer is ${transfer.status}`);
    }
    transfer.status = "paused";
    transfer.pausedAtVersion = this.ledger.version;
    return this.record(event, "accepted", "TRANSFER_PAUSED",
      `paused at permission version ${transfer.pausedAtVersion}`);
  }

  private applyResume(event: Extract<SimEvent, { kind: "resume" }>): Evidence {
    const transfer = this.transfers.get(event.transferId);
    if (!transfer) {
      return this.record(event, "rejected", "UNKNOWN_TRANSFER",
        `resume: no such transfer ${event.transferId}`);
    }
    if (transfer.status !== "paused") {
      return this.record(event, "rejected", "TRANSFER_NOT_PAUSED",
        `resume: transfer is ${transfer.status}`);
    }
    // Re-check permission before resuming.
    const granted = this.ledger.isGranted(transfer.principal, transfer.objectId);
    if (!granted) {
      return this.record(event, "rejected", "RESUME_PERMISSION_REVOKED",
        `resume ${transfer.transferId}: permission revoked, stays paused`,
        { granted });
    }
    const drift = this.ledger.version !== transfer.pausedAtVersion;
    transfer.status = "active";
    transfer.pausedAtVersion = null;
    return this.record(event, "accepted", "RESUME_RECHECKED",
      drift
        ? "resumed; permission version drifted while paused, cached batches are stale"
        : "resumed; permission version unchanged",
      { granted });
  }

  private applyCommitBatch(event: Extract<SimEvent, { kind: "commitBatch" }>): Evidence {
    const transfer = this.transfers.get(event.transferId);
    if (!transfer) {
      return this.record(event, "rejected", "UNKNOWN_TRANSFER",
        `commit ${event.batchId}: no such transfer ${event.transferId}`);
    }
    const batch = transfer.batches.get(event.batchId);
    if (!batch) {
      return this.record(event, "rejected", "UNKNOWN_BATCH",
        `commit ${event.batchId}: batch not cached`);
    }
    if (batch.status !== "cached") {
      return this.record(event, "rejected", "BATCH_ALREADY_COMMITTED",
        `commit ${event.batchId}: already committed`,
        { boundVersion: batch.boundVersion });
    }
    if (transfer.status !== "active") {
      return this.record(event, "rejected", "TRANSFER_NOT_ACTIVE",
        `commit ${event.batchId}: transfer is ${transfer.status}`,
        { boundVersion: batch.boundVersion });
    }
    const granted = this.ledger.isGranted(transfer.principal, transfer.objectId);
    if (!granted) {
      // Revoked after caching: cached chunks may not be committed.
      return this.record(event, "rejected", "PERMISSION_REVOKED",
        `commit ${event.batchId}: permission revoked, cached chunks refused`,
        { boundVersion: batch.boundVersion, granted });
    }
    if (batch.boundVersion !== this.ledger.version) {
      // Permission changed since caching (e.g. revoke then re-grant):
      // the bound version is stale and the batch must be re-submitted.
      return this.record(event, "rejected", "STALE_VERSION",
        `commit ${event.batchId}: bound version stale, re-submit required`,
        { boundVersion: batch.boundVersion, granted });
    }
    for (const chunk of batch.chunks) {
      if (chunk >= 0 && chunk < transfer.totalChunks) transfer.committed.add(chunk);
    }
    batch.status = "committed";
    let detail = `committed ${batch.chunks.length} chunk(s)`;
    if (transfer.committed.size === transfer.totalChunks) {
      transfer.status = "completed";
      detail += "; transfer completed";
    }
    return this.record(event, "accepted", "BATCH_COMMITTED", detail,
      { boundVersion: batch.boundVersion, granted });
  }

  private applyPublish(event: Extract<SimEvent, { kind: "publish" }>): Evidence {
    const granted = this.ledger.isGranted(event.principal, event.objectId);
    if (!granted) {
      return this.record(event, "rejected", "PUBLISH_NO_PERMISSION",
        `publish on ${event.objectId}: ${event.principal} lacks permission`,
        { granted });
    }
    const history = this.published.get(event.objectId) ?? [];
    const version: PublishedVersion = {
      version: history.length + 1,
      payload: event.payload,
      tick: event.tick,
      seq: event.seq,
    };
    history.push(version);
    this.published.set(event.objectId, history);
    return this.record(event, "accepted", "PUBLISHED",
      `published ${event.objectId} v${version.version}`, { granted });
  }
}
