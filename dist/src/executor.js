import { existsSync, readFileSync } from 'node:fs';
import { CacheStore, makeRecord } from './cache.js';
import { topoSort, validateStages } from './dag.js';
import { hashInputFiles, stageDigest } from './digest.js';
/**
 * Runs a stage DAG in topological order. Each stage's result is cached under
 * a digest of its full input set (stage id + input-file contents + dependency
 * outputs). On a re-run:
 *  - stages whose digest still has a valid cache record are reused;
 *  - failed stages and their descendants re-execute (they have no record);
 *  - file edits change the digest, invalidating exactly the affected subtree.
 */
export class Executor {
    byId;
    order;
    store;
    hooks;
    constructor(stages, options) {
        this.byId = validateStages(stages);
        this.order = topoSort(stages);
        this.store = new CacheStore(options.cacheDir);
        this.hooks = options.hooks ?? {};
    }
    emit(event) {
        this.hooks.onEvent?.(event);
    }
    maybeCrash(stageId, phase) {
        const at = this.hooks.crashAt;
        if (at && at.stageId === stageId && at.phase === phase) {
            (this.hooks.crash ?? (() => process.exit(1)))();
        }
    }
    async run() {
        this.store.sweep();
        const outputs = new Map();
        const poisoned = new Set(); // failed or downstream of a failure
        const stages = {};
        const digests = {};
        for (const id of this.order) {
            const stage = this.byId.get(id);
            const deps = stage.deps ?? [];
            if (deps.some((dep) => poisoned.has(dep))) {
                stages[id] = 'skipped';
                poisoned.add(id);
                this.emit({ type: 'skipped', stageId: id });
                continue;
            }
            const inputPaths = stage.inputs ?? [];
            const fileHash = hashInputFiles(inputPaths);
            const depOutputs = {};
            for (const dep of deps)
                depOutputs[dep] = outputs.get(dep);
            const digest = stageDigest(id, fileHash, depOutputs);
            digests[id] = digest;
            const hit = this.store.lookup(id, digest);
            if (hit) {
                outputs.set(id, hit.value);
                stages[id] = 'reused';
                this.emit({ type: 'reused', stageId: id, digest });
                continue;
            }
            this.maybeCrash(id, 'before-run');
            // Only stage.run() itself may turn into a stage failure. Crashes and
            // cache-publish errors propagate: they are infrastructural, and a
            // simulated power loss must bypass all cleanup/failure handling.
            let value;
            try {
                const inputs = {};
                for (const path of inputPaths) {
                    inputs[path] = existsSync(path) ? readFileSync(path, 'utf8') : null;
                }
                value = (await stage.run({ inputs, deps: depOutputs })) ?? null;
            }
            catch (err) {
                stages[id] = 'failed';
                poisoned.add(id);
                this.emit({
                    type: 'failed',
                    stageId: id,
                    digest,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            const record = makeRecord(id, digest, value);
            this.store.publish(record, {
                afterTmpWrite: () => this.maybeCrash(id, 'tmp-written'),
            });
            this.maybeCrash(id, 'after-publish');
            outputs.set(id, record.value);
            stages[id] = 'executed';
            this.emit({ type: 'executed', stageId: id, digest });
        }
        return { ok: poisoned.size === 0, stages, digests };
    }
}
