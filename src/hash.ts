/**
 * Pluggable hash adapter. Ring building feeds vnode inputs ("<nodeId>#<replica>")
 * through this adapter; cursors feed keys through it. Implementations may be
 * synchronous or asynchronous and may observe the AbortSignal to cancel an
 * in-flight computation.
 */
export interface HashAdapter {
  hash(input: string, signal?: AbortSignal): number | Promise<number>;
}

/** Default synchronous FNV-1a (32-bit) adapter. */
export class Fnv1aAdapter implements HashAdapter {
  hash(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}
