'use strict';

const { BudgetExceededError } = require('./errors');

function fieldAsNumber(raw, type) {
  if (type === 'date') {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      return Number.isNaN(ms) ? null : ms;
    }
    return null;
  }
  if (type === 'number') {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  return null;
}

function applyCmp(cmp, left, right) {
  switch (cmp) {
    case '=': return left === right;
    case '!=': return left !== right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: throw new Error(`Unknown comparator '${cmp}'`);
  }
}

// Executes a compiled program against every record. Each executed
// instruction costs 1 unit; exceeding `budget` throws
// BudgetExceededError before any result is returned, so callers never
// observe partial hits.
function execute(program, records, schema, budget) {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`Budget must be a non-negative integer, got ${budget}`);
  }
  const stringFields = Object.entries(schema.fields)
    .filter(([, type]) => type === 'string')
    .map(([name]) => name);

  const prepared = program.map((ins) => {
    if (ins.op === 'regex' || ins.op === 'field_regex') {
      return { ...ins, re: new RegExp(ins.source, ins.flags) };
    }
    return ins;
  });

  let count = 0;
  const hits = [];

  for (const record of records) {
    const stack = [];
    for (const ins of prepared) {
      if (count >= budget) {
        throw new BudgetExceededError(
          `Instruction budget ${budget} exceeded (needed more than ${count})`
        );
      }
      count += 1;
      switch (ins.op) {
        case 'text': {
          const needle = ins.value.toLowerCase();
          stack.push(stringFields.some(
            (f) => typeof record[f] === 'string' && record[f].toLowerCase().includes(needle)
          ));
          break;
        }
        case 'regex':
          stack.push(stringFields.some(
            (f) => typeof record[f] === 'string' && ins.re.test(record[f])
          ));
          break;
        case 'field_text': {
          const v = record[ins.field];
          stack.push(typeof v === 'string' && v.toLowerCase().includes(ins.value.toLowerCase()));
          break;
        }
        case 'field_regex': {
          const v = record[ins.field];
          stack.push(typeof v === 'string' && ins.re.test(v));
          break;
        }
        case 'field_eq': {
          const type = schema.fields[ins.field];
          if (type === 'date' || type === 'number') {
            const num = fieldAsNumber(record[ins.field], type);
            stack.push(num !== null && num === ins.value);
          } else {
            stack.push(record[ins.field] === ins.value);
          }
          break;
        }
        case 'field_strcmp': {
          const v = record[ins.field];
          stack.push(typeof v === 'string' && applyCmp(ins.cmp, v, ins.value));
          break;
        }
        case 'cmp': {
          const type = schema.fields[ins.field];
          const num = fieldAsNumber(record[ins.field], type);
          stack.push(num !== null && applyCmp(ins.cmp, num, ins.value));
          break;
        }
        case 'not':
          stack.push(!stack.pop());
          break;
        case 'and': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(Boolean(a && b));
          break;
        }
        case 'or': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(Boolean(a || b));
          break;
        }
        default:
          throw new Error(`Unknown opcode '${ins.op}'`);
      }
    }
    if (stack.length !== 1) {
      throw new Error('Corrupt program: stack did not reduce to a single value');
    }
    if (stack[0]) {
      hits.push(record.id);
    }
  }

  return { hits, instructions: count };
}

module.exports = { execute };
