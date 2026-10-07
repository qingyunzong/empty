import { compareAddrStr, formatAddr, normAddr } from './address.js';
import { Ast, evaluate, parse } from './formula.js';
import { Value, errVal, intVal } from './value.js';

export interface FullResult {
  values: Map<string, Value>;
  deps: Map<string, string[]>;
}

/**
 * 全表解释器：不做任何增量缓存，每次从公式集合出发整体求值。
 * 求值规则（错误来源、环检测、动态分支）与增量引擎共享 evaluate，
 * 但 memo / 依赖记录完全独立，用于对照验证增量引擎。
 */
export function interpretAll(formulas: ReadonlyMap<string, string>): FullResult {
  const asts = new Map<string, Ast | null>();

  for (const [rawKey, rawFormula] of formulas) {
    const key = normAddr(rawKey);
    const text = rawFormula.trim();
    if (text === '') continue;
    try {
      asts.set(key, parse(text));
    } catch {
      asts.set(key, null);
    }
  }

  const memo = new Map<string, Value>();
  const depsMemo = new Map<string, Set<string>>();
  const stack: string[] = [];

  const compute = (key: string): Value => {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const at = stack.indexOf(key);
    if (at >= 0) {
      let min = key;
      for (let i = at; i < stack.length; i++) {
        if (compareAddrStr(stack[i], min) < 0) min = stack[i];
      }
      return errVal('#CYCLE!', min);
    }

    stack.push(key);
    let value: Value;
    const deps = new Set<string>();
    const ast = asts.get(key);
    if (ast === null) {
      value = errVal('#ERROR!', key);
    } else if (ast === undefined) {
      value = intVal(0);
    } else {
      value = evaluate(ast, key, (addr) => {
        const depKey = formatAddr(addr);
        deps.add(depKey);
        return compute(depKey);
      });
    }
    stack.pop();

    memo.set(key, value);
    depsMemo.set(key, deps);
    return value;
  };

  const keys = [...asts.keys()].sort(compareAddrStr);
  for (const k of keys) compute(k);

  const values = new Map<string, Value>();
  const deps = new Map<string, string[]>();
  for (const [k, v] of memo) {
    values.set(k, v);
    deps.set(k, [...(depsMemo.get(k) as Set<string>)].sort(compareAddrStr));
  }
  return { values, deps };
}
