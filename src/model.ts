export type SegmentId = string;
export type ItemId = string;
export type ArmId = string;

export interface SegmentConfig {
  id: SegmentId;
  /** max items physically present on the segment */
  capacity: number;
  /** max arms allowed to hold the segment lock (1 = mutual exclusion) */
  lockCapacity: number;
}

export interface ItemConfig {
  id: ItemId;
  at: SegmentId;
}

export interface WorldConfig {
  segments: SegmentConfig[];
  items: ItemConfig[];
  arms: ArmId[];
}

export type Step =
  | { kind: 'acquire'; segment: SegmentId }
  | { kind: 'release'; segment: SegmentId }
  | { kind: 'pick'; item: ItemId; segment: SegmentId }
  | { kind: 'place'; item: ItemId; segment: SegmentId };

export interface ActionDef {
  id: string;
  arm: ArmId;
  steps: Step[];
}

export interface SegmentState {
  id: SegmentId;
  capacity: number;
  lockCapacity: number;
  occupants: ItemId[]; // kept sorted for deterministic comparison
  holders: ArmId[]; // lock holders, kept sorted
}

export interface ArmState {
  id: ArmId;
  heldItem: ItemId | null;
  locks: SegmentId[]; // acquisition order (drives reverse-order rollback)
}

export interface WorldState {
  segments: Record<SegmentId, SegmentState>;
  arms: Record<ArmId, ArmState>;
  items: ItemId[]; // sorted universe of all items
}

export function createWorld(config: WorldConfig): WorldState {
  const segments: Record<SegmentId, SegmentState> = {};
  for (const seg of config.segments) {
    segments[seg.id] = {
      id: seg.id,
      capacity: seg.capacity,
      lockCapacity: seg.lockCapacity,
      occupants: [],
      holders: [],
    };
  }
  for (const item of config.items) {
    const seg = segments[item.at];
    if (!seg) throw new Error(`item ${item.id} placed on unknown segment ${item.at}`);
    seg.occupants.push(item.id);
    seg.occupants.sort();
  }
  const arms: Record<ArmId, ArmState> = {};
  for (const armId of config.arms) {
    arms[armId] = { id: armId, heldItem: null, locks: [] };
  }
  return { segments, arms, items: config.items.map((i) => i.id).sort() };
}

export function acquireLock(state: WorldState, armId: ArmId, segmentId: SegmentId): void {
  const arm = state.arms[armId];
  const seg = state.segments[segmentId];
  if (!arm) throw new Error(`acquireLock: unknown arm ${armId}`);
  if (!seg) throw new Error(`acquireLock: unknown segment ${segmentId}`);
  if (!seg.holders.includes(armId)) {
    seg.holders.push(armId);
    seg.holders.sort();
  }
  if (!arm.locks.includes(segmentId)) arm.locks.push(segmentId);
}

export function releaseLock(state: WorldState, armId: ArmId, segmentId: SegmentId): void {
  const arm = state.arms[armId];
  const seg = state.segments[segmentId];
  if (!arm) throw new Error(`releaseLock: unknown arm ${armId}`);
  if (!seg) throw new Error(`releaseLock: unknown segment ${segmentId}`);
  const holderIdx = seg.holders.indexOf(armId);
  if (holderIdx >= 0) seg.holders.splice(holderIdx, 1);
  const lockIdx = arm.locks.indexOf(segmentId);
  if (lockIdx >= 0) arm.locks.splice(lockIdx, 1);
}

export function pickItem(state: WorldState, armId: ArmId, segmentId: SegmentId, item: ItemId): void {
  const arm = state.arms[armId];
  const seg = state.segments[segmentId];
  if (!arm) throw new Error(`pickItem: unknown arm ${armId}`);
  if (!seg) throw new Error(`pickItem: unknown segment ${segmentId}`);
  const idx = seg.occupants.indexOf(item);
  if (idx >= 0) seg.occupants.splice(idx, 1);
  arm.heldItem = item;
}

export function placeItem(state: WorldState, armId: ArmId, segmentId: SegmentId, item: ItemId): void {
  const arm = state.arms[armId];
  const seg = state.segments[segmentId];
  if (!arm) throw new Error(`placeItem: unknown arm ${armId}`);
  if (!seg) throw new Error(`placeItem: unknown segment ${segmentId}`);
  if (arm.heldItem === item) arm.heldItem = null;
  seg.occupants.push(item);
  seg.occupants.sort();
}

/**
 * Invariants checked after every event (live and during replay):
 *  - item uniqueness: every item exists in exactly one location
 *    (a segment's occupant list or an arm's gripper), none lost, none invented;
 *  - resource conservation: lock claims by arms match segment holder records
 *    exactly, and no segment exceeds its item capacity or lock capacity.
 */
export function verifyWorld(state: WorldState): string[] {
  const violations: string[] = [];

  const seen = new Map<ItemId, string>();
  const note = (item: ItemId, where: string): void => {
    const prev = seen.get(item);
    if (prev !== undefined) {
      violations.push(`item ${item} has multiple locations: ${prev} and ${where}`);
    } else {
      seen.set(item, where);
    }
  };
  for (const seg of Object.values(state.segments)) {
    if (seg.occupants.length > seg.capacity) {
      violations.push(`segment ${seg.id} holds ${seg.occupants.length} items, capacity ${seg.capacity}`);
    }
    for (const item of seg.occupants) note(item, `segment ${seg.id}`);
  }
  for (const arm of Object.values(state.arms)) {
    if (arm.heldItem !== null) note(arm.heldItem, `arm ${arm.id}`);
  }
  for (const item of state.items) {
    if (!seen.has(item)) violations.push(`item ${item} lost: no location`);
  }
  for (const [item, where] of seen) {
    if (!state.items.includes(item)) violations.push(`unknown item ${item} at ${where}`);
  }

  const claims = new Map<SegmentId, ArmId[]>();
  for (const arm of Object.values(state.arms)) {
    for (const segId of arm.locks) {
      const list = claims.get(segId) ?? [];
      list.push(arm.id);
      claims.set(segId, list);
    }
  }
  for (const seg of Object.values(state.segments)) {
    if (seg.holders.length > seg.lockCapacity) {
      violations.push(`segment ${seg.id} locked by ${seg.holders.length} arms, lock capacity ${seg.lockCapacity}`);
    }
    const claimed = (claims.get(seg.id) ?? []).slice().sort();
    const held = seg.holders.slice().sort();
    if (JSON.stringify(claimed) !== JSON.stringify(held)) {
      violations.push(
        `lock mismatch on segment ${seg.id}: arms claim [${claimed.join(',')}], segment records [${held.join(',')}]`,
      );
    }
  }
  for (const [segId, armIds] of claims) {
    if (!state.segments[segId]) violations.push(`lock claimed on unknown segment ${segId}`);
    if (new Set(armIds).size !== armIds.length) {
      violations.push(`segment ${segId} lock claimed twice by the same arm`);
    }
  }
  return violations;
}
