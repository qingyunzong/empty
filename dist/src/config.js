"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigStore = exports.UnterminatedPlaceholderError = exports.CycleError = exports.MissingKeyError = exports.ConfigError = void 0;
class ConfigError extends Error {
}
exports.ConfigError = ConfigError;
class MissingKeyError extends ConfigError {
    key;
    chain;
    constructor(key, chain) {
        super(`missing key "${key}" (resolving ${[...chain, key].join(" -> ")})`);
        this.name = "MissingKeyError";
        this.key = key;
        this.chain = [...chain, key];
    }
}
exports.MissingKeyError = MissingKeyError;
class CycleError extends ConfigError {
    path;
    constructor(path) {
        super(`circular reference: ${path.join(" -> ")}`);
        this.name = "CycleError";
        this.path = path;
    }
}
exports.CycleError = CycleError;
class UnterminatedPlaceholderError extends ConfigError {
    constructor(template) {
        super(`unterminated placeholder in "${template}"`);
        this.name = "UnterminatedPlaceholderError";
    }
}
exports.UnterminatedPlaceholderError = UnterminatedPlaceholderError;
function expand(template, lookup) {
    let out = "";
    let i = 0;
    while (i < template.length) {
        const ch = template[i];
        if (ch === "\\" && template[i + 1] === "$") {
            out += "$";
            i += 2;
            continue;
        }
        if (ch === "$" && template[i + 1] === "{") {
            const end = template.indexOf("}", i + 2);
            if (end === -1)
                throw new UnterminatedPlaceholderError(template);
            out += lookup(template.slice(i + 2, end));
            i = end + 1;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}
class ConfigStore {
    values = new Map();
    versions = new Map();
    cache = new Map();
    computeCounts = new Map();
    constructor(entries) {
        if (entries) {
            for (const [key, value] of Object.entries(entries))
                this.set(key, value);
        }
    }
    set(key, value) {
        this.values.set(key, value);
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    delete(key) {
        this.values.delete(key);
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    has(key) {
        return this.values.has(key);
    }
    get(key) {
        return this.resolve(key, [], true).value;
    }
    resolveUncached(key) {
        return this.resolve(key, [], false).value;
    }
    cachedKeys() {
        return [...this.cache.keys()];
    }
    versionOf(key) {
        return this.versions.get(key) ?? 0;
    }
    lookupCache(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return undefined;
        for (const [dep, version] of entry.deps) {
            if (this.versionOf(dep) !== version) {
                this.cache.delete(key);
                return undefined;
            }
        }
        return entry;
    }
    resolve(key, stack, useCache) {
        const raw = this.values.get(key);
        if (raw === undefined)
            throw new MissingKeyError(key, stack);
        if (stack.includes(key))
            throw new CycleError([...stack, key]);
        if (useCache) {
            const hit = this.lookupCache(key);
            if (hit)
                return { value: hit.value, deps: hit.deps };
        }
        if (useCache)
            this.computeCounts.set(key, (this.computeCounts.get(key) ?? 0) + 1);
        const nextStack = [...stack, key];
        const deps = new Map();
        const value = expand(raw, (name) => {
            const child = this.resolve(name, nextStack, useCache);
            for (const [dep, version] of child.deps)
                deps.set(dep, version);
            return child.value;
        });
        deps.set(key, this.versionOf(key));
        const resolved = { value, deps };
        if (useCache)
            this.cache.set(key, { value, deps });
        return resolved;
    }
}
exports.ConfigStore = ConfigStore;
