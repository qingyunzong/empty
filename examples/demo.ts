import { parse, verifyCertificate, enumerateParses, completenessBound } from '../src/index';

// Arithmetic-ish grammar with recursive rules and non-negative costs.
const grammar = {
  start: 'E',
  rules: [
    { id: 1, lhs: 'E', rhs: ['E', '+', 'E'], cost: 1 },
    { id: 2, lhs: 'E', rhs: ['E', '*', 'E'], cost: 2 },
    { id: 3, lhs: 'E', rhs: ['(', 'E', ')'], cost: 0 },
    { id: 4, lhs: 'E', rhs: ['num'], cost: 0 },
  ],
};

const sequence = ['num', '+', 'num', '*', 'num'];

const result = parse(grammar, sequence, { budget: 2 });
if (result.status !== 'infeasible') {
  console.log('status        :', result.status);
  console.log('min cost      :', result.cost);
  console.log('rule id seq   :', result.ruleIds.join(' '));
  console.log('certificate ok:', verifyCertificate(grammar, result.certificate).ok);
} else {
  console.log('status        : infeasible -', result.reason);
}

const infeasible = parse(grammar, ['num', '+', '+']);
console.log('infeasible ex :', infeasible.status);

const bound = completenessBound(grammar, sequence.length);
const oracle = enumerateParses(grammar, sequence, bound);
console.log('oracle min    :', oracle.minCost, `(over ${oracle.count} trees, depth<=${bound})`);
