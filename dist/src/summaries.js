import { sha256 } from "./hash.js";
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
export function summarize(source) {
    if (!NAME_RE.test(source.name)) {
        throw new Error(`invalid module name: ${JSON.stringify(source.name)}`);
    }
    return {
        name: source.name,
        ifaceHash: sha256("iface", source.iface),
        implHash: sha256("impl", source.impl),
        imports: source.imports,
    };
}
