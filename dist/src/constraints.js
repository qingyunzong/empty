/** 约束求值：每条约束可独立判定，产出可机检的约束证书条目。 */
/** 边的坐标值；中心用 2 倍坐标表示以保持整数（2*x+w）。 */
export function edgeValue(p, edge) {
    switch (edge) {
        case 'left': return p.x;
        case 'right': return p.x + p.w;
        case 'top': return p.y;
        case 'bottom': return p.y + p.h;
        case 'hcenter': return 2 * p.x + p.w;
        case 'vcenter': return 2 * p.y + p.h;
    }
}
/** 严格相交才算重叠；边贴边（共享边界）不算重叠。 */
export function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
/** 曼哈顿移动距离（只对位置计费）。 */
export function movementCost(r, p) {
    return Math.abs(p.x - r.oldX) + Math.abs(p.y - r.oldY);
}
export function totalMovement(spec, layout) {
    const byId = new Map(spec.rects.map((r) => [r.id, r]));
    let total = 0;
    for (const p of layout) {
        const r = byId.get(p.id);
        if (r)
            total += movementCost(r, p);
    }
    return total;
}
/** 只检查可判定的约束：已放置矩形的尺寸/边界、已放置对之间的不重叠与对齐。 */
export function checkPartial(spec, layout) {
    const checks = [];
    const byId = new Map(layout.map((p) => [p.id, p]));
    const specById = new Map(spec.rects.map((r) => [r.id, r]));
    for (const p of layout) {
        const r = specById.get(p.id);
        if (!r) {
            checks.push({ id: `unknown:${p.id}`, kind: 'size', satisfied: false, detail: `未知矩形 ${p.id}` });
            continue;
        }
        const ints = [p.x, p.y, p.w, p.h].every(Number.isInteger);
        const sizeOk = ints && r.minW <= p.w && p.w <= r.maxW && r.minH <= p.h && p.h <= r.maxH;
        checks.push({
            id: `size:${r.id}`,
            kind: 'size',
            satisfied: sizeOk,
            detail: sizeOk
                ? `${r.id}: ${p.w}x${p.h} 在 [${r.minW}..${r.maxW}]x[${r.minH}..${r.maxH}] 内`
                : `${r.id}: ${p.w}x${p.h} 超出尺寸范围或非整数`,
        });
        const boundsOk = ints && p.x >= 0 && p.y >= 0 && p.x + p.w <= spec.grid && p.y + p.h <= spec.grid;
        checks.push({
            id: `bounds:${r.id}`,
            kind: 'bounds',
            satisfied: boundsOk,
            detail: boundsOk
                ? `${r.id}: (${p.x},${p.y})+${p.w}x${p.h} 在 ${spec.grid} 网格内`
                : `${r.id}: (${p.x},${p.y})+${p.w}x${p.h} 越出 ${spec.grid} 网格`,
        });
    }
    for (let i = 0; i < layout.length; i++) {
        for (let j = i + 1; j < layout.length; j++) {
            const a = layout[i];
            const b = layout[j];
            const okNoOverlap = !overlaps(a, b);
            checks.push({
                id: `nooverlap:${a.id}#${b.id}`,
                kind: 'nooverlap',
                satisfied: okNoOverlap,
                detail: okNoOverlap
                    ? `${a.id} 与 ${b.id} 不重叠`
                    : `${a.id} 与 ${b.id} 重叠: (${a.x},${a.y},${a.w},${a.h}) vs (${b.x},${b.y},${b.w},${b.h})`,
            });
        }
    }
    for (const c of spec.align) {
        const a = byId.get(c.a);
        const b = byId.get(c.b);
        if (!a || !b)
            continue;
        const va = edgeValue(a, c.edge);
        const vb = edgeValue(b, c.edge);
        const scale = c.edge === 'hcenter' || c.edge === 'vcenter' ? ' (2倍坐标)' : '';
        checks.push({
            id: `align:${c.a}~${c.b}:${c.edge}`,
            kind: 'align',
            satisfied: va === vb,
            detail: va === vb
                ? `${c.a}.${c.edge} == ${c.b}.${c.edge} == ${va}${scale}`
                : `${c.a}.${c.edge}=${va} != ${c.b}.${c.edge}=${vb}${scale}`,
        });
    }
    return checks;
}
/** 完整布局检查：要求恰好覆盖 spec 中每个矩形一次，且全部约束可判定。 */
export function checkLayout(spec, layout) {
    const checks = [];
    const seen = new Set();
    for (const p of layout) {
        if (seen.has(p.id)) {
            checks.push({ id: `duplicate:${p.id}`, kind: 'size', satisfied: false, detail: `矩形 ${p.id} 被放置多次` });
        }
        seen.add(p.id);
    }
    for (const r of spec.rects) {
        if (!seen.has(r.id)) {
            checks.push({ id: `present:${r.id}`, kind: 'size', satisfied: false, detail: `缺少矩形 ${r.id} 的放置` });
        }
    }
    return [...checks, ...checkPartial(spec, layout)];
}
export function allSatisfied(checks) {
    return checks.every((c) => c.satisfied);
}
