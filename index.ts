/**
 * SQL Server CDC update-mask interpretation and before/after pairing.
 *
 * The package is dependency-free and can be imported directly from TypeScript
 * with Node's type stripping, or compiled by any standard TypeScript build.
 */

export * from "./src/binary.ts";
export * from "./src/schema.ts";
export * from "./src/update-mask.ts";
export * from "./src/types.ts";
export * from "./src/merger.ts";

import * as binary from "./src/binary.ts";
import * as merger from "./src/merger.ts";
import * as schema from "./src/schema.ts";
import * as updateMask from "./src/update-mask.ts";
import * as types from "./src/types.ts";

const cdcUpdateMask = {
  ...binary,
  ...schema,
  ...updateMask,
  ...types,
  ...merger,
};

export default cdcUpdateMask;
