"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const model_1 = require("../src/model");
const solver_1 = require("../src/solver");
const certificate_1 = require("../src/certificate");
const problem = {
    users: 4,
    tiers: [
        { r1: 2, r2: 1, benefit: 3 },
        { r1: 4, r2: 2, benefit: 8 },
    ],
    budget1: 10,
    budget2: 6,
    pairBonuses: [{ i: 0, j: 1, a: 1, b: 1, bonus: 5 }],
    constraints: [
        { kind: 'same', i: 0, j: 1 },
        { kind: 'diff', i: 2, j: 3 },
    ],
};
(0, node_test_1.test)('solver output carries one certificate per budget and per constraint, all satisfied', () => {
    const best = (0, solver_1.solve)(problem);
    const v = (0, certificate_1.verifySolution)(problem, best.assignment);
    (0, strict_1.ok)(v.ok, v.certificates.filter((c) => !c.ok).map((c) => c.detail).join('\n'));
    (0, strict_1.equal)(v.certificates.length, 2 + problem.constraints.length);
    (0, strict_1.equal)(v.certificates.filter((c) => c.kind === 'budget').length, 2);
    (0, strict_1.equal)(v.certificates.filter((c) => c.kind === 'constraint').length, 2);
    (0, strict_1.equal)(v.benefit, best.benefit);
    (0, strict_1.equal)(v.used1, best.used1);
    (0, strict_1.equal)(v.used2, best.used2);
});
(0, node_test_1.test)('usage output respects both budgets', () => {
    const best = (0, solver_1.solve)(problem);
    (0, strict_1.ok)(best.used1 <= problem.budget1);
    (0, strict_1.ok)(best.used2 <= problem.budget2);
});
(0, node_test_1.test)('tampered assignment fails verification with a precise certificate', () => {
    // 手工构造违反 diff(2,3) 的解：用户2、3 同档（预算内：r1=8<=10, r2=4<=6）。
    const bad = [0, 0, 0, 0];
    const v = (0, certificate_1.verifySolution)(problem, bad);
    (0, strict_1.ok)(!v.ok);
    const failed = v.certificates.filter((c) => !c.ok);
    (0, strict_1.equal)(failed.length, 1);
    (0, strict_1.equal)(failed[0].kind, 'constraint');
    if (failed[0].kind === 'constraint')
        (0, strict_1.equal)(failed[0].index, 1);
    (0, strict_1.ok)(failed[0].detail.includes('VIOLATED'));
});
(0, node_test_1.test)('over-budget assignment fails the budget certificate', () => {
    const v = (0, certificate_1.verifySolution)(problem, [1, 1, 1, 1]); // r1 = 16 > 10
    (0, strict_1.ok)(!v.ok);
    const budgetCerts = v.certificates.filter((c) => c.kind === 'budget');
    (0, strict_1.ok)(budgetCerts.some((c) => !c.ok && c.resource === 'r1'));
});
(0, node_test_1.test)('unserved users make constraints vacuously satisfied', () => {
    const p = {
        users: 2,
        tiers: [{ r1: 1, r2: 1, benefit: 5 }],
        budget1: 1,
        budget2: 1,
        constraints: [{ kind: 'same', i: 0, j: 1 }],
    };
    const v = (0, certificate_1.verifySolution)(p, [0, model_1.UNSERVED]);
    (0, strict_1.ok)(v.ok);
    const c = v.certificates.find((x) => x.kind === 'constraint');
    (0, strict_1.ok)(c.detail.includes('vacuously satisfied'));
});
(0, node_test_1.test)('certificate details are human-readable and enumerate every constraint', () => {
    const best = (0, solver_1.solve)(problem);
    const v = (0, certificate_1.verifySolution)(problem, best.assignment);
    const details = v.certificates.map((c) => c.detail);
    (0, strict_1.ok)(details.some((d) => d.startsWith('resource r1:')));
    (0, strict_1.ok)(details.some((d) => d.startsWith('resource r2:')));
    (0, strict_1.ok)(details.some((d) => d.startsWith('constraint#0 same(0,1):')));
    (0, strict_1.ok)(details.some((d) => d.startsWith('constraint#1 diff(2,3):')));
});
