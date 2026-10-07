/**
 * 报价反推核心：
 *   每步对整数价格 x 计算  y = roundHalfEven(x * p / q)，
 *   给定最终舍入金额，反推所有满足条件的整数原价，输出互不交叠的闭区间。
 * 全部使用 BigInt 精确运算，避免浮点误差。
 */
/** 原价定义域上界：10^12 */
export const MAX_ORIGINAL_PRICE = 1000000000000n;
export const MAX_STEPS = 8;
/** 解析 "p/q" 或整数 "p" 形式的有理折扣因子 */
export function parseStep(text) {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
    if (!m || m[1] === undefined) {
        throw new Error(`无效的折扣步骤（应为正有理数 p/q）: ${text}`);
    }
    const p = BigInt(m[1]);
    const q = m[2] !== undefined ? BigInt(m[2]) : 1n;
    if (p <= 0n || q <= 0n) {
        throw new Error(`折扣因子必须为正有理数: ${text}`);
    }
    return { p, q };
}
/** 最近偶数舍入（round half to even），num >= 0, den > 0 */
export function roundHalfEven(num, den) {
    const quot = num / den;
    const rem = num % den;
    const twice = 2n * rem;
    if (twice < den)
        return quot;
    if (twice > den)
        return quot + 1n;
    return quot % 2n === 0n ? quot : quot + 1n;
}
/** 单步前向计算 */
export function applyStep(x, step) {
    return roundHalfEven(x * step.p, step.q);
}
/** 整条折扣链前向计算 */
export function forwardChain(steps, x) {
    let v = x;
    for (const step of steps)
        v = applyStep(v, step);
    return v;
}
function ceilDiv(a, b) {
    return a >= 0n ? (a + b - 1n) / b : -((-a) / b);
}
function floorDiv(a, b) {
    return a >= 0n ? a / b : -((-a + b - 1n) / b);
}
/**
 * 单步反推：返回所有满足  a <= roundHalfEven(x*p/q) <= b  的整数 x 的闭区间；
 * 无解时返回 null。
 *
 * roundHalfEven(y) = n  ⟺
 *   y > n - 1/2 或 (y = n - 1/2 且 n 为偶数)，且
 *   y < n + 1/2 或 (y = n + 1/2 且 n 为偶数)。
 * 由于舍入关于 x 单调不减，输出区间 [a, b] 的原像为 [lo(a), hi(b)]。
 */
export function preimageInterval(step, a, b) {
    const { p, q } = step;
    const twoP = 2n * p;
    const lo = a % 2n === 0n
        ? ceilDiv((2n * a - 1n) * q, twoP)
        : floorDiv((2n * a - 1n) * q, twoP) + 1n;
    const hi = b % 2n === 0n
        ? floorDiv((2n * b + 1n) * q, twoP)
        : ceilDiv((2n * b + 1n) * q, twoP) - 1n;
    return lo <= hi ? [lo, hi] : null;
}
/** 合并区间：排序后把交叠或相邻（整数域上连续）的区间合并，结果互不交叠 */
export function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((u, v) => u[0] < v[0] ? -1 : u[0] > v[0] ? 1 : 0);
    const merged = [];
    for (const iv of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && iv[0] <= last[1] + 1n) {
            if (iv[1] > last[1])
                last[1] = iv[1];
        }
        else {
            merged.push([iv[0], iv[1]]);
        }
    }
    return merged;
}
/**
 * 从最终舍入金额 target 反推整条链的整数原价区间。
 * 结果限制在定义域 [domainLo, domainHi]（默认 [0, 10^12]）内，
 * 返回升序、互不交叠的闭区间数组。
 */
export function invertChain(steps, target, domainLo = 0n, domainHi = MAX_ORIGINAL_PRICE) {
    if (steps.length === 0 || steps.length > MAX_STEPS) {
        throw new Error(`折扣链步数必须在 1 到 ${MAX_STEPS} 之间，当前为 ${steps.length}`);
    }
    let intervals = [[target, target]];
    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step === undefined)
            throw new Error("unreachable");
        const next = [];
        for (const [a, b] of intervals) {
            const pre = preimageInterval(step, a, b);
            if (pre !== null)
                next.push(pre);
        }
        intervals = mergeIntervals(next);
        if (intervals.length === 0)
            break;
    }
    const result = [];
    for (const [lo, hi] of intervals) {
        const clampedLo = lo < domainLo ? domainLo : lo;
        const clampedHi = hi > domainHi ? domainHi : hi;
        if (clampedLo <= clampedHi)
            result.push([clampedLo, clampedHi]);
    }
    return result;
}
/**
 * 低价域逐值前向核验：
 * 对每个区间与 [0, limit] 的交集逐值前向计算，确认结果等于 target；
 * 同时检查区间边界外侧相邻值（在低价域内时）确实不等于 target。
 */
export function verifyLowDomain(steps, target, intervals, limit, domainLo = 0n, domainHi = MAX_ORIGINAL_PRICE) {
    let checked = 0n;
    const mismatches = [];
    const boundaryErrors = [];
    let truncated = false;
    for (const [lo, hi] of intervals) {
        const cappedHi = hi < limit ? hi : limit;
        if (hi > limit)
            truncated = true;
        for (let x = lo; x <= cappedHi; x++) {
            checked++;
            if (forwardChain(steps, x) !== target)
                mismatches.push(x);
        }
        const below = lo - 1n;
        if (below >= domainLo && below <= limit && forwardChain(steps, below) === target) {
            boundaryErrors.push(below);
        }
        const above = hi + 1n;
        if (above <= domainHi && above <= limit && forwardChain(steps, above) === target) {
            boundaryErrors.push(above);
        }
    }
    return { limit, checked, mismatches, boundaryErrors, truncated };
}
/** 区间内整数值总个数 */
export function countValues(intervals) {
    let total = 0n;
    for (const [lo, hi] of intervals)
        total += hi - lo + 1n;
    return total;
}
