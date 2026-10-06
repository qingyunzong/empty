import { Heap } from "./heap";
import {
  SNAPSHOT_FORMAT,
  SerializedObject,
  SerializedValue,
  SnapshotDoc,
} from "./snapshot";
import { encodeBase64 } from "./base64";
import { SnapshotError } from "./errors";
import { Value } from "./values";

function encodeValue(value: Value): SerializedValue {
  switch (value.kind) {
    case "int":
      return { t: "int", v: value.value };
    case "bytes":
      return { t: "bytes", v: encodeBase64(value.value) };
    case "ref":
      return { t: "ref", id: value.id };
  }
}

/**
 * Serializes every object reachable from the given roots. Shared
 * references appear once (by stable id) and cycles terminate naturally,
 * because objects are emitted by id rather than by nesting.
 */
export function serialize(heap: Heap, roots: readonly number[]): SnapshotDoc {
  for (const id of roots) {
    if (!heap.hasObject(id)) {
      throw new SnapshotError(`cannot serialize: root #${id} is not in the heap`);
    }
  }

  const reachable = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.pop() as number;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const name of heap.fieldNames(id)) {
      const value = heap.getField(id, name);
      if (value !== undefined && value.kind === "ref" && !reachable.has(value.id)) {
        queue.push(value.id);
      }
    }
  }

  const objects: SerializedObject[] = [...reachable]
    .sort((a, b) => a - b)
    .map((id) => {
      const fields: Record<string, SerializedValue> = {};
      for (const name of heap.fieldNames(id).sort()) {
        fields[name] = encodeValue(heap.getField(id, name) as Value);
      }
      return { id, fields };
    });

  return {
    format: SNAPSHOT_FORMAT,
    nextId: heap.peekNextId,
    roots: [...roots],
    objects,
  };
}
