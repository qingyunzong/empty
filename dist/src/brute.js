"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bruteForce = bruteForce;
/**
 * 暴力枚举器：独立地枚举所有分配向量，用于在小例子上核验求解器。
 */
const model_1 = require("./model");
function bruteForce(problem) {
    const np = (0, model_1.normalize)(problem);
    const options = [model_1.UNSERVED, ...np.tiers.map((_, i) => i)];
    const assignment = new Array(np.users).fill(model_1.UNSERVED);
    let best = null;
    const rec = (u, used1, used2) => {
        if (u === np.users) {
            if (!(0, model_1.allConstraintsHold)(np, assignment))
                return;
            const ev = (0, model_1.evaluate)(np, assignment);
            if (best === null || (0, model_1.compareEvaluated)(np, ev, best) < 0)
                best = ev;
            return;
        }
        for (const opt of options) {
            const tier = opt === model_1.UNSERVED ? null : np.tiers[opt];
            const u1 = used1 + (tier?.r1 ?? 0);
            const u2 = used2 + (tier?.r2 ?? 0);
            if (u1 > np.budget1 || u2 > np.budget2)
                continue;
            assignment[u] = opt;
            rec(u + 1, u1, u2);
        }
        assignment[u] = model_1.UNSERVED;
    };
    rec(0, 0, 0);
    return best;
}
