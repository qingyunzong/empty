import { parse } from './parser.js';
import { compile } from './compiler.js';
import { run } from './vm.js';
import { normalizedHash } from './hash.js';

export function compileTemplate(source) {
  return compile(parse(source));
}

export function materialize(template, variables, options = {}) {
  const program = compileTemplate(template);
  const { output, trace } = run(program, variables, { collectTrace: options.collectTrace ?? true });
  return {
    output,
    trace,
    hash: normalizedHash({ template, variables, output }),
  };
}
