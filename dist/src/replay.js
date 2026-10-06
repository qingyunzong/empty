"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replayPath = replayPath;
exports.verifyPath = verifyPath;
const state_1 = require("./state");
function replayPath(level, actions) {
    const store = new state_1.StateStore(level);
    let cur = store.initial();
    const trajectory = [cur];
    for (let i = 0; i < actions.length; i++) {
        const ns = store.apply(cur, actions[i]);
        if (!ns) {
            return { ok: false, failedAt: i, final: cur, reachedGoal: false, trajectory };
        }
        cur = ns;
        trajectory.push(cur);
    }
    return {
        ok: true,
        failedAt: -1,
        final: cur,
        reachedGoal: cur.pos === level.goal,
        trajectory,
    };
}
/** 便捷核验：路径全部合法且最终到达终点 */
function verifyPath(level, actions) {
    const r = replayPath(level, actions);
    return r.ok && r.reachedGoal;
}
