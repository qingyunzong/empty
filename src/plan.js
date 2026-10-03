// Plan building, certificate hashing, and independent verification.
import { createHash } from 'node:crypto';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check, MICRO_PER_CNY } from './check.js';
import { compile } from './compiler.js';
import { solve } from './solver.js';
import { run } from './vm.js';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const certificateOf = (payload) =>
  createHash('sha256').update(canonical(payload)).digest('hex');

export function compileSource(source, file = '<input>') {
  return compile(check(parse(lex(source, file), file), file));
}

const evalAff = (aff, grams) =>
  aff.k + aff.c.reduce((sum, c, i) => sum + c * grams[i], 0);

export function marginsFor(prog, grams) {
  return prog.constraints.map((c) => {
    if (c.kind === 'range') {
      const value = evalAff(c.aff, grams);
      return {
        constraint: c.desc,
        value,
        slack_low: value - c.lo,
        slack_high: c.hi - value,
      };
    }
    const lhs = evalAff(c.affL, grams);
    const rhs = evalAff(c.affR, grams);
    let slack;
    if (c.op === '<=' || c.op === '<') slack = rhs - lhs;
    else if (c.op === '>=' || c.op === '>') slack = lhs - rhs;
    else slack = -Math.abs(lhs - rhs);
    return { constraint: c.desc, op: c.op, lhs, rhs, slack };
  });
}

const payloadOf = (plan) => {
  const { certificate, ...rest } = plan;
  return rest;
};

export function optimizeSource(source, file = '<input>') {
  const prog = compileSource(source, file);
  const result = solve(prog);
  let status = result.status;
  if (
    status === 'OPTIMAL' &&
    prog.budgetMicro !== null &&
    result.costMicro > prog.budgetMicro
  ) {
    status = 'OVER_BUDGET';
  }
  const plan = { version: 1, tool: 'recipe-optimizer', status, source };
  if (result.status === 'OPTIMAL') {
    const recipe = {};
    prog.names.forEach((nm, i) => {
      recipe[nm] = result.grams[i];
    });
    plan.recipe = recipe;
    plan.total_mass_g = result.grams.reduce((a, b) => a + b, 0);
    plan.step_g = prog.stepG;
    plan.cost_micro_cny = result.costMicro;
    plan.cost_cny = result.costMicro / MICRO_PER_CNY;
    plan.allergen_total = result.allergenTotal;
    plan.margins = marginsFor(prog, result.grams);
  }
  if (prog.budgetMicro !== null) {
    plan.budget_micro_cny = prog.budgetMicro;
    plan.budget_cny = prog.budgetMicro / MICRO_PER_CNY;
  }
  plan.certificate = certificateOf(payloadOf(plan));
  return { plan, status };
}

// Returns a list of problems; empty means the plan verifies.
export function verifyPlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return ['plan is not a JSON object'];
  for (const field of ['version', 'status', 'source', 'certificate']) {
    if (!(field in plan)) problems.push(`missing field '${field}'`);
  }
  if (problems.length) return problems;

  if (certificateOf(payloadOf(plan)) !== plan.certificate) {
    problems.push('certificate mismatch: plan contents were tampered with');
  }

  const prog = compileSource(plan.source, '<plan.source>');
  const result = solve(prog);
  let expectedStatus = result.status;
  if (
    expectedStatus === 'OPTIMAL' &&
    prog.budgetMicro !== null &&
    result.costMicro > prog.budgetMicro
  ) {
    expectedStatus = 'OVER_BUDGET';
  }
  if (plan.status !== expectedStatus) {
    problems.push(`status mismatch: plan says ${plan.status}, solver says ${expectedStatus}`);
    return problems;
  }
  if (result.status !== 'OPTIMAL') return problems;

  const recipe = {};
  prog.names.forEach((nm, i) => {
    recipe[nm] = result.grams[i];
  });
  if (canonical(plan.recipe) !== canonical(recipe)) {
    problems.push('recipe mismatch: plan recipe is not the certified optimum');
  }
  if (plan.cost_micro_cny !== result.costMicro) {
    problems.push('cost mismatch: plan cost does not match recomputation');
  }

  // Independent check: the stated recipe must satisfy every constraint.
  const grams = prog.names.map((nm) => plan.recipe?.[nm] ?? NaN);
  if (grams.some((g) => !Number.isInteger(g) || g < 0)) {
    problems.push('recipe grams must be non-negative integers');
    return problems;
  }
  if (grams.reduce((a, b) => a + b, 0) !== prog.targetG) {
    problems.push('mass conservation violated: grams do not sum to target');
  }
  prog.constraints.forEach((c, i) => {
    if (!run(c.code, grams)) {
      problems.push(`constraint violated by stated recipe: ${c.desc}`);
    }
  });
  const margins = marginsFor(prog, grams);
  if (canonical(plan.margins) !== canonical(margins)) {
    problems.push('margins mismatch: stated constraint margins are incorrect');
  }
  return problems;
}
