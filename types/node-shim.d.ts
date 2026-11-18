declare module "node:test" {
  export const test: any;
  export const describe: any;
  export const it: any;
  export const before: any;
  export const after: any;
  export const beforeEach: any;
  export const afterEach: any;
  const defaultTest: any;
  export default defaultTest;
}

declare module "node:assert/strict" {
  export const ok: any;
  export const equal: any;
  export const deepEqual: any;
  export const throws: any;
  export const rejects: any;
  const assert: any;
  export default assert;
}

declare module "node:assert" {
  const assert: any;
  export default assert;
}

declare module "node:fs" {
  const fs: any;
  export default fs;
}

declare module "node:fs/promises" {
  const fs: any;
  export default fs;
}

declare module "node:path" {
  const path: any;
  export default path;
}

declare module "node:os" {
  const os: any;
  export default os;
}

declare module "node:util" {
  export const inspect: any;
  const util: any;
  export default util;
}

declare const console: any;
declare const process: any;
declare const Buffer: any;
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;
