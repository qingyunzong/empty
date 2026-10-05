import { compile } from "./solver.js";
/**
 * 独立核对器：与 solve() 的事件驱动搜索不同，这里按单位时间逐步推进，
 * 每个整数时刻枚举所有“开工/空闲”组合，BFS（按时间分桶）求最短总工期。
 * 仅返回 makespan（不可行返回 null），用于小实例交叉核对。
 */
export function bruteMakespan(inst) {
    const c = compile(inst);
    const { n, horizon, dur, crew, skillMask, depMask } = c;
    const FULL = (1 << n) - 1;
    const keyOf = (s) => `${s.done}|${s.ta},${s.ra}|${s.tb},${s.rb}`;
    const buckets = Array.from({ length: horizon + 1 }, () => new Map());
    const seen = new Map();
    const push = (s, t) => {
        const k = keyOf(s);
        const prev = seen.get(k);
        if (prev !== undefined && prev <= t)
            return;
        seen.set(k, t);
        buckets[t].set(k, s);
    };
    push({ done: 0, ta: -1, ra: 0, tb: -1, rb: 0 }, 0);
    for (let t = 0; t <= horizon; t++) {
        for (const s of buckets[t].values()) {
            if (s.done === FULL)
                return t;
            const freeA = s.ta === -1;
            const freeB = s.tb === -1;
            const runningMask = (s.ta >= 0 ? 1 << s.ta : 0) | (s.tb >= 0 && s.tb !== s.ta ? 1 << s.tb : 0);
            const ready = [];
            for (let i = 0; i < n; i++) {
                if (s.done & (1 << i))
                    continue;
                if (runningMask & (1 << i))
                    continue;
                if ((depMask[i] & ~s.done) !== 0)
                    continue;
                ready.push(i);
            }
            // 本时刻的开工组合（含空闲选择）
            const combos = [];
            const forA = freeA ? ready.filter((i) => crew[i] === 1 && (skillMask[i] & 1) !== 0) : [];
            const forB = freeB ? ready.filter((i) => crew[i] === 1 && (skillMask[i] & 2) !== 0) : [];
            if (freeA && freeB) {
                const aOpts = [null, ...forA];
                const bOpts = [null, ...forB];
                for (const a of aOpts) {
                    for (const b of bOpts) {
                        if (a !== null && b !== null && a === b)
                            continue;
                        const combo = [];
                        if (a !== null)
                            combo.push({ task: a, wa: true });
                        if (b !== null)
                            combo.push({ task: b, wa: false });
                        combos.push(combo);
                    }
                }
                for (const i of ready) {
                    if (crew[i] === 2)
                        combos.push([{ task: i, wa: true }, { task: i, wa: false }]);
                }
            }
            else {
                const opts = freeA ? forA : forB;
                combos.push([]);
                for (const i of opts)
                    combos.push([{ task: i, wa: freeA }]);
            }
            for (const combo of combos) {
                if (combo.length === 0 && s.ta === -1 && s.tb === -1)
                    continue; // 全员无限空闲，无意义
                let { ta, ra, tb, rb } = s;
                for (const st of combo) {
                    if (st.wa) {
                        ta = st.task;
                        ra = dur[st.task];
                    }
                    else {
                        tb = st.task;
                        rb = dur[st.task];
                    }
                }
                // 推进一个时间单位
                let done = s.done;
                if (ta >= 0) {
                    ra--;
                    if (ra === 0) {
                        done |= 1 << ta;
                        ta = -1;
                    }
                }
                if (tb >= 0) {
                    rb--;
                    if (rb === 0) {
                        done |= 1 << tb;
                        tb = -1;
                    }
                }
                if (t + 1 <= horizon)
                    push({ done, ta, ra, tb, rb }, t + 1);
            }
        }
    }
    return null;
}
