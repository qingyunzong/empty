import { QuotaError } from './errors.js';

// 三种额度类型静态分离: limit / frozen / available, 禁止把冻结额当可用额
const QUOTA = new Set(['limit', 'frozen', 'available']);

class Ctx {
  constructor(parent, name) {
    this.parent = parent;
    this.name = name;
    this.vars = new Map(); // name -> { type, mutable, constValue }
    this.caps = new Map(); // bucket -> cap value
    this.childScopes = new Set();
  }
  lookup(name) {
    for (let c = this; c; c = c.parent) {
      if (c.vars.has(name)) return { entry: c.vars.get(name), owner: c };
    }
    return null;
  }
}

const at = (node) => (node && node.line ? ` (line ${node.line})` : '');

function typeOf(node, ctx, buckets) {
  const fail = (msg) => {
    throw new QuotaError('E_TYPE', `${msg}${at(node)}`);
  };
  let t;
  switch (node.k) {
    case 'num':
      t = 'number';
      break;
    case 'str':
      t = 'string';
      break;
    case 'date':
      t = 'date';
      break;
    case 'bool':
      t = 'bool';
      break;
    case 'regex':
      t = 'regex';
      break;
    case 'amount':
      t = 'available';
      break;
    case 'note':
      t = 'string';
      break;
    case 'var': {
      const found = ctx.lookup(node.name);
      if (!found) {
        throw new QuotaError('E_VALID', `unknown identifier '${node.name}'${at(node)}`);
      }
      t = found.entry.type;
      break;
    }
    case 'builtin': {
      if (!buckets.has(node.bucket)) {
        throw new QuotaError('E_VALID', `unknown bucket '${node.bucket}'${at(node)}`);
      }
      t = node.fn; // 'limit' | 'frozen' | 'available'
      break;
    }
    case 'un': {
      const e = typeOf(node.e, ctx, buckets);
      if (node.op === 'not') {
        if (e !== 'bool') fail(`'not' expects bool, got ${e}`);
        t = 'bool';
      } else {
        if (e !== 'number' && !QUOTA.has(e)) fail(`unary '-' expects number/quota, got ${e}`);
        t = e;
      }
      break;
    }
    case 'bin': {
      const l = typeOf(node.l, ctx, buckets);
      const r = typeOf(node.r, ctx, buckets);
      const op = node.op;
      if (op === 'and' || op === 'or') {
        if (l !== 'bool' || r !== 'bool') fail(`'${op}' expects bool operands, got ${l} and ${r}`);
        t = 'bool';
      } else if (op === 'matches') {
        if (l !== 'string' || r !== 'regex') fail(`'matches' expects string and regex, got ${l} and ${r}`);
        t = 'bool';
      } else if (op === '+' || op === '-' || op === '*' || op === '/') {
        if (l === 'number' && r === 'number') t = 'number';
        else if (QUOTA.has(l) && r === 'number') t = l;
        else if (l === 'number' && QUOTA.has(r)) t = r;
        else if (l === r && QUOTA.has(l)) t = l;
        else fail(`cannot apply '${op}' to ${l} and ${r} (quota types limit/frozen/available must not be mixed)`);
      } else if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (l === 'number' && r === 'number') t = 'bool';
        else if (l === 'date' && r === 'date') t = 'bool';
        else if (QUOTA.has(l) && (r === 'number' || r === l)) t = 'bool';
        else if (QUOTA.has(r) && l === 'number') t = 'bool';
        else fail(`cannot compare ${l} with ${r} (frozen is not available)`);
      } else {
        // == / !=
        if (l === r) t = 'bool';
        else if (QUOTA.has(l) && r === 'number') t = 'bool';
        else if (QUOTA.has(r) && l === 'number') t = 'bool';
        else fail(`cannot compare ${l} with ${r}`);
      }
      break;
    }
    default:
      fail(`cannot type expression kind '${node.k}'`);
  }
  node.type = t;
  return t;
}

function constEval(node, ctx, buckets) {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'var': {
      const found = ctx.lookup(node.name);
      if (found && found.entry.constValue !== undefined) return found.entry.constValue;
      break;
    }
    case 'builtin':
      if (node.fn === 'limit' && buckets.has(node.bucket)) return buckets.get(node.bucket).limit;
      break;
    case 'un':
      if (node.op === '-') return -constEval(node.e, ctx, buckets);
      break;
    case 'bin':
      if (['+', '-', '*', '/'].includes(node.op)) {
        const a = constEval(node.l, ctx, buckets);
        const b = constEval(node.r, ctx, buckets);
        if (node.op === '+') return a + b;
        if (node.op === '-') return a - b;
        if (node.op === '*') return a * b;
        return a / b;
      }
  }
  throw new QuotaError('E_TYPE', `expression is not statically evaluable${at(node)}`);
}

export function check(ast) {
  const buckets = new Map(); // name -> { limit }
  const root = new Ctx(null, '<root>');
  let seenCustomer = false;
  let seenWhitelist = false;
  let seenValidity = false;

  function checkStmt(stmt, ctx, topLevel) {
    switch (stmt.k) {
      case 'customer': {
        if (!topLevel) throw new QuotaError('E_VALID', `customer is only allowed at top level${at(stmt)}`);
        if (seenCustomer) throw new QuotaError('E_VALID', `duplicate customer declaration${at(stmt)}`);
        seenCustomer = true;
        return;
      }
      case 'note_whitelist': {
        if (!topLevel) throw new QuotaError('E_VALID', `note_whitelist is only allowed at top level${at(stmt)}`);
        if (seenWhitelist) throw new QuotaError('E_VALID', `duplicate note_whitelist${at(stmt)}`);
        try {
          new RegExp(stmt.source, stmt.flags);
        } catch (e) {
          throw new QuotaError('E_VALID', `bad note whitelist regex: ${e.message}${at(stmt)}`);
        }
        seenWhitelist = true;
        return;
      }
      case 'validity': {
        if (!topLevel) throw new QuotaError('E_VALID', `validity is only allowed at top level${at(stmt)}`);
        if (seenValidity) throw new QuotaError('E_VALID', `duplicate validity${at(stmt)}`);
        if (stmt.from > stmt.to) throw new QuotaError('E_VALID', `validity window is empty${at(stmt)}`);
        seenValidity = true;
        return;
      }
      case 'bucket': {
        if (!topLevel) throw new QuotaError('E_VALID', `bucket is only allowed at top level${at(stmt)}`);
        if (buckets.has(stmt.name)) throw new QuotaError('E_VALID', `duplicate bucket '${stmt.name}'${at(stmt)}`);
        const t = typeOf(stmt.limit, ctx, buckets);
        if (t !== 'number') throw new QuotaError('E_TYPE', `bucket limit must be a number, got ${t}${at(stmt)}`);
        const v = constEval(stmt.limit, ctx, buckets);
        if (!Number.isSafeInteger(v) || v < 0) {
          throw new QuotaError('E_CAP', `bucket limit must be a non-negative integer, got ${v}${at(stmt)}`);
        }
        stmt.limitValue = v;
        buckets.set(stmt.name, { limit: v });
        return;
      }
      case 'scope': {
        if (ctx.childScopes.has(stmt.name)) {
          throw new QuotaError('E_VALID', `duplicate scope '${stmt.name}' in '${ctx.name}'${at(stmt)}`);
        }
        ctx.childScopes.add(stmt.name);
        const child = new Ctx(ctx, stmt.name);
        for (const s of stmt.body) checkStmt(s, child, false);
        return;
      }
      case 'cap': {
        if (!buckets.has(stmt.bucket)) {
          throw new QuotaError('E_VALID', `unknown bucket '${stmt.bucket}'${at(stmt)}`);
        }
        const t = typeOf(stmt.value, ctx, buckets);
        if (t !== 'number' && t !== 'limit') {
          throw new QuotaError('E_TYPE', `cap must be limit-typed or a number, got ${t}${at(stmt)}`);
        }
        const v = constEval(stmt.value, ctx, buckets);
        if (!Number.isSafeInteger(v) || v < 0) {
          throw new QuotaError('E_CAP', `cap must be a non-negative integer, got ${v}${at(stmt)}`);
        }
        // 内层不得放大外层上限: 有效外层上限 = 最近祖先 cap, 否则桶 limit
        let outer = buckets.get(stmt.bucket).limit;
        for (let c = ctx.parent; c; c = c.parent) {
          if (c.caps.has(stmt.bucket)) {
            outer = c.caps.get(stmt.bucket);
            break;
          }
        }
        if (v > outer) {
          throw new QuotaError(
            'E_SCOPE',
            `cap ${v} for '${stmt.bucket}' in scope '${ctx.name}' exceeds outer limit ${outer}${at(stmt)}`,
          );
        }
        if (ctx.caps.has(stmt.bucket)) {
          throw new QuotaError('E_VALID', `duplicate cap for '${stmt.bucket}' in scope '${ctx.name}'${at(stmt)}`);
        }
        ctx.caps.set(stmt.bucket, v);
        stmt.capValue = v;
        return;
      }
      case 'decl': {
        if (ctx.vars.has(stmt.name)) {
          throw new QuotaError('E_VALID', `duplicate variable '${stmt.name}' in this scope${at(stmt)}`);
        }
        const t = typeOf(stmt.expr, ctx, buckets);
        let constValue;
        try {
          constValue = constEval(stmt.expr, ctx, buckets);
        } catch {
          constValue = undefined;
        }
        // 内层同名 let/var 是合法 shadowing (只读覆盖外层绑定)
        ctx.vars.set(stmt.name, { type: t, mutable: stmt.mutable, constValue });
        return;
      }
      case 'set': {
        const found = ctx.lookup(stmt.name);
        if (!found) throw new QuotaError('E_VALID', `unknown variable '${stmt.name}'${at(stmt)}`);
        if (found.owner !== ctx) {
          throw new QuotaError(
            'E_SCOPE',
            `cannot assign to outer-scope variable '${stmt.name}': shadowing is read-only${at(stmt)}`,
          );
        }
        if (!found.entry.mutable) {
          throw new QuotaError('E_SCOPE', `cannot assign to read-only 'let' variable '${stmt.name}'${at(stmt)}`);
        }
        const t = typeOf(stmt.expr, ctx, buckets);
        if (t !== found.entry.type) {
          throw new QuotaError('E_TYPE', `cannot assign ${t} to variable of type ${found.entry.type}${at(stmt)}`);
        }
        return;
      }
      case 'guard': {
        for (const c of stmt.clauses) {
          const t = typeOf(c.expr, ctx, buckets);
          if (t !== 'bool') {
            throw new QuotaError('E_TYPE', `guard clause must be bool, got ${t}${at(stmt)}`);
          }
        }
        return;
      }
      default:
        throw new QuotaError('E_VALID', `unknown statement kind '${stmt.k}'`);
    }
  }

  for (const s of ast.body) checkStmt(s, root, true);
  return { buckets };
}
