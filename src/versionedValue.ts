import { dominates, format, type VersionVector } from "./versionVector";

export interface VersionedValue {
  readonly value: number | null;
  readonly vv: VersionVector;
  readonly tombstone: boolean;
}

export function itemId(item: VersionedValue): string {
  return `${format(item.vv)}${item.tombstone ? "#tombstone" : "#value"}`;
}

export function describeItem(item: VersionedValue): string {
  const body = item.tombstone ? "TOMBSTONE(撤回)" : `value=${String(item.value)}`;
  return `${format(item.vv)} ${body}`;
}

export function normalizeSet(items: readonly VersionedValue[]): VersionedValue[] {
  const byId = new Map<string, VersionedValue>();
  for (const item of items) {
    const id = itemId(item);
    if (!byId.has(id)) byId.set(id, item);
  }
  const unique = [...byId.values()];
  return unique.filter(
    (x) => !unique.some((y) => y !== x && dominates(y.vv, x.vv)),
  );
}

export function mergeSets(
  a: readonly VersionedValue[],
  b: readonly VersionedValue[],
): VersionedValue[] {
  return normalizeSet([...a, ...b]);
}

export function sortedIds(set: readonly VersionedValue[]): string[] {
  return set.map(itemId).sort();
}

export type VisibleState =
  | { kind: "absent" }
  | { kind: "deleted" }
  | { kind: "value"; value: number }
  | { kind: "conflict"; values: number[] };

export function visibleState(set: readonly VersionedValue[]): VisibleState {
  const live = set.filter((item) => !item.tombstone);
  if (live.length === 0) {
    return set.length === 0 ? { kind: "absent" } : { kind: "deleted" };
  }
  if (live.length === 1) return { kind: "value", value: live[0].value as number };
  const values = live.map((item) => item.value as number).sort((x, y) => x - y);
  return { kind: "conflict", values };
}
