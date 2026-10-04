import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseEvents } from "./model.js";
import { sortEvents } from "./topo.js";
import { enumerateTopoOrders, containsOrder } from "./enumerate.js";
import { LogStore, parseBatch } from "./store.js";
function out(s) {
    process.stdout.write(s + "\n");
}
function printOrder(events, order) {
    const byId = new Map(events.map((e) => [e.id, e]));
    order.forEach((id, i) => {
        const e = byId.get(id);
        out(`${String(i).padStart(4)}  ts=${e.ts}  source=${e.source}  seq=${e.seq}  id=${e.id}`);
    });
}
function printEvidence(result) {
    if (result.missing.length > 0) {
        out(`\nmissing dependencies (${result.missing.length}):`);
        for (const m of result.missing)
            out(`  event ${m.eventId} depends on unknown ${m.missingDep}`);
        out(`blocked events (${result.blocked.length}): ${result.blocked.join(", ")}`);
    }
    if (result.cycles.length > 0) {
        out(`\ncycles detected (${result.cycles.length}):`);
        for (const c of result.cycles)
            out(`  ${c.join(" -> ")}`);
    }
}
function cmdSort(args) {
    const file = args[0];
    if (!file)
        throw new Error("usage: logtopo sort <file.jsonl|json> [--enumerate] [--limit N]");
    const doEnum = args.includes("--enumerate");
    const li = args.indexOf("--limit");
    const limit = li >= 0 ? Number(args[li + 1]) : 100_000;
    const events = parseEvents(readFileSync(file, "utf8"));
    const result = sortEvents(events);
    out(`topological order (${result.order.length} of ${events.length} events):`);
    printOrder(events, result.order);
    printEvidence(result);
    if (doEnum) {
        if (result.cycles.length > 0) {
            out("\nenumeration skipped: cyclic graph has no linear extension");
            return;
        }
        const en = enumerateTopoOrders(events, limit);
        out(`\nenumeration: ${en.orders.length} topological order(s) over ${en.totalNodes} orderable events` +
            (en.truncated ? ` (truncated at limit ${limit})` : ""));
        if (!en.truncated) {
            out(containsOrder(en.orders, result.order)
                ? "cross-check OK: greedy order is a valid enumerated topological order"
                : "cross-check FAILED: greedy order not found in enumeration");
        }
    }
}
function loadStore(file) {
    return LogStore.fromSnapshot(JSON.parse(readFileSync(file, "utf8")));
}
function saveStore(store, file) {
    const snap = JSON.stringify(store.toSnapshot(), null, 2);
    if (file)
        writeFileSync(file, snap);
    else
        out(snap);
}
function cmdInit(args) {
    const file = args[0];
    if (!file)
        throw new Error("usage: logtopo init <events.jsonl|json> [--out snapshot.json]");
    const oi = args.indexOf("--out");
    const store = new LogStore(parseEvents(readFileSync(file, "utf8")));
    saveStore(store, oi >= 0 ? args[oi + 1] : undefined);
}
function cmdRevise(args) {
    const [snapFile, batchFile] = args;
    const oi = args.indexOf("--out");
    if (!snapFile || !batchFile)
        throw new Error("usage: logtopo revise <snapshot.json> <batch.json> [--out snapshot.json]");
    const store = loadStore(snapFile);
    const batch = parseBatch(readFileSync(batchFile, "utf8"));
    const result = store.revise(batch);
    if (!result.accepted) {
        out("REJECTED: revision batch refused atomically");
        for (const c of result.conflicts) {
            out(`  conflict chain: ${c.chain.join(" -> ")}`);
            out(`  reason: ${c.reason}`);
        }
        for (const c of result.cycles)
            out(`  cycle: ${c.join(" -> ")}`);
        process.exitCode = 1;
        return;
    }
    out(`ACCEPTED: order now ${result.order.length} events (${store.publishedPrefix.length} published)`);
    saveStore(store, oi >= 0 ? args[oi + 1] : undefined);
}
function cmdPublish(args) {
    const [snapFile, nStr] = args;
    const oi = args.indexOf("--out");
    if (!snapFile || !nStr)
        throw new Error("usage: logtopo publish <snapshot.json> <n> [--out snapshot.json]");
    const store = loadStore(snapFile);
    store.publish(Number(nStr));
    out(`published prefix now ${store.publishedPrefix.length} events`);
    saveStore(store, oi >= 0 ? args[oi + 1] : undefined);
}
function cmdShow(args) {
    const snapFile = args[0];
    if (!snapFile)
        throw new Error("usage: logtopo show <snapshot.json>");
    const store = loadStore(snapFile);
    const snap = store.toSnapshot();
    out(`order (${snap.published.length} published + ${snap.unpublishedOrder.length} unpublished):`);
    printOrder(snap.events, [...snap.published, ...snap.unpublishedOrder]);
    out(`ready candidates: ${snap.ready.join(", ") || "(none)"}`);
    const mi = Object.entries(snap.missingIndex);
    if (mi.length > 0) {
        out("missing dependency index:");
        for (const [dep, ids] of mi)
            out(`  ${dep} <- ${ids.join(", ")}`);
    }
}
function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case "sort": return cmdSort(rest);
        case "init": return cmdInit(rest);
        case "revise": return cmdRevise(rest);
        case "publish": return cmdPublish(rest);
        case "show": return cmdShow(rest);
        default:
            out("usage: logtopo <sort|init|revise|publish|show> ...");
            process.exitCode = cmd === undefined ? 0 : 2;
    }
}
try {
    main();
}
catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 2;
}
