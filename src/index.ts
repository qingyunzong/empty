export * from "./types.js";
export * from "./errors.js";
export {
  buildComposedTree,
  ComposedTreeVersion,
} from "./composed-tree.js";
export {
  createLocator,
  createRoleNameLocator,
  findAllByRoleAndName,
  locate,
  locateByRoleAndName,
  locateByRoleName,
  RoleNameLocator,
} from "./locator.js";
export {
  MockBrowserAdapter,
  MockTransaction,
  type MockBatchOperation,
  type MockNodeInput,
} from "./mock-adapter.js";
export {
  matchesQuery,
  normalizeQuery,
} from "./query.js";
