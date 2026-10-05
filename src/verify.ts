// 小文法核对：枚举可行前缀，独立计算每个前缀的有效 LR(1) 项目集，
// 与规范 LR(1) 自动机中沿该前缀到达的状态逐一比对。
//
// 原理：项目 [A -> α·β, a] 对可行前缀 γ 有效，当且仅当存在最右推导
//   S' ⇒* δA a w ⇒ δαβ a w，且 γ = δα。
// 由于 a 之后的全是终结符且不再参与推导，枚举时只需保留 w 的首个终结符
// （或 $），即可把句型表示为 (seq, la)：seq 以该最右非终结符结尾。
//
// 目标句型（|seq| ≤ maxLen+1）的推导中间形态可能更长（右侧符号先展开、
// 归约为终结符后 seq 再收缩），因此采用自适应加深：逐步放大中间形态长度
// 上界 L，连续两轮项目集不变即判定收敛；L 达到理论界限 Lmax 仍未收敛则
// 按界限停机（exhaustive）；句型数超出预算则截断（truncated，结果不完备）。

import { Grammar, EOF, formatItem } from "./grammar";
import { Automaton, Item, itemKey } from "./lr1";

export type VerifyStatus = "converged" | "exhaustive" | "truncated";

export interface VerifyResult {
  maxLen: number;
  boundUsed: number; // 实际使用的中间形态长度上界
  status: VerifyStatus;
  prefixCount: number; // 实际核对的可行前缀个数
  formCount: number; // 最后一轮枚举的句型个数
  mismatches: string[];
}

const SEP = String.fromCharCode(1); // 前缀符号分隔符
const LASEP = String.fromCharCode(2); // 句型与向前看符号的分隔符

interface Form {
  seq: string[];
  la: string;
}

/** 在给定中间形态长度上界内枚举句型，记录各可行前缀的有效项目集。 */
function enumerateItems(
  g: Grammar,
  maxLen: number,
  maxSeqLen: number,
  formBudget: { left: number }
): { valid: Map<string, Map<string, Item>>; formCount: number; overBudget: boolean } {
  const valid = new Map<string, Map<string, Item>>();
  const record = (prefix: string[], prod: number, dot: number, la: string) => {
    if (prefix.length > maxLen) return;
    const key = prefix.join(SEP);
    let bucket = valid.get(key);
    if (!bucket) {
      bucket = new Map();
      valid.set(key, bucket);
    }
    const it: Item = { prod, dot, la };
    bucket.set(itemKey(it), it);
  };

  const formKey = (f: Form) => f.seq.join(SEP) + LASEP + f.la;
  const seen = new Set<string>();
  const queue: Form[] = [{ seq: [g.augmentedStart], la: EOF }];
  seen.add(formKey(queue[0]));

  while (queue.length > 0) {
    if (seen.size > formBudget.left) return { valid, formCount: seen.size, overBudget: true };
    const form = queue.shift()!;
    const seq = form.seq;
    const A = seq[seq.length - 1];
    const delta = seq.slice(0, -1);
    for (let j = 0; j < g.productions.length; j++) {
      const p = g.productions[j];
      if (p.lhs !== A) continue;
      // 记录该产生式所有点位置对应的项目
      for (let dot = 0; dot <= p.rhs.length; dot++) {
        record([...delta, ...p.rhs.slice(0, dot)], j, dot, form.la);
      }
      // 展开最右非终结符，生成后继句型
      const full = [...delta, ...p.rhs];
      let k = full.length - 1;
      while (k >= 0 && !g.nonterminals.has(full[k])) k--;
      if (k < 0) continue; // 纯终结符串，无法继续推导
      const newSeq = full.slice(0, k + 1);
      if (newSeq.length > maxSeqLen) continue; // 超出本轮中间形态长度上界
      let newLa = form.la;
      for (let t = k + 1; t < full.length; t++) {
        if (g.terminals.has(full[t])) {
          newLa = full[t];
          break;
        }
      }
      const next: Form = { seq: newSeq, la: newLa };
      const key = formKey(next);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }
  return { valid, formCount: seen.size, overBudget: false };
}

function sameItems(a: Map<string, Map<string, Item>>, b: Map<string, Map<string, Item>>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, bucket] of a) {
    const other = b.get(key);
    if (!other || other.size !== bucket.size) return false;
    for (const k of bucket.keys()) if (!other.has(k)) return false;
  }
  return true;
}

export function verifyPrefixes(
  g: Grammar,
  aut: Automaton,
  maxLen: number,
  maxForms = 1000000
): VerifyResult {
  const maxRhs = Math.max(1, ...g.productions.map((p) => p.rhs.length));
  const step = maxRhs;
  const startBound = maxLen + 1;
  // 理论界限：最短推导中每个非终结符在 nullable/祖先链上至多出现一次
  const maxBound = startBound + maxRhs * (g.nonterminals.size + 1);

  const budget = { left: maxForms };
  let bound = startBound;
  let history: Array<Map<string, Map<string, Item>>> = [];
  let formCount = 0;
  let status: VerifyStatus = "exhaustive";
  let valid: Map<string, Map<string, Item>>;

  for (;;) {
    const round = enumerateItems(g, maxLen, bound, budget);
    if (round.overBudget) {
      // 用上一轮的预算内结果（若有）报告截断
      status = "truncated";
      valid = history.length > 0 ? history[history.length - 1] : round.valid;
      break;
    }
    formCount = round.formCount;
    valid = round.valid;
    history.push(valid);
    const n = history.length;
    if (n >= 3 && sameItems(history[n - 1], history[n - 2]) && sameItems(history[n - 2], history[n - 3])) {
      status = "converged";
      break;
    }
    if (bound >= maxBound) {
      status = "exhaustive";
      break;
    }
    bound = Math.min(bound + step, maxBound);
  }

  const mismatches: string[] = [];
  let prefixCount = 0;
  for (const [key, itemMap] of valid!) {
    const prefix = key === "" ? [] : key.split(SEP);
    const label = prefix.length === 0 ? "(空前缀)" : prefix.join(" ");
    let s = 0;
    let reachable = true;
    for (const sym of prefix) {
      const tgt = aut.transitions[s].get(sym);
      if (tgt === undefined) {
        reachable = false;
        break;
      }
      s = tgt;
    }
    if (!reachable) {
      mismatches.push(`前缀 ${label}：自动机中无对应路径`);
      continue;
    }
    prefixCount++;
    const dfaItems = new Set(aut.states[s].map(itemKey));
    const enumItems = new Set(itemMap.keys());
    const missing = [...enumItems].filter((k2) => !dfaItems.has(k2));
    const extra = [...dfaItems].filter((k2) => !enumItems.has(k2));
    if (missing.length > 0 || extra.length > 0) {
      const fmt = (k2: string) => {
        const [prod, dot, la] = k2.split(".");
        return formatItem(g, Number(prod), Number(dot), la);
      };
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`自动机缺少: ${missing.map(fmt).join("; ")}`);
      if (extra.length > 0) parts.push(`自动机多出: ${extra.map(fmt).join("; ")}`);
      mismatches.push(`前缀 ${label}（状态 #${s}）：${parts.join("；")}`);
    }
  }

  return { maxLen, boundUsed: bound, status, prefixCount, formCount, mismatches };
}
