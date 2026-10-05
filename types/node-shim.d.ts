// Minimal offline stand-ins for @types/node (registry unreachable in this
// environment). Only what the tests import is declared, as `any`.
declare module "node:test";
declare module "node:assert/strict";
