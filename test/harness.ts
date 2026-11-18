import assert from 'node:assert/strict';
import {
  createQuotaCluster,
  maxWindowUsage,
  type QuotaCoordinator,
  type ReconcileReport,
} from '../src/index.js';
import { NaiveShard } from './naive.js';

export interface HarnessOptions {
  quota: number;
  windowMs: number;
  reservationTtlMs: number;
  maxClockDriftMs?: number;
  nodeIds: readonly string[];
  shardLimits?: readonly number[];
  physicalSkews?: readonly number[];
}

export class Harness {
  readonly cluster: QuotaCoordinator;
  readonly model = new Map<string, NaiveShard>();
  readonly nodeIds: readonly string[];
  readonly effectiveWindowMs: number;
  readonly trace: string[] = [];
  #counter = 0;

  constructor(options: HarnessOptions) {
    this.nodeIds = options.nodeIds;
    this.effectiveWindowMs = options.windowMs + 2 * (options.maxClockDriftMs ?? 0);
    const nodes = options.nodeIds.map((id, index) => ({
      id,
      shardLimit: options.shardLimits?.[index],
      physicalSkewMs: options.physicalSkews?.[index] ?? 0,
    }));
    this.cluster = createQuotaCluster({
      quota: options.quota,
      windowMs: options.windowMs,
      reservationTtlMs: options.reservationTtlMs,
      maxClockDriftMs: options.maxClockDriftMs,
      nodes,
    });
    for (const id of options.nodeIds) {
      const node = this.cluster.node(id);
      this.model.set(
        id,
        new NaiveShard(
          id,
          node.shardLimit,
          this.effectiveWindowMs,
          options.reservationTtlMs,
        ),
      );
    }
  }

  now(nodeId: string): number {
    return this.cluster.node(nodeId).clock.now();
  }

  reserve(nodeId: string): { id: string; ok: boolean } {
    const id = `r${this.#counter}`;
    this.#counter += 1;
    const at = this.now(nodeId);
    const actual = this.cluster.reserve(nodeId, id).ok;
    const expected = this.#model(nodeId).reserve(id, at);
    this.#assertEqual(actual, expected, `${nodeId}.reserve(${id})`);
    this.trace.push(`reserve:${nodeId}:${id}:${expected ? 'ok' : 'reject'}`);
    this.settleAll();
    return { id, ok: expected };
  }

  commit(nodeId: string): boolean {
    const target = this.#model(nodeId).liveReservedIds()[0] ?? 'missing';
    const at = this.now(nodeId);
    const actual = this.cluster.commit(nodeId, target);
    const expected = this.#model(nodeId).commit(target, at);
    this.#assertEqual(actual, expected, `${nodeId}.commit(${target})`);
    this.trace.push(`commit:${nodeId}:${target}:${expected ? 'ok' : 'no'}`);
    this.settleAll();
    return expected;
  }

  release(nodeId: string): boolean {
    const target = this.#model(nodeId).liveReservedIds()[0] ?? 'missing';
    const at = this.now(nodeId);
    const actual = this.cluster.release(nodeId, target);
    const expected = this.#model(nodeId).release(target, at);
    this.#assertEqual(actual, expected, `${nodeId}.release(${target})`);
    this.trace.push(`release:${nodeId}:${target}:${expected ? 'ok' : 'no'}`);
    this.settleAll();
    return expected;
  }

  advance(ms: number): void {
    this.cluster.advance(ms);
    this.trace.push(`advance:${ms}`);
    this.settleAll();
  }

  advanceNodeClock(nodeId: string, ms: number): void {
    this.cluster.advanceNodeClock(nodeId, ms);
    this.trace.push(`advance-node:${nodeId}:${ms}`);
    this.settleAll();
  }

  sync(nodeId?: string): void {
    if (nodeId === undefined) {
      this.cluster.sync();
    } else {
      this.cluster.sync(nodeId);
    }
    this.trace.push(`sync:${nodeId ?? '*'}`);
    this.settleAll();
  }

  reconcile(): ReconcileReport {
    const report = this.cluster.reconcile();
    this.trace.push('reconcile');
    for (const id of this.nodeIds) {
      const node = this.cluster.node(id);
      this.#model(id).tick(node.clock.now());
      this.#checkNode(id);
    }
    this.#assertEqual(
      report.violations.length,
      0,
      `reconcile violations: ${report.violations.join('; ')}`,
    );
    this.checkGlobal();
    return report;
  }

  settleAll(): void {
    for (const id of this.nodeIds) {
      const node = this.cluster.node(id);
      const now = node.clock.now();
      const actualExpired = node.tick();
      const expectedExpired = this.#model(id).tick(now);
      this.#assertEqual(
        actualExpired,
        expectedExpired,
        `${id}.tick at ${now}`,
      );
      this.#checkNode(id);
    }
  }

  checkGlobal(): void {
    const coordinatorRecords = this.cluster.records();
    const globalTimes: number[] = [];
    for (const id of this.nodeIds) {
      const node = this.cluster.node(id);
      const expected = this.#model(id).records(node.clock.now());
      this.#assertEqual(
        coordinatorRecords[id] ?? [],
        expected,
        `coordinator records for ${id}`,
      );
      for (const record of expected) {
        globalTimes.push(record.at);
      }
    }
    const globalCount = Object.values(coordinatorRecords).reduce(
      (sum, records) => sum + records.length,
      0,
    );
    this.#assertEqual(
      this.cluster.globalRecords().length,
      globalCount,
      'global record count',
    );

    const audit = this.cluster.audit();
    this.#assertEqual(audit.ok, true, `audit violations: ${audit.violations.join('; ')}`);
    this.#assertEqual(audit.inSync, true, 'coordinator is not in sync');
    this.#assertEqual(
      audit.globalMaxWindowUsage,
      maxWindowUsage(globalTimes, this.effectiveWindowMs),
      'global max window usage',
    );
    assert.ok(
      audit.globalMaxWindowUsage <= audit.quota,
      `global usage ${audit.globalMaxWindowUsage} exceeds quota ${audit.quota}`,
    );

    const totalAccepted = audit.nodes.reduce(
      (sum, node) => sum + node.accepted,
      0,
    );
    const totalLive = audit.nodes.reduce(
      (sum, node) => sum + node.liveReserved,
      0,
    );
    const totalPassed = audit.nodes.reduce(
      (sum, node) => sum + node.committed,
      0,
    );
    const totalReleased = audit.nodes.reduce(
      (sum, node) => sum + node.released,
      0,
    );
    this.#assertEqual(
      totalAccepted,
      totalLive + totalPassed + totalReleased,
      'aggregate conservation',
    );
    assert.ok(
      audit.nodes.every((node) => node.conserved),
      `node conservation failed: ${audit.violations.join('; ')}`,
    );
  }

  #checkNode(nodeId: string): void {
    const node = this.cluster.node(nodeId);
    const model = this.#model(nodeId);
    const now = node.clock.now();
    const actualRecords = node.records();
    const expectedRecords = model.records(now);
    this.#assertEqual(actualRecords, expectedRecords, `${nodeId} records`);

    const actualActive = node
      .activeReservations()
      .map((reservation) => reservation.id);
    this.#assertEqual(
      actualActive,
      model.liveReservedIds(),
      `${nodeId} active reservations`,
    );

    this.#assertEqual(
      node.remainingQuota(now),
      model.remaining(now),
      `${nodeId} remaining quota at ${now}`,
    );

    const actualMax = node.maxWindowUsage();
    const expectedMax = maxWindowUsage(
      expectedRecords.map((record) => record.at),
      this.effectiveWindowMs,
    );
    this.#assertEqual(actualMax, expectedMax, `${nodeId} max window usage`);
    assert.ok(
      actualMax <= node.shardLimit,
      `${nodeId} usage ${actualMax} exceeds shard ${node.shardLimit}`,
    );

    const stats = node.stats;
    const released = stats.releasedExplicit + stats.releasedTimeout;
    this.#assertEqual(
      stats.accepted,
      actualActive.length + stats.committed + released,
      `${nodeId} local conservation`,
    );
    this.#assertEqual(stats.accepted, model.accepted, `${nodeId} accepted count`);
    this.#assertEqual(stats.committed, model.committed, `${nodeId} committed count`);
    this.#assertEqual(released, model.released, `${nodeId} released count`);
  }

  #model(nodeId: string): NaiveShard {
    const model = this.model.get(nodeId);
    if (model === undefined) {
      throw new Error(`missing model for ${nodeId}`);
    }
    return model;
  }

  #assertEqual<T>(actual: T, expected: T, context: string): void {
    assert.deepEqual(
      actual,
      expected,
      `${context} after [${this.trace.join(' ')}]`,
    );
  }
}
