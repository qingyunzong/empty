// Shared helpers: pipeline shortcut and a naive reference solver used to
// cross-check the optimizing solver (acceptance criterion 1).
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/check.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

export const pipeline = (src, file = 'test.dsl') =>
  compile(check(parse(lex(src, file), file), file));

// Naive full enumeration (no pruning) with the same tie-break rules.
export function referenceSolve(prog) {
  const n = prog.n;
  const step = prog.stepG;
  const U = prog.targetG / step;
  const cap = prog.capsG.map((s) => Math.floor(s / step));
  const order = [...Array(n).keys()].sort((a, b) =>
    prog.names[a] < prog.names[b] ? -1 : prog.names[a] > prog.names[b] ? 1 : 0,
  );
  const units = new Array(n).fill(0);
  let best = null;
  const dfs = (pos, remaining) => {
    if (pos === n) {
      if (remaining !== 0) return;
      const grams = units.map((u) => u * step);
      for (const c of prog.constraints) {
        if (!run(c.code, grams)) return;
      }
      const costMicro = run(prog.objectiveCode, grams);
      const allergenTotal = run(prog.allergenCode, grams);
      if (
        !best ||
        costMicro < best.costMicro ||
        (costMicro === best.costMicro && allergenTotal < best.allergenTotal)
      ) {
        best = { grams, costMicro, allergenTotal };
      }
      return;
    }
    const i = order[pos];
    for (let u = 0; u <= Math.min(cap[i], remaining); u++) {
      units[i] = u;
      dfs(pos + 1, remaining - u);
    }
    units[i] = 0;
  };
  dfs(0, U);
  return best;
}
