"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.solve = solve;
const state_1 = require("./state");
/**
 * 从 level 的初始状态出发求到终点的最短动作路径；无解返回 null。
 * 可选 from 版本：从任意（分叉的）历史版本继续搜索。
 */
function solve(level, from, store) {
    const st = store ?? new state_1.StateStore(level);
    const start = from ?? st.initial();
    if (start.pos === level.goal) {
        return { actions: [], goal: start, explored: 1 };
    }
    const seen = new Set([(0, state_1.stateKey)(start)]);
    let frontier = [start];
    let explored = 1;
    while (frontier.length > 0) {
        const nextFrontier = [];
        for (const cur of frontier) {
            for (const a of state_1.ACTIONS) {
                const ns = st.apply(cur, a);
                if (!ns)
                    continue;
                const k = (0, state_1.stateKey)(ns);
                if (seen.has(k))
                    continue;
                seen.add(k);
                explored++;
                if (ns.pos === level.goal) {
                    return { actions: st.pathTo(ns, start.version), goal: ns, explored };
                }
                nextFrontier.push(ns);
            }
        }
        frontier = nextFrontier;
    }
    return null;
}
