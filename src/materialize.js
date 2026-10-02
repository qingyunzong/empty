import { parseTemplate } from './parser.js';
import { compileTemplate } from './compiler.js';
import { render } from './vm.js';

export function compile(source) {
  return compileTemplate(parseTemplate(source));
}

// Compile + render. Throws TemplateError on any failure (unclosed block,
// undefined variable, missing field, unsupported filter type); on failure
// no partial output is produced and the caller's version state is untouched.
export function materialize(source, variables, opts) {
  const ops = compile(source);
  return render(ops, variables, opts);
}
