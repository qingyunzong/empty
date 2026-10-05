import { EventLog } from './events.js';
import { PermissionLedger, permissionEventSeqs } from './permissions.js';
import { PublishedStore } from './publish.js';
import type { ResolutionEvidence } from './evidence.js';

export interface Block {
  id: string;
  data: string;
}

export type BatchState = 'open' | 'suspended' | 'committed' | 'aborted';

export interface BatchView {
  id: string;
  subject: string;
  resource: string;
  boundPermissionVersion: number;
  state: BatchState;
  cachedBlockIds: string[];
}

interface Batch extends Omit<BatchView, 'cachedBlockIds'> {
  cachedBlocks: Block[];
}

export class TransferEngine {
  private readonly batches = new Map<string, Batch>();
  readonly evidence: ResolutionEvidence[] = [];

  constructor(
    private readonly log: EventLog,
    private readonly ledger: PermissionLedger,
    private readonly store: PublishedStore,
  ) {}

  openBatch(tick: number, batchId: string, subject: string, resource: string): ResolutionEvidence {
    if (this.batches.has(batchId)) {
      throw new Error(`batch ${batchId} already exists`);
    }
    const boundPermissionVersion = this.ledger.currentVersion;
    const effective = this.ledger.effectNow(subject, resource);
    const allowed = effective !== null && effective.effect === 'allow';
    const reason = allowed
      ? 'permission granted at open'
      : effective === null
        ? 'no permission record'
        : 'permission revoked';
    const event = this.log.append(tick, {
      kind: 'batch.open',
      batchId,
      subject,
      resource,
      boundPermissionVersion,
      decision: allowed ? 'accepted' : 'rejected',
      reason,
    });
    if (allowed) {
      this.batches.set(batchId, {
        id: batchId,
        subject,
        resource,
        boundPermissionVersion,
        state: 'open',
        cachedBlocks: [],
      });
    }
    return this.record({
      operation: 'open',
      batchId,
      subject,
      resource,
      tick,
      decidedAtSeq: event.seq,
      boundPermissionVersion,
      effectivePermission: effective,
      decision: allowed ? 'accepted' : 'rejected',
      reason,
      consultedEventSeqs: permissionEventSeqs(this.log.all(), subject, resource, event.seq),
    });
  }

  cacheBlock(batchId: string, block: Block): void {
    const batch = this.requireBatch(batchId);
    if (batch.state !== 'open') {
      throw new Error(`cannot cache block on batch in state ${batch.state}`);
    }
    batch.cachedBlocks.push(block);
    this.log.append(this.lastTick(), { kind: 'batch.block_cached', batchId, blockId: block.id });
  }

  suspend(batchId: string): void {
    const batch = this.requireBatch(batchId);
    if (batch.state !== 'open') {
      throw new Error(`cannot suspend batch in state ${batch.state}`);
    }
    batch.state = 'suspended';
  }

  resume(tick: number, batchId: string): ResolutionEvidence {
    const batch = this.requireBatch(batchId);
    if (batch.state !== 'suspended') {
      throw new Error(`cannot resume batch in state ${batch.state}`);
    }
    const effective = this.ledger.effectNow(batch.subject, batch.resource);
    const allowed = effective !== null && effective.effect === 'allow';
    const reason = allowed
      ? 'permission re-verified on resume'
      : effective === null
        ? 'no permission record'
        : 'permission revoked since batch was bound';
    const event = this.log.append(tick, {
      kind: 'batch.resume',
      batchId,
      decision: allowed ? 'accepted' : 'rejected',
      reason,
    });
    if (allowed) {
      batch.state = 'open';
    }
    return this.record({
      operation: 'resume',
      batchId,
      subject: batch.subject,
      resource: batch.resource,
      tick,
      decidedAtSeq: event.seq,
      boundPermissionVersion: batch.boundPermissionVersion,
      effectivePermission: effective,
      decision: allowed ? 'accepted' : 'rejected',
      reason,
      consultedEventSeqs: this.consultedSeqs(batch, event.seq),
    });
  }

  commit(tick: number, batchId: string, objectId: string): ResolutionEvidence {
    const batch = this.requireBatch(batchId);
    if (batch.state !== 'open' && batch.state !== 'suspended') {
      throw new Error(`cannot commit batch in state ${batch.state}`);
    }
    const effective = this.ledger.effectNow(batch.subject, batch.resource);
    const allowed = effective !== null && effective.effect === 'allow';
    const blockIds = batch.cachedBlocks.map((b) => b.id);
    const reason = allowed
      ? 'permission effective at commit'
      : effective === null
        ? 'no permission record'
        : 'permission revoked; cached blocks discarded';
    const event = this.log.append(tick, {
      kind: 'batch.commit',
      batchId,
      objectId,
      decision: allowed ? 'accepted' : 'rejected',
      reason,
      blockIds,
    });
    if (allowed) {
      const published = this.store.publish(objectId, blockIds, event.seq, tick);
      this.log.append(tick, {
        kind: 'object.publish',
        objectId,
        objectVersion: published.version,
        blockIds,
      });
      batch.state = 'committed';
    } else {
      batch.state = 'aborted';
    }
    batch.cachedBlocks = [];
    return this.record({
      operation: 'commit',
      batchId,
      subject: batch.subject,
      resource: batch.resource,
      tick,
      decidedAtSeq: event.seq,
      boundPermissionVersion: batch.boundPermissionVersion,
      effectivePermission: effective,
      decision: allowed ? 'accepted' : 'rejected',
      reason,
      consultedEventSeqs: this.consultedSeqs(batch, event.seq),
      objectId,
      blockIds,
    });
  }

  batchView(batchId: string): BatchView {
    const batch = this.requireBatch(batchId);
    return {
      id: batch.id,
      subject: batch.subject,
      resource: batch.resource,
      boundPermissionVersion: batch.boundPermissionVersion,
      state: batch.state,
      cachedBlockIds: batch.cachedBlocks.map((b) => b.id),
    };
  }

  private consultedSeqs(batch: Batch, beforeSeq: number): number[] {
    const seqs = permissionEventSeqs(this.log.all(), batch.subject, batch.resource, beforeSeq);
    const openEvent = this.log
      .all()
      .find((e) => e.kind === 'batch.open' && e.batchId === batch.id);
    if (openEvent) seqs.push(openEvent.seq);
    return seqs.sort((a, b) => a - b);
  }

  private requireBatch(batchId: string): Batch {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new Error(`unknown batch ${batchId}`);
    }
    return batch;
  }

  private lastTick(): number {
    const all = this.log.all();
    return all.length > 0 ? all[all.length - 1]!.tick : 0;
  }

  private record(evidence: ResolutionEvidence): ResolutionEvidence {
    this.evidence.push(evidence);
    return evidence;
  }
}
