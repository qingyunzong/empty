export interface HashAdapter {
  hash(input: string): number;
}

export interface AsyncHashAdapter {
  hash(input: string, signal: AbortSignal): Promise<number>;
}

export class Fnv1aAdapter implements HashAdapter {
  hash(input: string): number {
    return fnv1a(input);
  }
}

export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class SyncAsyncHashAdapter implements AsyncHashAdapter {
  constructor(private readonly inner: HashAdapter) {}

  hash(input: string): Promise<number> {
    return Promise.resolve(this.inner.hash(input));
  }
}
