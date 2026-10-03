// Full front-to-back pipeline: source -> tokens -> AST -> typed model ->
// bytecode -> solver result.

import { parse } from './parser.js';
import { analyze } from './sema.js';
import { compileModel } from './compile.js';
import { solve } from './solve.js';

export function runPipeline(source, file = '<input>') {
  const program = parse(source, file);
  const model = analyze(program, file);
  const compiled = compileModel(model);
  const result = solve(model, compiled);
  return { program, model, compiled, result };
}
