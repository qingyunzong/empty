import { parseTemplate } from './parser.js';
import { evaluate, type RenderOptions } from './evaluator.js';
import { TemplateError } from './errors.js';

export { parseTemplate } from './parser.js';
export { evaluate, DEFAULT_MAX_STEPS, type RenderOptions } from './evaluator.js';
export { builtinFilters, type FilterFn } from './filters.js';
export { TemplateError, SourceMap, type SourcePosition, type TemplateErrorCode } from './errors.js';

/**
 * Renders a template against `data`. Either returns the complete output
 * string or throws a {@link TemplateError}; partial output is never produced.
 */
export function render(template: string, data: unknown, options: RenderOptions = {}): string {
  return evaluate(parseTemplate(template), data, options);
}

export type RenderResult = { readonly ok: true; readonly output: string } | { readonly ok: false; readonly error: TemplateError };

/** Non-throwing variant of {@link render}. Failed results carry no output. */
export function tryRender(template: string, data: unknown, options: RenderOptions = {}): RenderResult {
  try {
    return { ok: true, output: render(template, data, options) };
  } catch (error) {
    if (error instanceof TemplateError) return { ok: false, error };
    throw error;
  }
}
