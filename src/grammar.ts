// 文法表示、解析与 FIRST 集计算

export const EPS = "ε";
export const EOF = "$";

export const MAX_PRODUCTIONS = 20;

export interface Production {
  lhs: string;
  rhs: string[]; // 空数组表示 ε 产生式
}

export interface Grammar {
  start: string; // 原文法开始符号
  augmentedStart: string; // 增广开始符号 S'
  productions: Production[]; // 下标 0 为增广产生式 S' -> S
  nonterminals: Set<string>; // 含增广开始符号
  terminals: Set<string>;
}

const EPS_ALIASES = new Set([EPS, "eps", "epsilon", "EPS", "Epsilon", "∅", "λ"]);

/**
 * 解析文法文本。每行一条规则：`LHS -> alt1 | alt2 | ...`，
 * 符号以空白分隔；`#` 之后为注释；空右部或 ε/eps/epsilon 表示空产生式。
 * 出现在任意左部的符号为非终结符，其余为终结符；开始符号为第一条规则的左部。
 * 产生式总数（每个候选式单独计）不得超过 MAX_PRODUCTIONS。
 */
export function parseGrammar(text: string): Grammar {
  const ruleOrder: string[] = [];
  const rules = new Map<string, string[][]>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (line.length === 0) continue;
    const m = /^(\S+)\s*(?:->|::=|→)\s*(.*)$/.exec(line);
    if (!m) throw new Error(`第 ${i + 1} 行无法解析: ${lines[i].trim()}`);
    const lhs = m[1];
    if (!rules.has(lhs)) {
      rules.set(lhs, []);
      ruleOrder.push(lhs);
    }
    for (const altRaw of m[2].split("|")) {
      const tokens = altRaw
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0 && !EPS_ALIASES.has(t));
      rules.get(lhs)!.push(tokens);
    }
  }
  if (ruleOrder.length === 0) throw new Error("文法为空：未找到任何产生式");

  const body: Production[] = [];
  for (const lhs of ruleOrder) {
    for (const rhs of rules.get(lhs)!) body.push({ lhs, rhs });
  }
  if (body.length > MAX_PRODUCTIONS) {
    throw new Error(`产生式数量 ${body.length} 超过上限 ${MAX_PRODUCTIONS}`);
  }

  const nonterminals = new Set(ruleOrder);
  const terminals = new Set<string>();
  for (const p of body) {
    for (const s of p.rhs) {
      if (!nonterminals.has(s)) terminals.add(s);
    }
  }

  let augmentedStart = ruleOrder[0] + "'";
  while (nonterminals.has(augmentedStart) || terminals.has(augmentedStart)) {
    augmentedStart += "'";
  }
  nonterminals.add(augmentedStart);

  return {
    start: ruleOrder[0],
    augmentedStart,
    productions: [{ lhs: augmentedStart, rhs: [ruleOrder[0]] }, ...body],
    nonterminals,
    terminals,
  };
}

/** 计算所有符号的 FIRST 集（终结符的 FIRST 为自身；可空非终结符含 ε）。 */
export function computeFirstSets(g: Grammar): Map<string, Set<string>> {
  const first = new Map<string, Set<string>>();
  for (const t of g.terminals) first.set(t, new Set([t]));
  first.set(EOF, new Set([EOF]));
  for (const nt of g.nonterminals) first.set(nt, new Set());

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of g.productions) {
      const target = first.get(p.lhs)!;
      if (p.rhs.length === 0) {
        if (!target.has(EPS)) {
          target.add(EPS);
          changed = true;
        }
        continue;
      }
      let nullablePrefix = true;
      for (const sym of p.rhs) {
        const fs = first.get(sym);
        if (!fs) throw new Error(`未知符号: ${sym}`);
        for (const s of fs) {
          if (s !== EPS && !target.has(s)) {
            target.add(s);
            changed = true;
          }
        }
        if (!fs.has(EPS)) {
          nullablePrefix = false;
          break;
        }
      }
      if (nullablePrefix && !target.has(EPS)) {
        target.add(EPS);
        changed = true;
      }
    }
  }
  return first;
}

/** 符号串的 FIRST 集；若整串可空则结果含 ε。 */
export function firstOfSequence(seq: string[], first: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  let i = 0;
  for (; i < seq.length; i++) {
    const fs = first.get(seq[i]);
    if (!fs) throw new Error(`未知符号: ${seq[i]}`);
    for (const s of fs) if (s !== EPS) out.add(s);
    if (!fs.has(EPS)) break;
  }
  if (i === seq.length) out.add(EPS);
  return out;
}

export function formatProduction(g: Grammar, index: number): string {
  const p = g.productions[index];
  return `${p.lhs} -> ${p.rhs.length === 0 ? EPS : p.rhs.join(" ")}`;
}

export function formatItem(g: Grammar, prod: number, dot: number, la?: string): string {
  const p = g.productions[prod];
  const rhs = p.rhs.slice();
  rhs.splice(dot, 0, "·");
  const base = `${p.lhs} -> ${rhs.join(" ")}`;
  return la === undefined ? base : `[${base}, ${la}]`;
}
