function isObj(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function parseEvent(v, where) {
    if (!isObj(v))
        throw new Error(`${where}: event must be an object`);
    const { id, source, seq, ts, deps } = v;
    if (typeof id !== "string" || id === "")
        throw new Error(`${where}: "id" must be a non-empty string`);
    if (typeof source !== "string" || source === "")
        throw new Error(`${where}: "source" must be a non-empty string`);
    if (typeof seq !== "number" || !Number.isInteger(seq))
        throw new Error(`${where}: "seq" must be an integer`);
    if (typeof ts !== "number" || !Number.isFinite(ts))
        throw new Error(`${where}: "ts" must be a finite number`);
    if (deps !== undefined && !(Array.isArray(deps) && deps.every((d) => typeof d === "string")))
        throw new Error(`${where}: "deps" must be an array of strings`);
    return { id, source, seq, ts, deps: deps ?? [] };
}
/** Parse a log file: JSONL (one event per line) or a JSON array of events. */
export function parseEvents(text) {
    const trimmed = text.trim();
    if (trimmed === "")
        return [];
    if (trimmed.startsWith("[")) {
        const arr = JSON.parse(trimmed);
        if (!Array.isArray(arr))
            throw new Error("input JSON must be an array of events");
        return arr.map((v, i) => parseEvent(v, `event[${i}]`));
    }
    const events = [];
    trimmed.split(/\r?\n/).forEach((line, i) => {
        const l = line.trim();
        if (l === "" || l.startsWith("#"))
            return;
        events.push(parseEvent(JSON.parse(l), `line ${i + 1}`));
    });
    return events;
}
/** Deterministic candidate priority: smallest (ts, source, seq, id) first. */
export function compareCandidate(a, b) {
    if (a.ts !== b.ts)
        return a.ts - b.ts;
    if (a.source !== b.source)
        return a.source < b.source ? -1 : 1;
    if (a.seq !== b.seq)
        return a.seq - b.seq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
