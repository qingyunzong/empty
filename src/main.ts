import { bruteForce } from './bruteforce.js';
import { buildCertificate, verifyCertificate } from './certificate.js';
import { validateLayout, type Problem } from './model.js';
import { solve } from './solver.js';

function printCert(title: string, problem: Problem, maxNodes: number): void {
  const result = solve(problem, { maxNodes });
  const cert = buildCertificate(problem, result);
  const issues = verifyCertificate(problem, cert);
  console.log(`=== ${title} ===`);
  console.log(`status=${cert.status} lowerBound=${cert.lowerBound} upperBound=${cert.upperBound} gap=${cert.gap} nodes=${cert.nodesExpanded}`);
  console.log(`layout=${JSON.stringify(cert.layout)}`);
  const failed = cert.checks.filter((c) => !c.ok);
  console.log(`constraint checks: ${cert.checks.length - failed.length}/${cert.checks.length} passed; verification issues: ${issues.length}`);
  console.log(`certificate JSON:\n${JSON.stringify(cert, null, 2)}\n`);
}

// Demo A: 4 rects on grid 20, alignment chain, expected to close to optimality.
const demoA: Problem = {
  grid: 20,
  rects: [
    { id: 'A', minW: 2, maxW: 4, minH: 2, maxH: 4 },
    { id: 'B', minW: 2, maxW: 4, minH: 2, maxH: 4 },
    { id: 'C', minW: 2, maxW: 3, minH: 2, maxH: 3 },
    { id: 'D', minW: 3, maxW: 5, minH: 2, maxH: 3 },
  ],
  alignments: [
    { kind: 'pair', a: 'A', edgeA: 'right', b: 'B', edgeB: 'left' },
    { kind: 'pair', a: 'A', edgeA: 'bottom', b: 'C', edgeB: 'top' },
    { kind: 'fixed', a: 'D', edgeA: 'left', value: 12 },
  ],
  oldLayout: {
    A: { x: 2, y: 2, w: 3, h: 3 },
    B: { x: 3, y: 3, w: 3, h: 3 },
    C: { x: 2, y: 4, w: 2, h: 2 },
    D: { x: 10, y: 8, w: 4, h: 2 },
  },
};

// Demo B: 8 rects on grid 20 with a tight node budget: bounds stay open.
const demoB: Problem = {
  grid: 20,
  rects: Array.from({ length: 8 }, (_, i) => ({
    id: `R${i}`,
    minW: 2,
    maxW: 5,
    minH: 2,
    maxH: 4,
  })),
  alignments: [
    { kind: 'pair', a: 'R0', edgeA: 'right', b: 'R1', edgeB: 'left' },
    { kind: 'pair', a: 'R2', edgeA: 'bottom', b: 'R3', edgeB: 'top' },
  ],
  oldLayout: Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `R${i}`,
      { x: 6 + (i % 3), y: 6 + Math.floor(i / 3), w: 3, h: 3 },
    ]),
  ),
};

// Demo C: tiny grid cross-check against exhaustive enumeration.
const demoC: Problem = {
  grid: 4,
  rects: [
    { id: 'a', minW: 2, maxW: 2, minH: 2, maxH: 2 },
    { id: 'b', minW: 2, maxW: 2, minH: 2, maxH: 2 },
    { id: 'c', minW: 2, maxW: 2, minH: 2, maxH: 2 },
  ],
  alignments: [{ kind: 'pair', a: 'a', edgeA: 'right', b: 'b', edgeB: 'left' }],
  oldLayout: {
    a: { x: 1, y: 0, w: 2, h: 2 },
    b: { x: 1, y: 0, w: 2, h: 2 },
    c: { x: 0, y: 1, w: 2, h: 2 },
  },
};

printCert('Demo A: 4 rects, grid 20, optimal', demoA, 500_000);
printCert('Demo B: 8 rects, grid 20, budgeted', demoB, 2_000);

{
  console.log('=== Demo C: tiny-grid exhaustive cross-check ===');
  const solved = solve(demoC, { maxNodes: 100_000 });
  const brute = bruteForce(demoC);
  console.log(`solver:   status=${solved.status} objective=${solved.objective} nodes=${solved.nodesExpanded}`);
  console.log(`brute:    feasible=${brute.feasible} objective=${brute.objective} validLayouts=${brute.validLayouts}`);
  console.log(`match:    ${solved.objective === brute.objective}`);
  if (solved.layout) {
    console.log(`solver layout valid: ${validateLayout(demoC, solved.layout).length === 0}`);
  }
}
