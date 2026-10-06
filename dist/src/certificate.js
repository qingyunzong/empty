"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifySolution = verifySolution;
/**
 * 证书：对给定解逐条输出可独立核验的证据——
 * 两类资源用量各一条，每条用户间约束各一条。
 */
const model_1 = require("./model");
function tierLabel(t) {
    return t === model_1.UNSERVED ? 'unserved' : `tier ${t}`;
}
/** 生成并校验全部证书；ok 为所有证书与结构检查的逻辑与。 */
function verifySolution(problem, assignment) {
    const np = (0, model_1.normalize)(problem);
    if (!Array.isArray(assignment) || assignment.length !== np.users) {
        throw new Error(`assignment length must be ${np.users}`);
    }
    for (const t of assignment) {
        if (t !== model_1.UNSERVED && (!Number.isInteger(t) || t < 0 || t >= np.tiers.length)) {
            throw new Error(`assignment contains invalid tier ${t}`);
        }
    }
    const ev = (0, model_1.evaluate)(np, assignment);
    const certificates = [];
    certificates.push({
        kind: 'budget', resource: 'r1', used: ev.used1, limit: np.budget1,
        ok: ev.used1 <= np.budget1,
        detail: `resource r1: used ${ev.used1} <= budget ${np.budget1}`,
    });
    certificates.push({
        kind: 'budget', resource: 'r2', used: ev.used2, limit: np.budget2,
        ok: ev.used2 <= np.budget2,
        detail: `resource r2: used ${ev.used2} <= budget ${np.budget2}`,
    });
    np.constraints.forEach((c, index) => {
        const ti = assignment[c.i];
        const tj = assignment[c.j];
        let ok;
        let detail;
        if (ti === model_1.UNSERVED || tj === model_1.UNSERVED) {
            ok = true;
            detail = `constraint#${index} ${c.kind}(${c.i},${c.j}): ` +
                `user ${ti === model_1.UNSERVED ? c.i : c.j} unserved -> vacuously satisfied`;
        }
        else {
            ok = c.kind === 'same' ? ti === tj : ti !== tj;
            const rel = c.kind === 'same' ? '==' : '!=';
            detail = `constraint#${index} ${c.kind}(${c.i},${c.j}): ` +
                `${tierLabel(ti)} ${rel} ${tierLabel(tj)} -> ${ok ? 'satisfied' : 'VIOLATED'}`;
        }
        certificates.push({
            kind: 'constraint', index, constraint: c,
            tierI: ti === model_1.UNSERVED ? null : ti,
            tierJ: tj === model_1.UNSERVED ? null : tj,
            ok, detail,
        });
    });
    return {
        ok: certificates.every((c) => c.ok),
        benefit: ev.benefit,
        used1: ev.used1,
        used2: ev.used2,
        certificates,
    };
}
