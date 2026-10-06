"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Scope = void 0;
/**
 * Variable environment. Reads/writes go through hooks so tests can
 * trace evaluation order with side effects.
 */
class Scope {
    hooks;
    vars = new Map();
    constructor(initial = {}, hooks = {}) {
        this.hooks = hooks;
        for (const [key, value] of Object.entries(initial))
            this.vars.set(key, value);
    }
    has(name) {
        return this.vars.has(name);
    }
    get(name) {
        if (!this.vars.has(name))
            throw new ReferenceError(`${name} is not defined`);
        const value = this.vars.get(name);
        this.hooks.onRead?.(name, value);
        return value;
    }
    set(name, value) {
        this.hooks.onWrite?.(name, value);
        this.vars.set(name, value);
    }
    snapshot() {
        return Object.fromEntries(this.vars);
    }
}
exports.Scope = Scope;
