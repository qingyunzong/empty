// Minimal ambient declarations so the project compiles without @types/node.
// Only Node.js built-in modules are used at runtime.
declare module "node:test";
declare module "node:assert/strict";

declare const console: {
  log(...args: unknown[]): void;
};
