import vm from 'node:vm';
import { TemplateError } from './errors.js';

const typeName = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function requireType(v, type, fname) {
  if (typeof v !== type) {
    throw new TemplateError(`filter '${fname}' does not support type ${typeName(v)}`, 'render');
  }
}

export const FILTERS = Object.freeze({
  upper: (v) => (requireType(v, 'string', 'upper'), v.toUpperCase()),
  lower: (v) => (requireType(v, 'string', 'lower'), v.toLowerCase()),
  trim: (v) => (requireType(v, 'string', 'trim'), v.trim()),
  length: (v) => {
    if (typeof v !== 'string' && !Array.isArray(v)) {
      throw new TemplateError(`filter 'length' does not support type ${typeName(v)}`, 'render');
    }
    return v.length;
  },
  abs: (v) => (requireType(v, 'number', 'abs'), Math.abs(v)),
  json: (v) => JSON.stringify(v),
});

function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Executes bytecode in an isolated vm context ("sandbox"): the scope chain
// and filter table live inside the context, and template expressions can
// only ever run the fixed bytecode ops — no eval of host code.
//
// Rendering proceeds block by block: text/interp/scope segments at depth 0
// are committed to the output as they complete. Any TemplateError aborts the
// whole materialization and both the pending and committed buffers are
// discarded — no partial output ever escapes.
export function render(ops, variables, { trace } = {}) {
  const sandbox = vm.createContext(Object.assign(Object.create(null), { filters: FILTERS }));
  const frames = [variables];
  const stack = [];
  let depth = 0;
  let pending = '';
  let committed = '';
  const commit = () => {
    committed += pending;
    pending = '';
  };

  for (let pc = 0; pc < ops.length; pc++) {
    const op = ops[pc];
    switch (op.op) {
      case 'text':
        pending += op.value;
        if (depth === 0) commit();
        break;
      case 'emit':
        pending += stringify(stack.pop());
        if (depth === 0) commit();
        break;
      case 'const':
        stack.push(op.value);
        break;
      case 'load': {
        let found = false;
        for (let f = frames.length - 1; f >= 0; f--) {
          const frame = frames[f];
          if (frame !== null && typeof frame === 'object' && Object.hasOwn(frame, op.name)) {
            if (trace) trace.push({ name: op.name, resolvedAt: f });
            stack.push(frame[op.name]);
            found = true;
            break;
          }
        }
        if (!found) throw new TemplateError(`undefined variable '${op.name}'`, 'render');
        break;
      }
      case 'field': {
        const obj = stack.pop();
        if (obj === null || typeof obj !== 'object' || !Object.hasOwn(obj, op.name)) {
          throw new TemplateError(`missing field '${op.name}'`, 'render');
        }
        stack.push(obj[op.name]);
        break;
      }
      case 'neg': {
        const v = stack.pop();
        if (typeof v !== 'number') {
          throw new TemplateError(`unary '-' does not support type ${typeName(v)}`, 'render');
        }
        stack.push(-v);
        break;
      }
      case 'arith': {
        const b = stack.pop();
        const a = stack.pop();
        if (op.operator === '+' && typeof a === 'string' && typeof b === 'string') {
          stack.push(a + b);
          break;
        }
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new TemplateError(
            `operator '${op.operator}' does not support types ${typeName(a)} and ${typeName(b)}`,
            'render',
          );
        }
        switch (op.operator) {
          case '+': stack.push(a + b); break;
          case '-': stack.push(a - b); break;
          case '*': stack.push(a * b); break;
          case '/': stack.push(a / b); break;
          case '%': stack.push(a % b); break;
          default: throw new Error(`unknown operator ${op.operator}`);
        }
        break;
      }
      case 'filter': {
        const fn = sandbox.filters[op.name];
        if (!fn) throw new TemplateError(`unknown filter '${op.name}'`, 'render');
        const args = op.argc > 0 ? stack.splice(-op.argc, op.argc) : [];
        stack.push(fn(stack.pop(), ...args));
        break;
      }
      case 'enter_scope': {
        const value = stack.pop();
        frames.push({ [op.name]: value });
        depth++;
        break;
      }
      case 'exit_scope':
        frames.pop();
        depth--;
        if (depth === 0) commit();
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }
  commit();
  return { output: committed, trace };
}
