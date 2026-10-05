/** Tiny CLI: print the inclusion relation between two rules, with a
 *  counterexample when neither includes the other (or for the strict side). */
import { argv, exit } from "node:process";
import { parseRule, relate, counterexample, formatRule } from "./rules.js";

const [rawA, rawB] = argv.slice(2);
if (rawA === undefined || rawB === undefined) {
  console.log("usage: node dist/src/cli.js <ruleA> <ruleB>");
  console.log("example: node dist/src/cli.js '*.example.com' a.b.example.com");
  exit(2);
}

const a = parseRule(rawA);
if (!a.ok) {
  console.error(`rule A "${rawA}" rejected: ${a.error} — ${a.detail}`);
  exit(1);
}
const b = parseRule(rawB);
if (!b.ok) {
  console.error(`rule B "${rawB}" rejected: ${b.error} — ${b.detail}`);
  exit(1);
}

const relation = relate(a.rule, b.rule);
console.log(`A = ${formatRule(a.rule)}`);
console.log(`B = ${formatRule(b.rule)}`);
console.log(`relation: ${relation}`);
const ce = counterexample(a.rule, b.rule);
if (ce !== null) console.log(`counterexample to A ⊇ B: ${ce}`);
const ceReverse = counterexample(b.rule, a.rule);
if (ceReverse !== null) console.log(`counterexample to B ⊇ A: ${ceReverse}`);
