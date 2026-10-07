export { BadReferenceError, SnapshotError, ValidationError } from "./errors.js";
export { Heap, type HeapObject } from "./heap.js";
export {
  deserialize,
  deserializeFromString,
  FORMAT,
  serialize,
  serializeToString,
  type EncodedValue,
  type SnapshotDoc,
  type SnapshotObject,
} from "./snapshot.js";
export { areIsomorphic, assertIsomorphic, verifyRoundTrip } from "./isomorph.js";
export { bytesValue, intValue, refValue, valueEquals, type Value } from "./values.js";
export { VM } from "./vm.js";
