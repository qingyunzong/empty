import { TemplateError } from '../src/index.js';

export function expectTemplateError(fn: () => unknown, code: TemplateError['code']): TemplateError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TemplateError) {
      if (error.code !== code) {
        throw new Error(`expected error code ${code} but got ${error.code}: ${error.message}`);
      }
      return error;
    }
    throw error;
  }
  throw new Error(`expected a TemplateError(${code}) but nothing was thrown`);
}
