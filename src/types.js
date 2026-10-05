'use strict';

// Static type system: int | float | bool | evidence.

class StaticError extends Error {}

function isNumeric(t) {
  return t === 'int' || t === 'float';
}

function checkExpr(node, env) {
  switch (node.kind) {
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'bool':
      return 'bool';
    case 'evidence':
      return 'evidence';
    case 'obs': {
      const t = env.get(node.name);
      if (!t) throw new StaticError(`unknown observation field: ${node.name}`);
      return t;
    }
    case 'un': {
      const t = checkExpr(node.operand, env);
      if (node.op === '!') {
        if (t !== 'bool') throw new StaticError(`operator ! expects bool, got ${t}`);
        return 'bool';
      }
      if (node.op === '-') {
        if (!isNumeric(t)) throw new StaticError(`unary - expects numeric, got ${t}`);
        return t;
      }
      throw new StaticError(`unknown unary operator: ${node.op}`);
    }
    case 'bin': {
      const lt = checkExpr(node.left, env);
      const rt = checkExpr(node.right, env);
      const op = node.op;
      if (op === '+' || op === '-' || op === '*' || op === '/') {
        if (!isNumeric(lt) || !isNumeric(rt)) {
          throw new StaticError(`operator ${op} expects numeric operands, got ${lt} and ${rt}`);
        }
        return lt === 'float' || rt === 'float' ? 'float' : 'int';
      }
      if (op === '%') {
        if (lt !== 'int' || rt !== 'int') {
          throw new StaticError(`operator % expects int operands, got ${lt} and ${rt}`);
        }
        return 'int';
      }
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (!isNumeric(lt) || !isNumeric(rt)) {
          throw new StaticError(`operator ${op} expects numeric operands, got ${lt} and ${rt}`);
        }
        return 'bool';
      }
      if (op === '==' || op === '!=') {
        const ok = (isNumeric(lt) && isNumeric(rt)) || lt === rt;
        if (!ok) throw new StaticError(`operator ${op} cannot compare ${lt} with ${rt}`);
        return 'bool';
      }
      if (op === '&&' || op === '||') {
        if (lt !== 'bool' || rt !== 'bool') {
          throw new StaticError(`operator ${op} expects bool operands, got ${lt} and ${rt}`);
        }
        return 'bool';
      }
      throw new StaticError(`unknown binary operator: ${op}`);
    }
    default:
      throw new StaticError(`unknown expression kind: ${node.kind}`);
  }
}

function checkTxn(txn, env, seqs) {
  if (typeof txn.seq !== 'number' || !Number.isInteger(txn.seq)) {
    throw new StaticError('transaction missing integer seq');
  }
  if (seqs.has(txn.seq)) throw new StaticError(`duplicate transaction seq ${txn.seq}`);
  seqs.add(txn.seq);
  if (!Array.isArray(txn.body)) throw new StaticError(`transaction ${txn.seq} missing body`);
  for (const stmt of txn.body) {
    if (stmt.kind === 'assign') {
      const ft = env.get(stmt.name);
      if (!ft) throw new StaticError(`unknown observation field: ${stmt.name}`);
      const et = checkExpr(stmt.expr, env);
      const ok = et === ft || (ft === 'float' && et === 'int');
      if (!ok) {
        if (ft === 'evidence') {
          throw new StaticError(`evidence field ${stmt.name} can only bind evidence, got ${et}`);
        }
        throw new StaticError(`cannot bind ${et} to ${ft} field ${stmt.name}`);
      }
    } else if (stmt.kind === 'guard') {
      const t = checkExpr(stmt.expr, env);
      if (t !== 'bool') throw new StaticError(`guard must be bool, got ${t}`);
    } else {
      throw new StaticError(`unexpected statement in transaction ${txn.seq}: ${stmt.kind}`);
    }
  }
}

function checkBlock(block, env, seqs) {
  if (!Array.isArray(block.body)) {
    throw new StaticError(`block ${block.name || '<anonymous>'} missing body`);
  }
  for (const stmt of block.body) {
    if (stmt.kind === 'block') checkBlock(stmt, env, seqs);
    else if (stmt.kind === 'txn') checkTxn(stmt, env, seqs);
    else throw new StaticError(`unexpected statement in block: ${stmt.kind}`);
  }
}

function checkScript(script, env) {
  if (!script || script.kind !== 'block') {
    throw new StaticError('script root must be a block');
  }
  const seqs = new Set();
  checkBlock(script, env, seqs);
  return seqs;
}

function parseValue(v) {
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') return Number.isInteger(v) ? { t: 'int', v } : { t: 'float', v };
  if (typeof v === 'string') return { t: 'evidence', v };
  if (v && typeof v === 'object' && typeof v.$evidence === 'string') {
    return { t: 'evidence', v: v.$evidence };
  }
  throw new StaticError(`unsupported observation value: ${JSON.stringify(v)}`);
}

function parseObservations(json) {
  const types = new Map();
  const registers = new Map();
  for (const [k, v] of Object.entries(json)) {
    const tv = parseValue(v);
    types.set(k, tv.t);
    registers.set(k, tv);
  }
  return { types, registers };
}

// State file stores observations as { name: { t, v } }.
function parseStateObservations(json) {
  const types = new Map();
  const registers = new Map();
  for (const [k, tv] of Object.entries(json)) {
    types.set(k, tv.t);
    registers.set(k, { t: tv.t, v: tv.v });
  }
  return { types, registers };
}

function valueToJson(tv) {
  return tv.t === 'evidence' ? { $evidence: tv.v } : tv.v;
}

function observationsToJson(registers) {
  const out = {};
  for (const [k, tv] of registers) out[k] = valueToJson(tv);
  return out;
}

module.exports = {
  StaticError,
  isNumeric,
  checkExpr,
  checkScript,
  parseObservations,
  parseStateObservations,
  observationsToJson,
};
