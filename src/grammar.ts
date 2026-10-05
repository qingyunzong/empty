/** Grammar model and parser for the CLI input format. */

export const EOF = "$";
export const EPSILON = "ε";

export interface Production {
  lhs: string;
  rhs: string[]; // empty array = epsilon production
}

export interface Grammar {
  /** productions[0] is the augmented production S' -> S */
  productions: Production[];
  nonterminals: Set<string>;
  /** terminals including EOF marker "$" */
  terminals: Set<string>;
  start: string; // augmented start symbol
}

export const MAX_PRODUCTIONS = 20;

const EPSILON_WORDS = new Set(["ε", "eps", "epsilon", "EPSILON", "''", '""']);

function isArrow(tok: string): boolean {
  return tok === "->" || tok === "→" || tok === "::=";
}

/**
 * Parse grammar text. One rule per line:
 *   S -> A a | b
 *   A -> c A |          (empty alternative = epsilon)
 * `#` starts a comment. Tokens are whitespace separated.
 * Each alternative counts as one production; at most MAX_PRODUCTIONS total.
 */
export function parseGrammar(text: string): Grammar {
  const rules: Production[] = [];
  const lhsOrder: string[] = [];

  const lines = text.split(/\r?\n/);
  for (let lineno = 0; lineno < lines.length; lineno++) {
    const raw = lines[lineno]!;
    const noComment = raw.includes("#") ? raw.slice(0, raw.indexOf("#")) : raw;
    const line = noComment.trim();
    if (line === "") continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 2 || !isArrow(tokens[1]!)) {
      throw new Error(`第 ${lineno + 1} 行无法解析（期望 "LHS -> rhs"）：${raw.trim()}`);
    }
    const lhs = tokens[0]!;
    if (EPSILON_WORDS.has(lhs)) {
      throw new Error(`第 ${lineno + 1} 行：左部不能是 ε`);
    }
    if (!lhsOrder.includes(lhs)) lhsOrder.push(lhs);

    // Split RHS tokens into alternatives on "|"
    const alternatives: string[][] = [[]];
    for (const tok of tokens.slice(2)) {
      if (tok === "|") {
        alternatives.push([]);
      } else if (EPSILON_WORDS.has(tok)) {
        // explicit epsilon marker: contributes no symbol
      } else {
        alternatives[alternatives.length - 1]!.push(tok);
      }
    }
    for (const rhs of alternatives) {
      rules.push({ lhs, rhs });
    }
  }

  if (rules.length === 0) throw new Error("文法为空：没有产生式");
  if (rules.length > MAX_PRODUCTIONS) {
    throw new Error(`产生式过多：${rules.length} 条（每个备选分支计 1 条），上限为 ${MAX_PRODUCTIONS} 条`);
  }

  const nonterminals = new Set(lhsOrder);
  const terminals = new Set<string>();
  for (const p of rules) {
    for (const sym of p.rhs) {
      if (!nonterminals.has(sym)) terminals.add(sym);
    }
  }
  terminals.add(EOF);

  const userStart = rules[0]!.lhs;
  let augStart = userStart + "'";
  while (nonterminals.has(augStart) || terminals.has(augStart)) augStart += "'";

  const productions: Production[] = [{ lhs: augStart, rhs: [userStart] }, ...rules];
  nonterminals.add(augStart);

  return { productions, nonterminals, terminals, start: augStart };
}

export function formatProduction(p: Production): string {
  return `${p.lhs} -> ${p.rhs.length === 0 ? EPSILON : p.rhs.join(" ")}`;
}
