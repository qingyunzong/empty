import { assertMonotone, evaluate, referencedFields, } from './expr.js';
/**
 * Least fixed point of the visibility operator, computed by monotone
 * iteration starting from the all-hidden state. Each round evaluates all
 * still-hidden fields against the visible set of the previous round
 * (round-atomic), so the visible set only grows.
 */
export function computeVisibility(fields, values) {
    const visible = new Set();
    const rounds = [];
    for (;;) {
        const ctx = { values, visible };
        const revealed = fields
            .filter((f) => !visible.has(f.name) && evaluate(f.condition, ctx))
            .map((f) => f.name);
        if (revealed.length === 0)
            break;
        for (const name of revealed)
            visible.add(name);
        rounds.push({
            round: rounds.length + 1,
            revealed,
            visibleAfter: [...visible].sort(),
        });
    }
    return { visible, rounds };
}
export class UnknownFieldError extends Error {
    constructor(name) {
        super(`Unknown field: "${name}"`);
        this.name = 'UnknownFieldError';
    }
}
export class Form {
    fields;
    fieldNames;
    values;
    state;
    constructor(fields, initialValues = {}) {
        const names = new Set();
        for (const f of fields) {
            if (names.has(f.name)) {
                throw new Error(`Duplicate field name: "${f.name}"`);
            }
            names.add(f.name);
        }
        for (const f of fields) {
            assertMonotone(f.condition);
            for (const ref of referencedFields(f.condition)) {
                if (!names.has(ref)) {
                    throw new UnknownFieldError(ref);
                }
            }
        }
        for (const key of Object.keys(initialValues)) {
            if (!names.has(key))
                throw new UnknownFieldError(key);
        }
        this.fields = fields;
        this.fieldNames = names;
        this.values = { ...initialValues };
        this.state = computeVisibility(this.fields, this.values);
    }
    get visible() {
        return this.state.visible;
    }
    isVisible(name) {
        return this.state.visible.has(name);
    }
    /** Value as seen by consumers: hidden fields are unfilled (undefined). */
    effectiveValue(name) {
        if (!this.fieldNames.has(name))
            throw new UnknownFieldError(name);
        return this.state.visible.has(name) ? this.values[name] : undefined;
    }
    effectiveValues() {
        const out = {};
        for (const f of this.fields)
            out[f.name] = this.effectiveValue(f.name);
        return out;
    }
    /**
     * Applies a whole batch of value changes atomically: the patch is merged
     * first, then visibility is recomputed exactly once as a least fixed
     * point from the all-hidden state. Returns the per-round changes of that
     * iteration plus the diff against the previous state.
     */
    applyBatch(patch) {
        const next = { ...this.values };
        for (const [key, value] of Object.entries(patch)) {
            if (!this.fieldNames.has(key))
                throw new UnknownFieldError(key);
            if (value === undefined)
                delete next[key];
            else
                next[key] = value;
        }
        const result = computeVisibility(this.fields, next);
        const becameVisible = [...result.visible]
            .filter((f) => !this.state.visible.has(f))
            .sort();
        const becameHidden = [...this.state.visible]
            .filter((f) => !result.visible.has(f))
            .sort();
        this.values = next;
        this.state = result;
        return { ...result, becameVisible, becameHidden };
    }
}
