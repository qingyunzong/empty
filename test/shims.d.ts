declare const process: any;

declare module "node:test" {
  const test: any;
  export default test;
  export { test };
  export const describe: any;
  export const it: any;
}

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}
