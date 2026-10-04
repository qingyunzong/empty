export { Fraction } from "./fraction.js";
export {
  allocate,
  FairAllocator,
  formatReport,
} from "./allocator.js";
export type {
  UserSpec,
  AllocationResult,
  RoundRecord,
  UserRoundEvidence,
  RemainderAssignment,
} from "./allocator.js";
export { allocateByUnit } from "./unitModel.js";
