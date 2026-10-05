import { Node, ErrorKind, Op } from './ast';

export type Result =
  | { ok: true; value: bigint; log: bigint[] }
  | { ok: false; error: ErrorKind; log: bigint[] };

class EvalError extends Error {
  constructor(public readonly kind: ErrorKind) { super(kind); }
}

export function applyOp(op: Op, l: bigint, r: bigint): bigint {
  switch (op) {
    case 'add': return l + r;
    case 'sub': return l - r;
    case 'mul': return l * r;
    case 'div':
      if (r === 0n) throw new EvalError('div-by-zero');
      return l / r; // truncates toward zero
    case 'mod':
      if (r === 0n) throw new EvalError('mod-by-zero');
      return l % r;
  }
}

/**
 * Left-to-right, depth-first evaluation. The action log records every `log`
 * node's value in evaluation order, including entries emitted before the
 * first integer error.
 */
export function interpret(node: Node, input: Record<string, bigint> = {}): Result {
  const log: bigint[] = [];
  const env = new Map<string, bigint>();
  try {
    return { ok: true, value: evalNode(node, input, env, log), log };
  } catch (e) {
    if (e instanceof EvalError) return { ok: false, error: e.kind, log };
    throw e;
  }
}

function evalNode(
  node: Node,
  input: Record<string, bigint>,
  env: Map<string, bigint>,
  log: bigint[],
): bigint {
  switch (node.kind) {
    case 'lit': return node.value;
    case 'err': throw new EvalError(node.error);
    case 'var': {
      const v = input[node.name];
      if (v === undefined) throw new Error(`unbound variable: ${node.name}`);
      return v;
    }
    case 'bin': {
      const l = evalNode(node.left, input, env, log);
      const r = evalNode(node.right, input, env, log);
      return applyOp(node.op, l, r);
    }
    case 'log': {
      const v = evalNode(node.expr, input, env, log);
      log.push(v);
      return v;
    }
    case 'if': {
      const c = evalNode(node.cond, input, env, log);
      return evalNode(c !== 0n ? node.then : node.else, input, env, log);
    }
    case 'bind': {
      const v = evalNode(node.expr, input, env, log);
      env.set(node.name, v);
      return v;
    }
    case 'ref': {
      const v = env.get(node.name);
      if (v === undefined) throw new Error(`unbound ref: ${node.name}`);
      return v;
    }
  }
}
