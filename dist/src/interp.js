/**
 * tail-safe-interp: a small tree-walking interpreter implemented as an
 * explicit stack machine (trampoline). The host (JS) call stack is never
 * consumed by guest recursion, so arbitrarily deep guest recursion is safe.
 *
 * Semantics implemented:
 *  - functions (named, recursive, mutually recursive), let, if, begin
 *  - throw / try-catch / try-finally
 *  - proper tail calls: a call in tail position reuses the caller's frame
 *    (same frame id) *only if* the caller has no pending finally/catch
 *    handler; otherwise a fresh frame is allocated
 *  - a finally block that throws overrides the original outcome (value or
 *    in-flight exception)
 *  - frame metering: allocated / reused / maxDepth
 *  - uncaught exceptions carry an explicit unwind trace of frame references
 *    ({ id, name }) in unwind order, innermost first
 */
/* ------------------------------- builders ------------------------------- */
export const lit = (v) => ({ t: 'lit', v });
export const sym = (name) => ({ t: 'sym', name });
export const if_ = (c, a, b) => ({ t: 'if', c, a, b });
export const begin = (...xs) => ({ t: 'begin', xs });
export const let_ = (name, v, body) => ({
    t: 'let',
    name,
    v,
    body,
});
export const call = (fn, ...args) => ({
    t: 'call',
    fn,
    args,
});
export const op = (name, ...args) => ({
    t: 'builtin',
    name,
    args,
});
export const throw_ = (e) => ({ t: 'throw', e });
export const try_ = (body, opts = {}) => ({
    t: 'try',
    body,
    catchVar: opts.catchVar,
    catchBody: opts.catchBody,
    finallyBody: opts.finallyBody,
});
export const fn = (name, params, body) => ({
    name,
    params,
    body,
});
/** A guest-level exception that escaped the program (uncaught). */
export class ScriptError extends Error {
    value;
    /** Frames unwound by this exception, innermost first. */
    trace = [];
    constructor(value) {
        super(`Uncaught script exception: ${JSON.stringify(value)}`);
        this.name = 'ScriptError';
        this.value = value;
    }
}
/* ------------------------------ machine core ---------------------------- */
class Env {
    parent;
    vars = new Map();
    constructor(parent) {
        this.parent = parent;
    }
    lookup(name) {
        let env = this;
        while (env !== null) {
            const v = env.vars.get(name);
            if (v !== undefined)
                return v;
            env = env.parent;
        }
        throw new Error(`Unbound variable: ${name}`);
    }
}
export function run(program, options = {}) {
    const defs = new Map(program.defs.map((d) => [d.name, d]));
    const metrics = { allocated: 0, reused: 0, maxDepth: 0 };
    const output = [];
    const fuelLimit = options.fuel ?? Number.POSITIVE_INFINITY;
    let fuel = 0;
    let nextFrameId = 1;
    const frames = [];
    let acc = null;
    let exc = null;
    const pushFrame = (name) => {
        const frame = { id: nextFrameId++, name, konts: [] };
        frames.push(frame);
        metrics.allocated++;
        if (frames.length > metrics.maxDepth)
            metrics.maxDepth = frames.length;
        return frame;
    };
    const pushExpr = (frame, node, env) => {
        frame.konts.push({ k: 'expr', node, env });
    };
    const applyBuiltin = (name, vals) => {
        switch (name) {
            case '=': return vals[0] === vals[1];
            case 'not': return !vals[0];
            case 'log':
                output.push(vals[0] ?? null);
                return null;
        }
        const nums = vals.map((v) => {
            if (typeof v !== 'number')
                throw new Error(`Builtin ${name} expects numbers, got ${JSON.stringify(v)}`);
            return v;
        });
        switch (name) {
            case '+': return nums.reduce((a, b) => a + b, 0);
            case '-': return nums.length === 1 ? -nums[0] : nums.reduce((a, b) => a - b);
            case '*': return nums.reduce((a, b) => a * b, 1);
            case '<': return nums[0] < nums[1];
            case '>': return nums[0] > nums[1];
            case '<=': return nums[0] <= nums[1];
            default: throw new Error(`Unknown builtin: ${name}`);
        }
    };
    const invoke = (name, args) => {
        const def = defs.get(name);
        if (!def)
            throw new Error(`Unknown function: ${name}`);
        if (def.params.length !== args.length)
            throw new Error(`Arity mismatch calling ${name}: want ${def.params.length}, got ${args.length}`);
        const env = new Env(null);
        def.params.forEach((p, i) => env.vars.set(p, args[i]));
        const caller = frames[frames.length - 1];
        // A call is a proper tail call iff nothing remains to do in the caller
        // frame — in particular no pending finally (or catch) handler. Only then
        // may the caller's frame be reused; otherwise a fresh frame is allocated
        // so the pending handler still runs after the callee returns/throws.
        if (caller.konts.length === 0) {
            caller.name = name;
            metrics.reused++;
            pushExpr(caller, def.body, env);
        }
        else {
            const frame = pushFrame(name);
            pushExpr(frame, def.body, env);
        }
    };
    const evalNode = (frame, node, env) => {
        switch (node.t) {
            case 'lit':
                acc = node.v;
                break;
            case 'sym':
                acc = env.lookup(node.name);
                break;
            case 'if':
                frame.konts.push({ k: 'if', a: node.a, b: node.b, env });
                pushExpr(frame, node.c, env);
                break;
            case 'begin': {
                if (node.xs.length === 0) {
                    acc = null;
                    break;
                }
                const [first, ...rest] = node.xs;
                if (rest.length > 0)
                    frame.konts.push({ k: 'begin', rest, env });
                pushExpr(frame, first, env);
                break;
            }
            case 'let':
                frame.konts.push({ k: 'let', name: node.name, body: node.body, env });
                pushExpr(frame, node.v, env);
                break;
            case 'call':
            case 'builtin': {
                const isCall = node.t === 'call';
                const name = isCall ? node.fn : node.name;
                if (node.args.length === 0) {
                    if (isCall)
                        invoke(name, []);
                    else
                        acc = applyBuiltin(name, []);
                    break;
                }
                const [first, ...rest] = node.args;
                frame.konts.push({
                    k: 'args',
                    fn: isCall ? name : null,
                    builtin: isCall ? null : name,
                    nodes: rest,
                    vals: [],
                    env,
                });
                pushExpr(frame, first, env);
                break;
            }
            case 'throw':
                frame.konts.push({ k: 'throw' });
                pushExpr(frame, node.e, env);
                break;
            case 'try':
                // Stack order (bottom -> top): finally, catch, body. An exception in
                // the body meets the catch first; an exception escaping the catch
                // body then meets the finally.
                if (node.finallyBody !== undefined)
                    frame.konts.push({ k: 'finally', body: node.finallyBody, env });
                if (node.catchBody !== undefined && node.catchVar !== undefined)
                    frame.konts.push({
                        k: 'catch',
                        varName: node.catchVar,
                        body: node.catchBody,
                        env,
                    });
                pushExpr(frame, node.body, env);
                break;
        }
    };
    pushExpr(pushFrame('<main>'), program.main, new Env(null));
    for (;;) {
        if (++fuel > fuelLimit)
            throw new Error('Fuel exhausted');
        if (exc !== null) {
            const pendingExc = exc;
            // Unwinding: walk the current frame's konts for the nearest handler.
            const frame = frames[frames.length - 1];
            let handled = false;
            while (frame.konts.length > 0) {
                const kont = frame.konts.pop();
                if (kont.k === 'catch') {
                    exc = null;
                    const child = new Env(kont.env);
                    child.vars.set(kont.varName, pendingExc.value);
                    pushExpr(frame, kont.body, child);
                    handled = true;
                    break;
                }
                if (kont.k === 'finally') {
                    exc = null;
                    // Run the finally body, then rethrow the original exception —
                    // unless the finally body itself throws, in which case the new
                    // exception discards this resume kont and overrides the old one.
                    frame.konts.push({ k: 'resume', outcome: { ok: false, error: pendingExc } });
                    pushExpr(frame, kont.body, kont.env);
                    handled = true;
                    break;
                }
            }
            if (!handled) {
                pendingExc.trace.push({ id: frame.id, name: frame.name });
                frames.pop();
                if (frames.length === 0)
                    throw pendingExc;
            }
            continue;
        }
        const frame = frames[frames.length - 1];
        const kont = frame.konts.pop();
        if (kont === undefined) {
            // Frame finished: its value is in acc, return to the caller.
            frames.pop();
            if (frames.length === 0)
                return { value: acc, metrics, output };
            continue;
        }
        switch (kont.k) {
            case 'expr':
                evalNode(frame, kont.node, kont.env);
                break;
            case 'if':
                pushExpr(frame, acc ? kont.a : kont.b, kont.env);
                break;
            case 'begin': {
                const [first, ...rest] = kont.rest;
                if (first === undefined)
                    break;
                if (rest.length > 0)
                    frame.konts.push({ k: 'begin', rest, env: kont.env });
                pushExpr(frame, first, kont.env);
                break;
            }
            case 'let': {
                const child = new Env(kont.env);
                child.vars.set(kont.name, acc);
                pushExpr(frame, kont.body, child);
                break;
            }
            case 'args': {
                const vals = [...kont.vals, acc];
                const [first, ...rest] = kont.nodes;
                if (first !== undefined) {
                    frame.konts.push({ ...kont, nodes: rest, vals });
                    pushExpr(frame, first, kont.env);
                }
                else if (kont.builtin !== null) {
                    acc = applyBuiltin(kont.builtin, vals);
                }
                else {
                    invoke(kont.fn, vals);
                }
                break;
            }
            case 'throw':
                exc = new ScriptError(acc);
                break;
            case 'catch':
                // Body completed normally: discard the handler.
                break;
            case 'finally':
                // Body completed normally: run the finally body, then resume acc.
                frame.konts.push({ k: 'resume', outcome: { ok: true, value: acc } });
                pushExpr(frame, kont.body, kont.env);
                break;
            case 'resume':
                if (kont.outcome.ok)
                    acc = kont.outcome.value;
                else
                    exc = kont.outcome.error;
                break;
        }
    }
}
