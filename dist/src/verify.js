/**
 * Independent verification of LR(1) item sets by brute-force enumeration of
 * rightmost derivations ("枚举前缀核对项目集").
 *
 * Definition: item [A -> α·β, a] is valid for viable prefix γ iff there is a
 * rightmost derivation  S' ⇒* δAaw ⇒ δαβaw  with γ = δα and a = first(w$).
 *
 * We enumerate all rightmost sentential forms up to a length bound, record
 * the valid items for every prefix γ that appears, and compare against the
 * item set the automaton reaches by following γ from state 0.
 */
import { EOF } from "./grammar.js";
import { followPath, itemKey } from "./lr1.js";
/** Enumerate valid items per viable prefix via rightmost derivations. */
export function enumerateValidItems(grammar, opts) {
    // key: prefix symbols joined by "" ; value: set of item keys
    const valid = new Map();
    const prodsByLhs = new Map();
    grammar.productions.forEach((p, i) => {
        const list = prodsByLhs.get(p.lhs) ?? [];
        list.push(i);
        prodsByLhs.set(p.lhs, list);
    });
    const addItem = (prefix, it) => {
        if (prefix.length > opts.maxPrefixLen)
            return;
        const key = prefix.join(" ");
        let set = valid.get(key);
        if (!set) {
            set = new Set();
            valid.set(key, set);
        }
        set.add(itemKey(it));
    };
    // BFS over rightmost sentential forms. A form is an array of symbols.
    const start = [grammar.start];
    const seen = new Set([start.join(" ")]);
    const queue = [start];
    while (queue.length > 0) {
        const form = queue.shift();
        // find rightmost nonterminal; suffix after it must be all terminals
        let rnIdx = -1;
        for (let i = form.length - 1; i >= 0; i--) {
            if (grammar.nonterminals.has(form[i])) {
                rnIdx = i;
                break;
            }
        }
        if (rnIdx === -1)
            continue; // all terminals: sentence, nothing to expand
        const A = form[rnIdx];
        const delta = form.slice(0, rnIdx);
        const w = form.slice(rnIdx + 1); // terminal suffix
        const la = w.length > 0 ? w[0] : EOF;
        for (const prodIdx of prodsByLhs.get(A) ?? []) {
            const rhs = grammar.productions[prodIdx].rhs;
            // every split rhs = αβ gives a valid item [A -> α·β, la] for prefix δα
            for (let dot = 0; dot <= rhs.length; dot++) {
                const prefix = [...delta, ...rhs.slice(0, dot)];
                addItem(prefix, { prod: prodIdx, dot, la });
            }
            // continue the derivation: δ rhs w
            const next = [...delta, ...rhs, ...w];
            if (next.length > opts.maxFormLen)
                continue;
            const key = next.join(" ");
            if (!seen.has(key)) {
                seen.add(key);
                queue.push(next);
            }
        }
    }
    return valid;
}
/**
 * Compare the automaton's item sets against the enumeration for every prefix
 * the automaton can follow within the length bound.
 */
export function verifyItemSets(auto, opts) {
    const valid = enumerateValidItems(auto.grammar, opts);
    const mismatches = [];
    let compared = 0;
    for (const [prefixKey, expected] of valid) {
        const path = prefixKey === "" ? [] : prefixKey.split(" ");
        const stateId = followPath(auto.transitions, path);
        const label = path.length === 0 ? "ε" : path.join(" ");
        if (stateId === null) {
            mismatches.push(`前缀 '${label}'：自动机无法沿该路径前进`);
            continue;
        }
        const actual = new Set(auto.states[stateId].keys());
        compared++;
        const missing = [...expected].filter((k) => !actual.has(k));
        const extra = [...actual].filter((k) => !expected.has(k));
        if (missing.length > 0 || extra.length > 0) {
            mismatches.push(`前缀 '${label}'：枚举多出 ${missing.length} 项，自动机多出 ${extra.length} 项` +
                (missing.length ? `\n    枚举有而自动机无: ${missing.join(", ")}` : "") +
                (extra.length ? `\n    自动机有而枚举无: ${extra.join(", ")}` : ""));
        }
    }
    return { ok: mismatches.length === 0, comparedPrefixes: compared, mismatches };
}
