// Offline ambient shims: the sandbox has no @types/node, so node:* builtins
// are typed loosely here. Runtime behavior is unaffected.
declare module "node:*";

interface Buffer extends Uint8Array {}
declare var Buffer: {
  from(data: string | ArrayLike<number>, encoding?: string): Buffer;
  alloc(size: number): Buffer;
  concat(list: Buffer[]): Buffer;
};
