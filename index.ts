export { extractGeneratedText, extractText, generateCounterText } from "./src/extract.js";
export { extractGeneratedText as default } from "./src/extract.js";
export { formatCounterValue } from "./src/format.js";
export {
  ExtractionError,
  type ContentPhase,
  type ContentToken,
  type ContentTokenKind,
  type CounterAssignment,
  type CounterRead,
  type CounterReset,
  type CounterStyle,
  type CountersToken,
  type CounterToken,
  type ExtractionErrorCode,
  type ExtractionInput,
  type ExtractionResult,
  type ExtractionSegment,
  type InitialCounterDeclaration,
  type InitialCounters,
  type IntegerInput,
  type LiteralToken,
  type ParsedNode,
  type StyleInstructions,
} from "./src/types.js";
