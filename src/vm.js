import { Op } from './compiler.js';
import { applyFilter, typeOf } from './filters.js';
import { TemplateError, ErrorCode } from './errors.js';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function run(program, variables, options = {}) {
  const stack = [];
  const scopes = [variables];
  const chunks = [];
  const trace = options.collectTrace ? [] : null;

  for (let pc = 0; pc < program.length; pc++) {
    const ins = program[pc];
    switch (ins.op) {
      case Op.TEXT:
        chunks.push(ins.value);
        break;
      case Op.CONST:
        stack.push(ins.value);
        break;
      case Op.LOAD: {
        let found = false;
        let value;
        let level = -1;
        for (let depth = scopes.length - 1; depth >= 0; depth--) {
          const scope = scopes[depth];
          if (scope !== null && typeof scope === 'object' && hasOwn(scope, ins.name)) {
            value = scope[ins.name];
            level = depth;
            found = true;
            break;
          }
        }
        if (!found) {
          throw new TemplateError(ErrorCode.UNDEFINED_VARIABLE, `variable "${ins.name}" is not defined`);
        }
        if (trace) trace.push({ name: ins.name, level });
        stack.push(value);
        break;
      }
      case Op.FIELD: {
        const object = stack.pop();
        if (object === null || typeof object !== 'object' || !hasOwn(object, ins.name)) {
          throw new TemplateError(
            ErrorCode.MISSING_FIELD,
            `field "${ins.name}" is missing on value of type "${typeOf(object)}"`,
          );
        }
        stack.push(object[ins.name]);
        break;
      }
      case Op.ADD: {
        const [right, left] = pop2(stack);
        if (typeof left === 'number' && typeof right === 'number') stack.push(left + right);
        else if (typeof left === 'string' && typeof right === 'string') stack.push(left + right);
        else throw typeError('+', left, right);
        break;
      }
      case Op.SUB: {
        const [right, left] = pop2(stack);
        if (typeof left !== 'number' || typeof right !== 'number') throw typeError('-', left, right);
        stack.push(left - right);
        break;
      }
      case Op.MUL: {
        const [right, left] = pop2(stack);
        if (typeof left !== 'number' || typeof right !== 'number') throw typeError('*', left, right);
        stack.push(left * right);
        break;
      }
      case Op.DIV: {
        const [right, left] = pop2(stack);
        if (typeof left !== 'number' || typeof right !== 'number') throw typeError('/', left, right);
        stack.push(left / right);
        break;
      }
      case Op.MOD: {
        const [right, left] = pop2(stack);
        if (typeof left !== 'number' || typeof right !== 'number') throw typeError('%', left, right);
        stack.push(left % right);
        break;
      }
      case Op.NEG: {
        const value = stack.pop();
        if (typeof value !== 'number') {
          throw new TemplateError(ErrorCode.TYPE_ERROR, `unary "-" requires a number, got "${typeOf(value)}"`);
        }
        stack.push(-value);
        break;
      }
      case Op.FILTER: {
        const args = stack.splice(stack.length - ins.argc, ins.argc);
        const input = stack.pop();
        stack.push(applyFilter(ins.name, input, args));
        break;
      }
      case Op.EMIT:
        chunks.push(emitString(stack.pop()));
        break;
      case Op.PUSH_SCOPE: {
        const value = stack.pop();
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new TemplateError(
            ErrorCode.TYPE_ERROR,
            `{% scope %} requires an object, got "${typeOf(value)}"`,
          );
        }
        scopes.push(value);
        break;
      }
      case Op.POP_SCOPE:
        scopes.pop();
        break;
      default:
        throw new Error(`unknown opcode "${ins.op}"`);
    }
  }
  return { output: chunks.join(''), trace };
}

function pop2(stack) {
  const right = stack.pop();
  const left = stack.pop();
  return [right, left];
}

function typeError(op, left, right) {
  return new TemplateError(
    ErrorCode.TYPE_ERROR,
    `operator "${op}" does not support "${typeOf(left)}" and "${typeOf(right)}"`,
  );
}

function emitString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TemplateError(ErrorCode.TYPE_ERROR, 'cannot render a non-finite number');
    }
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  throw new TemplateError(ErrorCode.TYPE_ERROR, `cannot render value of type "${typeOf(value)}"`);
}
