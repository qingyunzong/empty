/**
 * Core planning model.
 *
 * State = up to 12 boolean bits plus a finite vector of bounded integer
 * resources. Actions have preconditions and (possibly conditional) effects.
 * All effects of one action are evaluated against the OLD state and applied
 * simultaneously; conflicting assignments to the same bit are rejected
 * (MutexError), both statically at load time and dynamically at apply time.
 */
export const MAX_BITS = 12;
export class ProblemError extends Error {
}
export class MutexError extends Error {
    action;
    bit;
    constructor(message, action, bit) {
        super(message);
        this.action = action;
        this.bit = bit;
    }
}
// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
export function initialState(p) {
    return { bits: p.initialBits, res: p.resources.map((r) => r.initial) };
}
export function stateKey(s) {
    return s.res.length === 0 ? `${s.bits}` : `${s.bits}|${s.res.join(",")}`;
}
export function bitOf(s, i) {
    return ((s.bits >>> i) & 1);
}
// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
function cmp(op, lhs, rhs) {
    switch (op) {
        case ">=": return lhs >= rhs;
        case "<=": return lhs <= rhs;
        case "==": return lhs === rhs;
        case "!=": return lhs !== rhs;
        case ">": return lhs > rhs;
        case "<": return lhs < rhs;
    }
}
export function holds(cond, s) {
    if (!cond)
        return true;
    if (cond.bits) {
        for (const [k, v] of Object.entries(cond.bits)) {
            if (bitOf(s, Number(k)) !== v)
                return false;
        }
    }
    if (cond.resources) {
        for (const rc of cond.resources) {
            if (!cmp(rc.op, s.res[rc.index] ?? 0, rc.value))
                return false;
        }
    }
    return true;
}
export function isGoal(p, s) {
    return holds(p.goal, s);
}
// ---------------------------------------------------------------------------
// Action application: simultaneous effects evaluated on the OLD state.
// ---------------------------------------------------------------------------
export function applicable(p, s, a) {
    return holds(a.pre, s);
}
/**
 * Apply an action. Returns null when preconditions fail or a resource bound
 * would be violated. Throws MutexError when simultaneously fired effects
 * assign conflicting values to the same bit.
 */
export function applyAction(p, s, a) {
    if (!applicable(p, s, a))
        return null;
    const assign = new Map();
    const delta = new Array(p.resources.length).fill(0);
    for (const eff of a.effects) {
        if (eff.when && !holds(eff.when, s))
            continue; // evaluated on OLD state
        if (eff.set) {
            for (const [k, v] of Object.entries(eff.set)) {
                const bit = Number(k);
                const prev = assign.get(bit);
                if (prev !== undefined && prev !== v) {
                    throw new MutexError(`action "${a.name}" assigns bit ${bit} both ${prev} and ${v}`, a.name, bit);
                }
                assign.set(bit, v);
            }
        }
        if (eff.res) {
            for (const rd of eff.res)
                delta[rd.index] = (delta[rd.index] ?? 0) + rd.delta;
        }
    }
    let bits = s.bits;
    for (const [bit, v] of assign) {
        bits = v === 1 ? bits | (1 << bit) : bits & ~(1 << bit);
    }
    const res = s.res.map((old, i) => {
        const next = old + (delta[i] ?? 0);
        const def = p.resources[i];
        if (def && (next < 0 || next > def.max))
            return Number.NaN;
        return next;
    });
    if (res.some((r) => Number.isNaN(r)))
        return null; // resource bound violated
    return { bits, res };
}
/** Successor states in deterministic (file) action order. */
export function successors(p, s) {
    const out = [];
    for (const a of p.actions) {
        const next = applyAction(p, s, a);
        if (next)
            out.push({ action: a, state: next });
    }
    return out;
}
// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------
function isObj(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseBitMap(v, numBits, where) {
    if (!isObj(v))
        throw new ProblemError(`${where}: expected object of bit assignments`);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        const bit = Number(k);
        if (!Number.isInteger(bit) || bit < 0 || bit >= numBits) {
            throw new ProblemError(`${where}: bit index "${k}" out of range 0..${numBits - 1}`);
        }
        if (val !== 0 && val !== 1)
            throw new ProblemError(`${where}: bit ${k} must be 0 or 1`);
        out[k] = val;
    }
    return out;
}
function parseCondition(v, numBits, numRes, where) {
    if (v === undefined)
        return {};
    if (!isObj(v))
        throw new ProblemError(`${where}: condition must be an object`);
    const cond = {};
    if (v.bits !== undefined)
        cond.bits = parseBitMap(v.bits, numBits, `${where}.bits`);
    if (v.resources !== undefined) {
        if (!Array.isArray(v.resources))
            throw new ProblemError(`${where}.resources: expected array`);
        cond.resources = v.resources.map((rc, i) => parseResCond(rc, numRes, `${where}.resources[${i}]`));
    }
    return cond;
}
const OPS = [">=", "<=", "==", "!=", ">", "<"];
function parseResCond(v, numRes, where) {
    if (!isObj(v))
        throw new ProblemError(`${where}: expected object`);
    const index = v.index;
    if (!Number.isInteger(index) || index < 0 || index >= numRes) {
        throw new ProblemError(`${where}: resource index out of range`);
    }
    if (typeof v.op !== "string" || !OPS.includes(v.op)) {
        throw new ProblemError(`${where}: bad op ${String(v.op)}`);
    }
    if (typeof v.value !== "number" || !Number.isInteger(v.value)) {
        throw new ProblemError(`${where}: value must be an integer`);
    }
    return { index: index, op: v.op, value: v.value };
}
function parseEffect(v, numBits, numRes, where) {
    if (!isObj(v))
        throw new ProblemError(`${where}: effect must be an object`);
    const eff = {};
    if (v.when !== undefined)
        eff.when = parseCondition(v.when, numBits, numRes, `${where}.when`);
    if (v.set !== undefined)
        eff.set = parseBitMap(v.set, numBits, `${where}.set`);
    if (v.res !== undefined) {
        if (!Array.isArray(v.res))
            throw new ProblemError(`${where}.res: expected array`);
        eff.res = v.res.map((rd, i) => {
            if (!isObj(rd))
                throw new ProblemError(`${where}.res[${i}]: expected object`);
            const index = rd.index;
            if (!Number.isInteger(index) || index < 0 || index >= numRes) {
                throw new ProblemError(`${where}.res[${i}]: resource index out of range`);
            }
            if (typeof rd.delta !== "number" || !Number.isInteger(rd.delta)) {
                throw new ProblemError(`${where}.res[${i}]: delta must be an integer`);
            }
            return { index: index, delta: rd.delta };
        });
    }
    if (!eff.set && !eff.res)
        throw new ProblemError(`${where}: effect needs "set" and/or "res"`);
    return eff;
}
/** True when two conditions cannot hold simultaneously (bit contradiction). */
function conditionsContradict(a, b) {
    if (!a?.bits || !b?.bits)
        return false;
    for (const [k, v] of Object.entries(a.bits)) {
        const other = b.bits[k];
        if (other !== undefined && other !== v)
            return true;
    }
    return false;
}
/** Reject actions whose effects can fire simultaneously with conflicting bit writes. */
function checkStaticMutex(a) {
    for (let i = 0; i < a.effects.length; i++) {
        for (let j = i + 1; j < a.effects.length; j++) {
            const ei = a.effects[i];
            const ej = a.effects[j];
            if (!ei.set || !ej.set)
                continue;
            for (const [k, vi] of Object.entries(ei.set)) {
                const vj = ej.set[k];
                if (vj === undefined || vj === vi)
                    continue;
                if (!conditionsContradict(ei.when, ej.when)) {
                    throw new ProblemError(`action "${a.name}": effects ${i} and ${j} can fire together and conflict on bit ${k} (mutex rejected)`);
                }
            }
        }
    }
}
export function parseProblem(raw) {
    if (!isObj(raw))
        throw new ProblemError("problem must be a JSON object");
    const numBits = raw.numBits;
    if (!Number.isInteger(numBits) || numBits < 1 || numBits > MAX_BITS) {
        throw new ProblemError(`numBits must be an integer in 1..${MAX_BITS}`);
    }
    const nb = numBits;
    const resources = [];
    if (raw.resources !== undefined) {
        if (!Array.isArray(raw.resources))
            throw new ProblemError("resources must be an array");
        for (const [i, r] of raw.resources.entries()) {
            if (!isObj(r))
                throw new ProblemError(`resources[${i}]: expected object`);
            if (typeof r.name !== "string")
                throw new ProblemError(`resources[${i}]: name required`);
            if (!Number.isInteger(r.max) || r.max < 0) {
                throw new ProblemError(`resources[${i}]: max must be a non-negative integer`);
            }
            if (!Number.isInteger(r.initial) || r.initial < 0 || r.initial > r.max) {
                throw new ProblemError(`resources[${i}]: initial must be in 0..max`);
            }
            resources.push({ name: r.name, max: r.max, initial: r.initial });
        }
    }
    let initialRaw = raw.initialBits ?? 0;
    if (raw.initial !== undefined) {
        if (!isObj(raw.initial))
            throw new ProblemError("initial must be an object");
        initialRaw = raw.initial.bits ?? 0;
    }
    if (!Number.isInteger(initialRaw) || initialRaw < 0 || initialRaw >= (1 << nb)) {
        throw new ProblemError("initial bits must be an integer bitmask within numBits");
    }
    const initialBits = initialRaw;
    const goal = parseCondition(raw.goal, nb, resources.length, "goal");
    if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
        throw new ProblemError("actions must be a non-empty array");
    }
    const names = new Set();
    const actions = raw.actions.map((av, i) => {
        const where = `actions[${i}]`;
        if (!isObj(av))
            throw new ProblemError(`${where}: expected object`);
        if (typeof av.name !== "string" || av.name.length === 0) {
            throw new ProblemError(`${where}: name required`);
        }
        if (names.has(av.name))
            throw new ProblemError(`${where}: duplicate action name "${av.name}"`);
        names.add(av.name);
        if (!Array.isArray(av.effects) || av.effects.length === 0) {
            throw new ProblemError(`${where}: effects must be a non-empty array`);
        }
        const action = {
            name: av.name,
            pre: parseCondition(av.pre, nb, resources.length, `${where}.pre`),
            effects: av.effects.map((e, j) => parseEffect(e, nb, resources.length, `${where}.effects[${j}]`)),
        };
        checkStaticMutex(action);
        return action;
    });
    return {
        name: typeof raw.name === "string" ? raw.name : "unnamed",
        numBits: nb,
        resources,
        initialBits,
        goal,
        actions,
    };
}
