import { sha256 } from "./hash.js";
function computeManifest(modules, components) {
    const parts = [];
    for (const name of Object.keys(modules).sort()) {
        const m = modules[name];
        parts.push(`mod:${name}:${m.ifaceHash}:${m.implHash}:${[...m.imports].sort().join(",")}`);
    }
    for (const id of Object.keys(components).sort()) {
        const c = components[id];
        parts.push(`comp:${id}:${c.key}:${c.artifact}`);
    }
    return sha256("manifest", ...parts);
}
export function makeBaseline(result) {
    const modules = {};
    for (const s of result.summaries) {
        modules[s.name] = { ifaceHash: s.ifaceHash, implHash: s.implHash, imports: s.imports };
    }
    const components = {};
    for (const plan of result.plans) {
        components[plan.id] = {
            members: plan.members,
            key: plan.key,
            artifact: result.artifacts.get(plan.id),
        };
    }
    return { version: 1, modules, components, manifest: computeManifest(modules, components) };
}
/**
 * Verify an old task's baseline against the artifact store. Every invalid
 * entry is evicted so the next build recompiles exactly those components.
 */
export function resumeBaseline(baseline, store) {
    const problems = [];
    const evicted = [];
    if (computeManifest(baseline.modules, baseline.components) !== baseline.manifest) {
        problems.push("manifest mismatch: baseline was tampered with or corrupted");
    }
    for (const [id, component] of Object.entries(baseline.components)) {
        const stored = store.get(component.key);
        if (stored === undefined) {
            problems.push(`component ${id}: artifact missing from store`);
            evicted.push(id);
        }
        else if (stored !== component.artifact) {
            problems.push(`component ${id}: artifact hash mismatch, evicting`);
            store.delete(component.key);
            evicted.push(id);
        }
    }
    return { ok: problems.length === 0, problems, evicted };
}
