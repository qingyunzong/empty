import { QError } from './errors.js';

// Quantity kinds kept distinct by the static type system. `pure` is an
// untyped number literal/constant which unifies with any numeric kind.
const NUM_KINDS = new Set(['pure', 'limit', 'frozen', 'available', 'used']);

export function check(prog) {
  const bucketNames = new Set();
  for (const b of prog.buckets) {
    if (bucketNames.has(b.name)) throw new QError('E_TYPE', `duplicate bucket '${b.name}'`);
    bucketNames.add(b.name);
    if (!Number.isSafeInteger(b.limit) || b.limit <= 0)
      throw new QError('E_TYPE', `bucket '${b.name}' limit must be a positive integer`);
    if (b.validFrom && b.validTo && b.validFrom > b.validTo)
      throw new QError('E_TYPE', `bucket '${b.name}' validity window is inverted`);
  }
  if (prog.note) {
    try { new RegExp(prog.note); } catch { throw new QError('E_TYPE', `invalid note whitelist regex /${prog.note}/`); }
  }
  const scopeNames = new Set();
  for (const ap of prog.approvals) checkScope(ap, {}, {}, bucketNames, scopeNames, []);
  return prog;
}

function checkScope(node, parentCaps, parentLets, bucketNames, scopeNames, path) {
  if (scopeNames.has(node.name)) throw new QError('E_SCOPE', `duplicate approval scope '${node.name}'`);
  scopeNames.add(node.name);
  const here = path.concat(node.name).join('/');
  const caps = { ...parentCaps };
  for (const c of node.caps) {
    if (!bucketNames.has(c.bucket))
      throw new QError('E_TYPE', `cap references unknown bucket '${c.bucket}' in scope '${here}'`);
    if (!Number.isSafeInteger(c.amount) || c.amount <= 0)
      throw new QError('E_TYPE', `cap on '${c.bucket}' in scope '${here}' must be a positive integer`);
    if (parentCaps[c.bucket] !== undefined && c.amount > parentCaps[c.bucket])
      throw new QError('E_SCOPE',
        `scope '${here}' cap ${c.amount} on '${c.bucket}' exceeds outer cap ${parentCaps[c.bucket]}: inner scopes may only tighten, never widen`);
    caps[c.bucket] = c.amount;
  }
  const lets = { ...parentLets };
  for (const l of node.lets) {
    // Shadowing an outer `let` is allowed because bindings are read-only.
    lets[l.name] = evalConst(l.expr, lets, `let '${l.name}' in scope '${here}'`);
  }
  for (const a of node.assigns) {
    throw new QError('E_SCOPE',
      `assignment to '${a.name}' in scope '${here}' is forbidden: bindings are read-only, shadow with 'let' in an inner scope instead`);
  }
  for (const r of node.rules) {
    const wt = typeOf(r.when, lets, bucketNames);
    if (wt !== 'bool')
      throw new QError('E_TYPE', `reject ${r.op}: when-condition must be boolean, got ${wt} (scope '${here}')`);
    if (r.unless) {
      const ut = typeOf(r.unless, lets, bucketNames);
      if (ut !== 'bool')
        throw new QError('E_TYPE', `reject ${r.op}: unless-condition must be boolean, got ${ut} (scope '${here}')`);
    }
    if (!/^E_[A-Z]+$/.test(r.code))
      throw new QError('E_TYPE', `reject ${r.op}: unknown error code '${r.code}'`);
  }
  for (const ch of node.children) checkScope(ch, caps, lets, bucketNames, scopeNames, path.concat(node.name));
}

export function evalConst(e, lets, where) {
  switch (e.k) {
    case 'num': return e.v;
    case 'bool': return e.v ? 1 : 0;
    case 'var':
      if (e.name in lets) return lets[e.name];
      throw new QError('E_TYPE', `unknown name '${e.name}' in ${where}`);
    case 'un': {
      const v = evalConst(e.e, lets, where);
      return e.op === 'neg' ? -v : (v ? 0 : 1);
    }
    case 'bin': {
      const a = evalConst(e.l, lets, where);
      const b = evalConst(e.r, lets, where);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw new QError('E_TYPE', `division by zero in ${where}`);
          return a / b;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case 'and': return a && b ? 1 : 0;
        case 'or': return a || b ? 1 : 0;
        default: throw new QError('E_TYPE', `operator '${e.op}' not allowed in ${where}`);
      }
    }
    default:
      throw new QError('E_TYPE', `${where} must be a compile-time constant`);
  }
}

function mixKinds(lt, rt, op) {
  const la = lt !== 'pure';
  const ra = rt !== 'pure';
  if (la && ra && lt !== rt) {
    throw new QError('E_TYPE',
      `kind mismatch in '${op}': ${lt} vs ${rt} — limit/frozen/available are distinct types; frozen quota is not available quota`);
  }
  return la ? lt : rt;
}

export function typeOf(e, lets, bucketNames) {
  switch (e.k) {
    case 'num': return 'pure';
    case 'str': return 'string';
    case 'bool': return 'bool';
    case 'amount': return 'available';
    case 'note': return 'string';
    case 'var':
      if (e.name in lets) return 'pure';
      throw new QError('E_TYPE', `unknown name '${e.name}'`);
    case 'call':
      if (!bucketNames.has(e.bucket)) throw new QError('E_TYPE', `unknown bucket '${e.bucket}'`);
      return { available: 'available', frozen: 'frozen', limit: 'limit', used: 'used' }[e.fn];
    case 'un': {
      const t = typeOf(e.e, lets, bucketNames);
      if (e.op === 'not') {
        if (t !== 'bool') throw new QError('E_TYPE', `'not' requires a boolean operand, got ${t}`);
        return 'bool';
      }
      if (!NUM_KINDS.has(t)) throw new QError('E_TYPE', `unary '-' requires a numeric operand, got ${t}`);
      return t;
    }
    case 'bin': {
      const lt = typeOf(e.l, lets, bucketNames);
      const rt = typeOf(e.r, lets, bucketNames);
      if (e.op === 'and' || e.op === 'or') {
        if (lt !== 'bool' || rt !== 'bool')
          throw new QError('E_TYPE', `'${e.op}' requires boolean operands, got ${lt} and ${rt}`);
        return 'bool';
      }
      if (['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
        mixKinds(lt, rt, e.op);
        return 'bool';
      }
      if (!NUM_KINDS.has(lt) || !NUM_KINDS.has(rt))
        throw new QError('E_TYPE', `'${e.op}' requires numeric operands, got ${lt} and ${rt}`);
      return mixKinds(lt, rt, e.op);
    }
    case 'match': {
      const lt = typeOf(e.left, lets, bucketNames);
      if (lt !== 'string') throw new QError('E_TYPE', `'matches' requires a string left operand, got ${lt}`);
      try { new RegExp(e.re); } catch { throw new QError('E_TYPE', `invalid regex /${e.re}/`); }
      return 'bool';
    }
    default:
      throw new QError('E_TYPE', 'unknown expression');
  }
}
