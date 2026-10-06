import {
  ActiveEvent,
  DataEvent,
  IdleEvent,
  PartitionId,
  PartitionState,
  PartitionStatus,
  ReplayResult,
  Rejection,
  StreamEvent,
  WatermarkPoint,
} from './types';

interface MutablePartitionState {
  status: PartitionStatus;
  watermark: number | null;
}

/**
 * Tracks per-partition watermarks and derives a global watermark as the
 * minimum across ACTIVE partitions only.
 *
 * Idleness is driven exclusively by explicit `idle` / `active` events;
 * the wall clock is never consulted. A `data` event on an idle partition
 * reactivates it (real data implies activity), subject to the same
 * rejection rules as any other data.
 *
 * Rejection rules (recorded, never silently dropped):
 *  - data with a timestamp below the partition's own watermark;
 *  - data with a timestamp below the already-published global watermark;
 *  - reactivation (`active`) of a partition whose stored watermark is
 *    behind the already-published global watermark (the partition stays
 *    idle, since its recovered data would precede the published watermark).
 *
 * The published watermark is monotonically non-decreasing by construction:
 * a new point is appended to the trajectory only when the candidate
 * (min over active partitions) exceeds the current published value.
 */
export class WatermarkTracker {
  private readonly partitions = new Map<PartitionId, MutablePartitionState>();
  private published: number | null = null;
  private eventCount = 0;

  readonly trajectory: WatermarkPoint[] = [];
  readonly rejections: Rejection[] = [];

  get watermark(): number | null {
    return this.published;
  }

  apply(event: StreamEvent): void {
    const index = this.eventCount++;
    switch (event.type) {
      case 'data':
        this.onData(event, index);
        break;
      case 'idle':
        this.onIdle(event, index);
        break;
      case 'active':
        this.onActive(event, index);
        break;
    }
  }

  applyAll(events: readonly StreamEvent[]): void {
    for (const event of events) this.apply(event);
  }

  snapshot(): PartitionState[] {
    return [...this.partitions.entries()].map(([id, p]) => ({
      id,
      status: p.status,
      watermark: p.watermark,
    }));
  }

  private ensure(id: PartitionId): MutablePartitionState {
    let p = this.partitions.get(id);
    if (!p) {
      p = { status: 'active', watermark: null };
      this.partitions.set(id, p);
    }
    return p;
  }

  private reject(event: StreamEvent, eventIndex: number, reason: Rejection['reason']): void {
    this.rejections.push({
      eventIndex,
      event,
      reason,
      publishedWatermark: this.published,
    });
  }

  private onData(event: DataEvent, eventIndex: number): void {
    const p = this.ensure(event.partition);
    if (p.watermark !== null && event.timestamp < p.watermark) {
      this.reject(event, eventIndex, 'late-data-below-partition-watermark');
      return;
    }
    if (this.published !== null && event.timestamp < this.published) {
      this.reject(event, eventIndex, 'data-before-published-watermark');
      return;
    }
    p.status = 'active';
    p.watermark = event.timestamp;
    this.maybePublish(event, eventIndex);
  }

  private onIdle(event: IdleEvent, eventIndex: number): void {
    const p = this.ensure(event.partition);
    p.status = 'idle';
    this.maybePublish(event, eventIndex);
  }

  private onActive(event: ActiveEvent, eventIndex: number): void {
    const p = this.ensure(event.partition);
    if (p.status === 'active') return;
    if (this.published !== null && p.watermark !== null && p.watermark < this.published) {
      this.reject(event, eventIndex, 'recovery-behind-published-watermark');
      return;
    }
    p.status = 'active';
    // Re-adding a partition can only lower the candidate minimum, so the
    // published watermark is left untouched and never regresses.
  }

  private candidate(): number | null {
    let min: number | null = null;
    for (const p of this.partitions.values()) {
      if (p.status !== 'active' || p.watermark === null) continue;
      if (min === null || p.watermark < min) min = p.watermark;
    }
    return min;
  }

  private maybePublish(event: StreamEvent, eventIndex: number): void {
    const c = this.candidate();
    if (c !== null && (this.published === null || c > this.published)) {
      this.published = c;
      this.trajectory.push({
        sequence: this.trajectory.length,
        watermark: c,
        cause: { eventIndex, event },
      });
    }
  }
}

export function isMonotonic(trajectory: readonly WatermarkPoint[]): boolean {
  for (let i = 1; i < trajectory.length; i++) {
    const current = trajectory[i];
    const previous = trajectory[i - 1];
    if (current !== undefined && previous !== undefined && current.watermark <= previous.watermark) {
      return false;
    }
  }
  return true;
}

/**
 * Replays an event log through a fresh tracker and verifies that the
 * resulting global-watermark trajectory is strictly increasing.
 */
export function replay(events: readonly StreamEvent[]): ReplayResult {
  const tracker = new WatermarkTracker();
  tracker.applyAll(events);
  return {
    trajectory: [...tracker.trajectory],
    rejections: [...tracker.rejections],
    finalWatermark: tracker.watermark,
    partitions: tracker.snapshot(),
    monotonic: isMonotonic(tracker.trajectory),
  };
}
