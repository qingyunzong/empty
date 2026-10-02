import { lex } from './lexer.js';
import { parse } from './parser.js';
import { compile, causalEdges } from './compiler.js';
import { run } from './vm.js';

export { lex, parse, compile, causalEdges, run };
export { LexError } from './lexer.js';
export { ParseError } from './parser.js';

// Full pipeline: source text -> adjudicated result.
export function adjudicate(source) {
  const tokens = lex(source);
  const { events, notes } = parse(tokens);
  const compiled = compile(events);
  const replay = run(compiled.bytecode);
  return {
    state: replay.state,
    conflict: replay.conflict,
    applied: replay.applied,
    order: compiled.order,
    edges: compiled.edges,
    notes,
    eventCount: events.length,
  };
}
