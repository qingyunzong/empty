'use strict';

const { QueryBudgetError, QueryRuntimeError } = require('./errors');

function coerceRecordValue(field, raw, schema) {
  if (raw === null || raw === undefined) return null;
  const type = schema.fields[field].type;
  switch (type) {
    case 'string':
      if (typeof raw !== 'string') {
        throw new QueryRuntimeError(`record field '${field}' expected string, got ${typeof raw}`);
      }
      return raw;
    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        throw new QueryRuntimeError(`record field '${field}' expected number, got ${JSON.stringify(raw)}`);
      }
      return num;
    }
    case 'date': {
      const time = Date.parse(raw);
      if (Number.isNaN(time)) {
        throw new QueryRuntimeError(`record field '${field}' expected date, got ${JSON.stringify(raw)}`);
      }
      return time;
    }
    case 'boolean':
      if (typeof raw !== 'boolean') {
        throw new QueryRuntimeError(`record field '${field}' expected boolean, got ${typeof raw}`);
      }
      return raw;
    default:
      throw new QueryRuntimeError(`unknown schema type '${type}' for field '${field}'`);
  }
}

function execute(bytecode, records, schema, budget) {
  const hits = [];
  let instructions = 0;
  for (const record of records) {
    const stack = [];
    for (const instr of bytecode) {
      instructions += 1;
      if (instructions > budget) {
        throw new QueryBudgetError(
          `instruction budget exceeded: ${instructions - 1} executed, budget is ${budget}`
        );
      }
      switch (instr.op) {
        case 'LOAD_FIELD':
          stack.push(coerceRecordValue(instr.field, record[instr.field], schema));
          break;
        case 'PUSH_CONST':
          stack.push(instr.value);
          break;
        case 'CONTAINS_CI': {
          const needle = stack.pop();
          const haystack = stack.pop();
          stack.push(haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase()));
          break;
        }
        case 'REGEX_TEST': {
          const regex = stack.pop();
          const value = stack.pop();
          stack.push(value !== null && regex.test(value));
          break;
        }
        case 'EQ': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(a !== null && a === b);
          break;
        }
        case 'NE': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(a !== null && a !== b);
          break;
        }
        case 'LT': case 'LE': case 'GT': case 'GE': {
          const b = stack.pop();
          const a = stack.pop();
          if (a === null) { stack.push(false); break; }
          if (instr.op === 'LT') stack.push(a < b);
          else if (instr.op === 'LE') stack.push(a <= b);
          else if (instr.op === 'GT') stack.push(a > b);
          else stack.push(a >= b);
          break;
        }
        case 'AND': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(Boolean(a && b));
          break;
        }
        case 'OR': {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(Boolean(a || b));
          break;
        }
        case 'OR_N': {
          let result = false;
          for (let k = 0; k < instr.count; k += 1) {
            result = stack.pop() || result;
          }
          stack.push(result);
          break;
        }
        case 'NOT':
          stack.push(!stack.pop());
          break;
        default:
          throw new QueryRuntimeError(`unknown opcode '${instr.op}'`);
      }
    }
    if (stack.length !== 1) {
      throw new QueryRuntimeError(`bytecode left ${stack.length} values on the stack`);
    }
    if (stack.pop()) hits.push(record.id);
  }
  return { hits, instructions };
}

module.exports = { execute };
