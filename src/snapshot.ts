export const SNAPSHOT_FORMAT = "vm-snapshot/1";

export type SerializedValue =
  | { readonly t: "int"; readonly v: number }
  | { readonly t: "bytes"; readonly v: string }
  | { readonly t: "ref"; readonly id: number };

export interface SerializedObject {
  readonly id: number;
  readonly fields: Record<string, SerializedValue>;
}

export interface SnapshotDoc {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly nextId: number;
  readonly roots: readonly number[];
  readonly objects: readonly SerializedObject[];
}
