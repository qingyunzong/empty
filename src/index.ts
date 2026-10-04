import { Parser, type ParserEvent } from "./parser.js";
import { buildTree, type TreeResult } from "./tree.js";

export { Parser, decodeEntities } from "./parser.js";
export type {
  CloseEvent,
  Diagnostic,
  DiagnosticCode,
  DiagnosticEvent,
  EntityRef,
  OpenEvent,
  ParserEvent,
  TagName,
  TextEvent,
} from "./parser.js";
export { buildTree } from "./tree.js";
export type { ElementNode, RootNode, TextNode, TreeNode, TreeResult } from "./tree.js";

export interface ParseResult extends TreeResult {
  events: ParserEvent[];
}

/** Parses a complete input string in one shot. */
export function parse(input: string): ParseResult {
  const parser = new Parser();
  parser.feed(input);
  const events = parser.end();
  const { root, diagnostics } = buildTree(events);
  return { root, diagnostics, events };
}

/** Parses input delivered as a sequence of chunks. */
export function parseChunks(chunks: string[]): ParseResult {
  const parser = new Parser();
  for (const chunk of chunks) parser.feed(chunk);
  const events = parser.end();
  const { root, diagnostics } = buildTree(events);
  return { root, diagnostics, events };
}
