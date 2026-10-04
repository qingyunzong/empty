import { readFileSync, writeFileSync } from "node:fs";
import type { ArmId, ArmStatus, ItemId, SegmentId, SimConfig, SimEvent } from "./model";

export interface SnapshotArm {
  status: ArmStatus;
  held: SegmentId[];
  waitingFor: SegmentId | null;
}

export interface SnapshotSegment {
  item: ItemId | null;
  holder: ArmId | null;
  queue: ArmId[];
}

/** Serializable snapshot of the whole simulation state after `atEvent`. */
export interface Snapshot {
  atEvent: number;
  tick: number;
  items: Record<ItemId, SegmentId>;
  segments: Record<SegmentId, SnapshotSegment>;
  arms: Record<ArmId, SnapshotArm>;
}

export function saveSnapshot(snapshot: Snapshot, file: string): void {
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
}

export function loadSnapshot(file: string): Snapshot {
  return JSON.parse(readFileSync(file, "utf8")) as Snapshot;
}

function initialSnapshot(config: SimConfig): Snapshot {
  const segments: Snapshot["segments"] = {};
  for (const id of config.segments) {
    segments[id] = { item: null, holder: null, queue: [] };
  }
  const items: Snapshot["items"] = {};
  for (const [item, seg] of Object.entries(config.items)) {
    segments[seg].item = item;
    items[item] = seg;
  }
  const arms: Snapshot["arms"] = {};
  for (const spec of config.arms) {
    arms[spec.id] = { status: "running", held: [], waitingFor: null };
  }
  return { atEvent: -1, tick: 0, items, segments, arms };
}

function applyEvent(state: Snapshot, event: SimEvent): void {
  switch (event.type) {
    case "acquire": {
      const arm = state.arms[event.arm!];
      const seg = state.segments[event.segment!];
      seg.holder = event.arm!;
      seg.queue = seg.queue.filter((a) => a !== event.arm);
      if (!arm.held.includes(event.segment!)) arm.held.push(event.segment!);
      arm.waitingFor = null;
      arm.status = "running";
      break;
    }
    case "release":
    case "rollback-release": {
      const arm = state.arms[event.arm!];
      const seg = state.segments[event.segment!];
      if (seg.holder === event.arm) seg.holder = null;
      arm.held = arm.held.filter((s) => s !== event.segment);
      break;
    }
    case "block": {
      const arm = state.arms[event.arm!];
      const seg = state.segments[event.segment!];
      arm.status = "blocked";
      arm.waitingFor = event.segment!;
      if (!seg.queue.includes(event.arm!)) seg.queue.push(event.arm!);
      break;
    }
    case "move": {
      state.segments[event.from!].item = null;
      state.segments[event.to!].item = event.item!;
      state.items[event.item!] = event.to!;
      break;
    }
    case "fail": {
      state.arms[event.arm!].status = "failed";
      break;
    }
    case "job-done": {
      state.arms[event.arm!].status = "done";
      break;
    }
    case "deadlock":
      break;
  }
  state.atEvent = event.seq;
  state.tick = event.tick;
}

export interface ReplayResult {
  snapshot: Snapshot;
  violations: string[];
}

/**
 * Replay the event log from the initial config, checking the invariants
 * after every event. If `upTo` is given, stop after that event seq.
 */
export function replayEvents(
  config: SimConfig,
  events: SimEvent[],
  upTo?: number,
): ReplayResult {
  const state = initialSnapshot(config);
  const violations: string[] = [];
  for (const event of events) {
    if (upTo !== undefined && event.seq > upTo) break;
    applyEvent(state, event);
    for (const v of verifySnapshot(state, config)) {
      violations.push(`after event #${event.seq} (${event.type}): ${v}`);
    }
  }
  return { snapshot: state, violations };
}

/**
 * Invariants checked on a snapshot:
 *  1. Unique position: every item rests on exactly one segment, and the
 *     item->segment map and segment->item map agree (bijection).
 *  2. Conservation: the item set is exactly the initial set; nothing lost
 *     or created.
 *  3. Mutual exclusion: a segment has at most one holder; holder and
 *     arm.held agree; no arm holds a segment twice.
 *  4. Wait edges are valid: a blocked arm waits on an existing segment it
 *     does not hold itself (the holder may momentarily be null while a
 *     grant is in flight between a release and the waiter's acquire).
 */
export function verifySnapshot(snapshot: Snapshot, config: SimConfig): string[] {
  const violations: string[] = [];

  const initialItems = new Set(Object.keys(config.items));
  const currentItems = new Set(Object.keys(snapshot.items));
  for (const item of initialItems) {
    if (!currentItems.has(item)) violations.push(`item ${item} lost (conservation)`);
  }
  for (const item of currentItems) {
    if (!initialItems.has(item)) violations.push(`item ${item} created out of nowhere (conservation)`);
  }

  const seenOn = new Map<ItemId, SegmentId[]>();
  for (const [segId, seg] of Object.entries(snapshot.segments)) {
    if (seg.item !== null) {
      const list = seenOn.get(seg.item) ?? [];
      list.push(segId);
      seenOn.set(seg.item, list);
    }
  }
  for (const item of initialItems) {
    const places = seenOn.get(item) ?? [];
    if (places.length === 0) violations.push(`item ${item} has no position (unique position)`);
    if (places.length > 1) {
      violations.push(`item ${item} duplicated on ${places.join(", ")} (unique position)`);
    }
  }
  for (const [item, segId] of Object.entries(snapshot.items)) {
    const seg = snapshot.segments[segId];
    if (!seg) {
      violations.push(`item ${item} mapped to unknown segment ${segId}`);
    } else if (seg.item !== item) {
      violations.push(`item map says ${item} is on ${segId} but segment holds ${seg.item}`);
    }
  }

  for (const [segId, seg] of Object.entries(snapshot.segments)) {
    if (seg.holder !== null) {
      const arm = snapshot.arms[seg.holder];
      if (!arm) {
        violations.push(`segment ${segId} held by unknown arm ${seg.holder}`);
      } else if (!arm.held.includes(segId)) {
        violations.push(`segment ${segId} holder ${seg.holder} missing it in held list`);
      }
    }
    const queued = new Set(seg.queue);
    if (queued.size !== seg.queue.length) {
      violations.push(`segment ${segId} wait queue has duplicate entries`);
    }
  }
  for (const [armId, arm] of Object.entries(snapshot.arms)) {
    const heldSet = new Set(arm.held);
    if (heldSet.size !== arm.held.length) {
      violations.push(`arm ${armId} holds a segment twice`);
    }
    for (const segId of arm.held) {
      const seg = snapshot.segments[segId];
      if (!seg || seg.holder !== armId) {
        violations.push(`arm ${armId} holds ${segId} but segment holder is ${seg?.holder}`);
      }
    }
    if (arm.status === "blocked") {
      if (arm.waitingFor === null) {
        violations.push(`arm ${armId} blocked but waits on nothing`);
      } else if (!snapshot.segments[arm.waitingFor]) {
        violations.push(`arm ${armId} waits on unknown segment ${arm.waitingFor}`);
      } else if (arm.held.includes(arm.waitingFor)) {
        violations.push(`arm ${armId} waits on segment ${arm.waitingFor} it already holds`);
      }
    }
  }

  return violations;
}
