// Minimal ambient declarations so the project compiles without @types/node
// (the sandbox has no network access to install it).
declare module 'node:test' {
  export const test: any;
  export const describe: any;
  export const it: any;
  const defaultExport: any;
  export default defaultExport;
}
declare module 'node:assert' {
  const assert: any;
  export default assert;
}
declare module 'node:assert/strict' {
  const assert: any;
  export default assert;
}
declare module 'node:fs' {
  export const readFileSync: any;
}
declare const console: any;
declare const process: any;
