// 规范 LR(1) 自动机构造、冲突检测、最短符号路径、LALR 合并对照

import {
  Grammar,
  EOF,
  computeFirstSets,
  firstOfSequence,
} from "./grammar";

export interface Item {
  prod: number; // 产生式下标
  dot: number; // 圆点位置
  la: string; // 向前看符号（终结符或 $）
}

export function itemKey(it: Item): string {
  return `${it.prod}.${it.dot}.${it.la}`;
}

function stateKey(items: Item[]): string {
  return items.map(itemKey).sort().join("|");
}

export interface Automaton {
  states: Item[][]; // 每个状态的完整 LR(1) 项目集（闭包）
  transitions: Array<Map<string, number>>; // 状态 -> 符号 -> 目标状态
}

/** 按左部建立产生式索引，加速闭包计算。 */
function indexByLhs(g: Grammar): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let i = 0; i < g.productions.length; i++) {
    const lhs = g.productions[i].lhs;
    if (!map.has(lhs)) map.set(lhs, []);
    map.get(lhs)!.push(i);
  }
  return map;
}

export function closure(
  g: Grammar,
  first: Map<string, Set<string>>,
  byLhs: Map<string, number[]>,
  kernel: Item[]
): Item[] {
  const items = new Map<string, Item>();
  const queue: Item[] = [];
  const add = (it: Item) => {
    const k = itemKey(it);
    if (!items.has(k)) {
      items.set(k, it);
      queue.push(it);
    }
  };
  for (const it of kernel) add(it);
  while (queue.length > 0) {
    const it = queue.shift()!;
    const p = g.productions[it.prod];
    if (it.dot >= p.rhs.length) continue;
    const B = p.rhs[it.dot];
    if (!g.nonterminals.has(B)) continue;
    const beta = p.rhs.slice(it.dot + 1);
    const lookaheads = firstOfSequence([...beta, it.la], first);
    for (const j of byLhs.get(B) ?? []) {
      for (const la of lookaheads) add({ prod: j, dot: 0, la });
    }
  }
  return [...items.values()];
}

/** 构造规范 LR(1) 自动机（不合并任何状态）。 */
export function buildCanonicalLR1(g: Grammar): Automaton {
  const first = computeFirstSets(g);
  const byLhs = indexByLhs(g);
  const states: Item[][] = [];
  const transitions: Array<Map<string, number>> = [];
  const index = new Map<string, number>();

  const addState = (items: Item[]): { id: number; isNew: boolean } => {
    const key = stateKey(items);
    const existing = index.get(key);
    if (existing !== undefined) return { id: existing, isNew: false };
    const id = states.length;
    states.push(items);
    transitions.push(new Map());
    index.set(key, id);
    return { id, isNew: true };
  };

  const start = addState(closure(g, first, byLhs, [{ prod: 0, dot: 0, la: EOF }]));
  const queue = [start.id];
  while (queue.length > 0) {
    const s = queue.shift()!;
    const afterDot = new Map<string, Item[]>();
    for (const it of states[s]) {
      const p = g.productions[it.prod];
      if (it.dot < p.rhs.length) {
        const X = p.rhs[it.dot];
        if (!afterDot.has(X)) afterDot.set(X, []);
        afterDot.get(X)!.push(it);
      }
    }
    for (const [X, src] of afterDot) {
      const kernel = src.map((it) => ({ prod: it.prod, dot: it.dot + 1, la: it.la }));
      const { id, isNew } = addState(closure(g, first, byLhs, kernel));
      transitions[s].set(X, id);
      if (isNew) queue.push(id);
    }
  }
  return { states, transitions };
}

export type ConflictKind = "shift-reduce" | "reduce-reduce";

export interface Conflict {
  state: number;
  kind: ConflictKind;
  terminal: string;
  shiftTarget: number | null;
  reduceProds: number[];
}

/** 检测单个项目集（一个状态）上的冲突。 */
function conflictsInItems(
  g: Grammar,
  stateId: number,
  items: Item[],
  transitions: Map<string, number>
): Conflict[] {
  const shiftTerminals = new Map<string, number>();
  for (const [sym, tgt] of transitions) {
    if (g.terminals.has(sym)) shiftTerminals.set(sym, tgt);
  }
  const reduces = new Map<string, number[]>();
  for (const it of items) {
    const p = g.productions[it.prod];
    if (it.dot !== p.rhs.length) continue;
    if (it.prod === 0) continue; // 增广产生式完成即接受，不算归约冲突
    if (!reduces.has(it.la)) reduces.set(it.la, []);
    reduces.get(it.la)!.push(it.prod);
  }
  const out: Conflict[] = [];
  const terminals = new Set<string>([...shiftTerminals.keys(), ...reduces.keys()]);
  for (const t of [...terminals].sort()) {
    const rp = (reduces.get(t) ?? []).slice().sort((a, b) => a - b);
    const shift = shiftTerminals.get(t);
    if (rp.length >= 2) {
      out.push({ state: stateId, kind: "reduce-reduce", terminal: t, shiftTarget: shift ?? null, reduceProds: rp });
    } else if (rp.length === 1 && shift !== undefined) {
      out.push({ state: stateId, kind: "shift-reduce", terminal: t, shiftTarget: shift, reduceProds: rp });
    }
  }
  return out;
}

/** 在规范 LR(1) 自动机上检测全部冲突。 */
export function findConflicts(g: Grammar, aut: Automaton): Conflict[] {
  const out: Conflict[] = [];
  for (let s = 0; s < aut.states.length; s++) {
    out.push(...conflictsInItems(g, s, aut.states[s], aut.transitions[s]));
  }
  return out;
}

/** BFS 求初始状态到每个状态的最短符号路径（按符号数计）。 */
export function shortestPaths(aut: Automaton): string[][] {
  const paths: (string[] | null)[] = new Array(aut.states.length).fill(null);
  paths[0] = [];
  const queue = [0];
  while (queue.length > 0) {
    const s = queue.shift()!;
    for (const [sym, tgt] of aut.transitions[s]) {
      if (paths[tgt] === null) {
        paths[tgt] = [...paths[s]!, sym];
        queue.push(tgt);
      }
    }
  }
  return paths.map((p) => p ?? []);
}

export interface LalrConflict extends Conflict {
  mergeInduced: boolean; // true 表示该冲突仅由 LALR 合并引入，原文法（规范 LR(1)）并无此冲突
}

export interface LalrReport {
  stateCount: number;
  conflicts: LalrConflict[];
}

function conflictSignature(c: Conflict): string {
  return `${c.kind}|${c.terminal}|${[...c.reduceProds].sort((a, b) => a - b).join(",")}`;
}

/**
 * LALR(1) 对照分析：按 LR(0) 核心合并规范 LR(1) 状态，
 * 用于标识“仅由合并引入”的冲突，这些冲突不属于原文法的冲突。
 */
export function analyzeLalr(g: Grammar, aut: Automaton): LalrReport {
  const coreKeyOf = (items: Item[]): string =>
    [
      ...new Set(
        items
          .filter((it) => it.dot > 0 || it.prod === 0)
          .map((it) => `${it.prod}.${it.dot}`)
      ),
    ]
      .sort()
      .join("|");

  const groupOf = new Array<number>(aut.states.length);
  const groupItems: Item[][] = [];
  const groupId = new Map<string, number>();
  for (let s = 0; s < aut.states.length; s++) {
    const key = coreKeyOf(aut.states[s]);
    let id = groupId.get(key);
    if (id === undefined) {
      id = groupItems.length;
      groupId.set(key, id);
      groupItems.push([]);
    }
    groupOf[s] = id;
    const seen = new Set(groupItems[id].map(itemKey));
    for (const it of aut.states[s]) {
      if (!seen.has(itemKey(it))) {
        groupItems[id].push(it);
        seen.add(itemKey(it));
      }
    }
  }

  const groupTransitions: Array<Map<string, number>> = groupItems.map(() => new Map());
  for (let s = 0; s < aut.states.length; s++) {
    const from = groupOf[s];
    for (const [sym, tgt] of aut.transitions[s]) {
      groupTransitions[from].set(sym, groupOf[tgt]);
    }
  }

  const canonicalSigs = new Set(findConflicts(g, aut).map(conflictSignature));
  const conflicts: LalrConflict[] = [];
  for (let s = 0; s < groupItems.length; s++) {
    for (const c of conflictsInItems(g, s, groupItems[s], groupTransitions[s])) {
      conflicts.push({ ...c, mergeInduced: !canonicalSigs.has(conflictSignature(c)) });
    }
  }
  return { stateCount: groupItems.length, conflicts };
}
