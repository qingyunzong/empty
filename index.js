// Compatibility shim for callers that import the package root directly.
// The TypeScript source of truth lives in index.ts; run `npm run build`.
export * from "./dist/index.js";
export { default } from "./dist/index.js";
