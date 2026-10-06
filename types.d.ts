declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}
declare module "node:assert" {
  const assert: any;
  export default assert;
}
declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}
