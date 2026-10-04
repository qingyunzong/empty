/**
 * 最佳优先分支定界求解器。
 *
 * - 目标：最小化 Σ |x-oldX| + |y-oldY|（整数，改尺寸免费）。
 * - 下界 = max(逐矩形独立最小代价之和, 对齐约束匹配下界)，均为可采纳松弛。
 * - 节点预算耗尽时保留当前上界（现任解）与下界（开放节点最小界），状态为 bounded。
 */
import { edgeValue, overlaps } from './constraints.js';
const INF = Number.POSITIVE_INFINITY;
function buildCandidates(spec, rectIndex) {
    const r = spec.rects[rectIndex];
    const list = [];
    for (let w = r.minW; w <= r.maxW; w++) {
        for (let h = r.minH; h <= r.maxH; h++) {
            for (let x = 0; x + w <= spec.grid; x++) {
                for (let y = 0; y + h <= spec.grid; y++) {
                    list.push({ x, y, w, h, cost: Math.abs(x - r.oldX) + Math.abs(y - r.oldY) });
                }
            }
        }
    }
    list.sort((a, b) => a.cost - b.cost || a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h);
    return list;
}
/** 二叉最小堆，按 (bound, -depth, cost, seq) 排序。 */
class Heap {
    nodes = [];
    less(k1, k2) {
        for (let i = 0; i < k1.length; i++) {
            if (k1[i] !== k2[i])
                return k1[i] < k2[i];
        }
        return false;
    }
    keyAt(i) {
        const n = this.nodes[i];
        return [n.bound, -n.depth, n.cost, n.seq];
    }
    get size() {
        return this.nodes.length;
    }
    peek() {
        return this.nodes[0];
    }
    push(n) {
        this.nodes.push(n);
        let i = this.nodes.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.less(this.keyAt(i), this.keyAt(p))) {
                [this.nodes[i], this.nodes[p]] = [this.nodes[p], this.nodes[i]];
                i = p;
            }
            else
                break;
        }
    }
    pop() {
        const top = this.nodes[0];
        const last = this.nodes.pop();
        if (this.nodes.length > 0) {
            this.nodes[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < this.nodes.length && this.less(this.keyAt(l), this.keyAt(m)))
                    m = l;
                if (r < this.nodes.length && this.less(this.keyAt(r), this.keyAt(m)))
                    m = r;
                if (m === i)
                    break;
                [this.nodes[i], this.nodes[m]] = [this.nodes[m], this.nodes[i]];
                i = m;
            }
        }
        return top;
    }
}
function toPlacement(id, c) {
    return { id, x: c.x, y: c.y, w: c.w, h: c.h };
}
function isCompatible(ctx, p, placed, placedById) {
    for (const q of placed) {
        if (overlaps(p, q))
            return false;
    }
    for (const c of ctx.alignOf.get(p.id) ?? []) {
        const otherId = c.a === p.id ? c.b : c.a;
        const other = placedById.get(otherId);
        if (other && edgeValue(p, c.edge) !== edgeValue(other, c.edge))
            return false;
    }
    return true;
}
/** 未放置矩形 ri 在已放置集合下的最小代价（忽略其它未放置矩形），无可行候选为 +∞。 */
function minCostGivenPlaced(ctx, ri, placed, placedById) {
    const id = ctx.spec.rects[ri].id;
    for (const cand of ctx.candidates[ri]) {
        if (isCompatible(ctx, toPlacement(id, cand), placed, placedById))
            return cand.cost;
    }
    return INF;
}
/** 对齐约束匹配下界：选一组矩形互不相交的约束，各自最小代价之和。 */
function matchingBound(ctx, placedById) {
    const items = [];
    for (const c of ctx.spec.align) {
        const pa = placedById.get(c.a);
        const pb = placedById.get(c.b);
        if (pa && pb)
            continue; // 放置时已强制满足
        let d;
        if (pa || pb) {
            const target = edgeValue((pa ?? pb), c.edge);
            const otherId = pa ? c.b : c.a;
            d = ctx.valueCost.get(otherId)?.get(c.edge)?.get(target) ?? INF;
        }
        else {
            d = ctx.staticAlignCost.get(c);
        }
        if (d === INF)
            return INF; // 该约束已不可能满足
        items.push({ d, a: c.a, b: c.b });
    }
    items.sort((u, v) => v.d - u.d);
    const used = new Set();
    let total = 0;
    for (const it of items) {
        if (it.d === 0)
            continue;
        if (used.has(it.a) || used.has(it.b))
            continue;
        used.add(it.a);
        used.add(it.b);
        total += it.d;
    }
    return total;
}
function nodeBound(ctx, cost, depth, placed, placedById) {
    let sum = cost;
    for (let k = depth; k < ctx.order.length; k++) {
        const m = minCostGivenPlaced(ctx, ctx.order[k], placed, placedById);
        if (m === INF)
            return INF;
        sum += m;
    }
    const mb = matchingBound(ctx, placedById);
    return Math.max(sum, mb);
}
function makeContext(spec) {
    const candidates = spec.rects.map((_, i) => buildCandidates(spec, i));
    const alignOf = new Map();
    for (const c of spec.align) {
        for (const id of [c.a, c.b]) {
            const arr = alignOf.get(id) ?? [];
            arr.push(c);
            alignOf.set(id, arr);
        }
    }
    // 每个矩形在每种相关对齐边上：边值 -> 最小移动代价
    const valueCost = new Map();
    spec.rects.forEach((r, i) => {
        const edges = new Set((alignOf.get(r.id) ?? []).map((c) => c.edge));
        const perEdge = new Map();
        for (const edge of edges) {
            const m = new Map();
            for (const cand of candidates[i]) {
                const v = edgeValue({ id: r.id, x: cand.x, y: cand.y, w: cand.w, h: cand.h }, edge);
                const prev = m.get(v);
                if (prev === undefined || cand.cost < prev)
                    m.set(v, cand.cost);
            }
            perEdge.set(edge, m);
        }
        valueCost.set(r.id, perEdge);
    });
    const staticAlignCost = new Map();
    for (const c of spec.align) {
        const ma = valueCost.get(c.a).get(c.edge);
        const mb = valueCost.get(c.b).get(c.edge);
        let best = INF;
        for (const [v, ca] of ma) {
            const cb = mb.get(v);
            if (cb !== undefined && ca + cb < best)
                best = ca + cb;
        }
        staticAlignCost.set(c, best);
    }
    // 分支顺序：候选数少者优先（其次按 id），减少浅层分支因子
    const order = spec.rects
        .map((_, i) => i)
        .sort((i, j) => candidates[i].length - candidates[j].length || spec.rects[i].id.localeCompare(spec.rects[j].id));
    return { spec, order, candidates, alignOf, valueCost, staticAlignCost };
}
/** 贪心种子：按分支顺序依次放入首个兼容候选，快速得到上界。 */
function greedySeed(ctx) {
    const placed = [];
    const placedById = new Map();
    let cost = 0;
    for (const ri of ctx.order) {
        const id = ctx.spec.rects[ri].id;
        let chosen = null;
        for (const cand of ctx.candidates[ri]) {
            const p = toPlacement(id, cand);
            if (isCompatible(ctx, p, placed, placedById)) {
                chosen = p;
                cost += cand.cost;
                break;
            }
        }
        if (!chosen)
            return null;
        placed.push(chosen);
        placedById.set(id, chosen);
    }
    return { layout: placed, cost };
}
export function solve(spec, opts = {}) {
    const budget = opts.nodeBudget ?? 2_000_000;
    const ctx = makeContext(spec);
    const n = spec.rects.length;
    let bestLayout = null;
    let ub = INF;
    const seed = greedySeed(ctx);
    if (seed) {
        bestLayout = seed.layout;
        ub = seed.cost;
    }
    const rootById = new Map();
    const rootBound = nodeBound(ctx, 0, 0, [], rootById);
    const heap = new Heap();
    let seq = 0;
    if (rootBound < ub) {
        heap.push({ bound: rootBound, cost: 0, depth: 0, seq: seq++, placed: [] });
    }
    let nodes = 0;
    let exhausted = false;
    while (heap.size > 0) {
        if (nodes >= budget) {
            exhausted = true;
            break;
        }
        const node = heap.pop();
        if (node.bound >= ub)
            continue; // 惰性删除：界已不优于现任解
        nodes++;
        const ri = ctx.order[node.depth];
        const id = spec.rects[ri].id;
        const placedById = new Map(node.placed.map((p) => [p.id, p]));
        for (const cand of ctx.candidates[ri]) {
            if (node.cost + cand.cost >= ub)
                break; // 候选按代价升序
            const p = toPlacement(id, cand);
            if (!isCompatible(ctx, p, node.placed, placedById))
                continue;
            const childPlaced = [...node.placed, p];
            const childCost = node.cost + cand.cost;
            if (node.depth + 1 === n) {
                // 完整可行解：必优于当前上界
                ub = childCost;
                bestLayout = childPlaced;
                continue;
            }
            placedById.set(id, p);
            const childBound = nodeBound(ctx, childCost, node.depth + 1, childPlaced, placedById);
            placedById.delete(id);
            if (childBound < ub) {
                heap.push({ bound: childBound, cost: childCost, depth: node.depth + 1, seq: seq++, placed: childPlaced });
            }
        }
    }
    if (bestLayout) {
        const open = heap.peek();
        if (!exhausted || open === undefined || open.bound >= ub) {
            return { status: 'optimal', layout: bestLayout, objective: ub, lowerBound: ub, upperBound: ub, nodesExplored: nodes };
        }
        return { status: 'bounded', layout: bestLayout, objective: ub, lowerBound: open.bound, upperBound: ub, nodesExplored: nodes };
    }
    if (heap.size > 0) {
        return { status: 'bounded', layout: null, objective: null, lowerBound: heap.peek().bound, upperBound: null, nodesExplored: nodes };
    }
    return { status: 'infeasible', layout: null, objective: null, lowerBound: null, upperBound: null, nodesExplored: nodes };
}
