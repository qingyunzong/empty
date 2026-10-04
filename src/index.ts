export { lex, IdAlloc, LexError } from './lexer.js';
export type { Token, TokenKind } from './lexer.js';
export {
  parseAmount,
  parseSegmentTokens,
  splitSegments,
  buildDigits,
  minNonzeroPlace,
  ParseError,
  MAX_CENTS,
  MAX_SEGMENT_VALUE,
} from './parser.js';
export type { DigitInfo, ParseResult, ParseSuccess, ParseFailure, SegmentRole, SegmentGroup, SegmentValue } from './parser.js';
export { formatCents } from './format.js';
export { AmountDocument } from './editor.js';
export type { Version, TokenRef, EditResult, CreateResult } from './editor.js';
