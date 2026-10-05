export { Parser, parse } from './parser.js';
export { Tokenizer, decodeEntity } from './tokenizer.js';
export { TreeBuilder, SUPPORTED_TAGS, VOID_TAGS } from './tree.js';
export type {
  Diagnostic,
  DiagnosticCode,
  ElementNode,
  Node,
  ParseResult,
  ParserEvent,
  RootNode,
  Segment,
  TextNode,
} from './types.js';
