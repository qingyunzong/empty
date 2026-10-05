/**
 * CLI: read a grammar (file argument or stdin), build the canonical LR(1)
 * automaton, report shift-reduce conflicts with the shortest symbol path to
 * each conflict state, and separately check for LALR(1)-merge artifacts.
 *
 * Usage:
 *   node dist/src/cli.js [grammar-file] [--verify]
 *   cat grammar.txt | node dist/src/cli.js
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseGrammar, formatProduction, MAX_PRODUCTIONS } from "./grammar.js";
import { CanonicalLR1, findConflicts, shortestPath, analyzeLalrMerge, describeConflict, } from "./lr1.js";
import { verifyItemSets } from "./verify.js";
function readInput(argv) {
    const args = argv.slice(2);
    const verify = args.includes("--verify");
    const files = args.filter((a) => a !== "--verify");
    if (files.length > 1) {
        throw new Error("用法：cli [文法文件] [--verify]（或不带参数从标准输入读取）");
    }
    if (files.length === 1) {
        return { text: readFileSync(files[0], "utf8"), verify };
    }
    return { text: readFileSync(0, "utf8"), verify }; // fd 0 = stdin
}
function main() {
    let input;
    try {
        input = readInput(process.argv);
    }
    catch (e) {
        process.stderr.write(`读取输入失败：${e.message}\n`);
        process.exitCode = 2;
        return;
    }
    let grammar;
    try {
        grammar = parseGrammar(input.text);
    }
    catch (e) {
        process.stderr.write(`文法错误：${e.message}\n`);
        process.exitCode = 2;
        return;
    }
    const out = [];
    out.push(`文法：${grammar.productions.length - 1} 条产生式（上限 ${MAX_PRODUCTIONS}），开始符号 ${grammar.productions[0].rhs[0]}`);
    for (let i = 1; i < grammar.productions.length; i++) {
        out.push(`  (${i}) ${formatProduction(grammar.productions[i])}`);
    }
    const auto = new CanonicalLR1(grammar);
    out.push(`规范 LR(1) 自动机：${auto.states.length} 个状态`);
    const conflicts = findConflicts(grammar, auto.states, auto.transitions);
    const sr = conflicts.filter((c) => c.kind === "shift-reduce");
    const rr = conflicts.filter((c) => c.kind === "reduce-reduce");
    if (conflicts.length === 0) {
        out.push("未发现冲突：该文法是规范 LR(1) 文法。");
    }
    else {
        out.push(`发现 ${sr.length} 个移入-归约冲突，${rr.length} 个归约-归约冲突：`);
        for (const c of conflicts) {
            out.push(describeConflict(grammar, c));
            const path = shortestPath(auto.transitions, c.stateId);
            out.push(`  到冲突状态的最短符号路径：${path.length === 0 ? "ε" : path.join(" ")}`);
        }
    }
    // LALR(1) merge check: conflicts introduced by merging are reported
    // separately and never counted as real conflicts of the grammar.
    const lalr = analyzeLalrMerge(auto);
    if (lalr.introducedConflicts.length === 0) {
        out.push(`LALR(1) 检查：合并为 ${lalr.mergedStateCount} 个状态，未引入新冲突。`);
    }
    else {
        out.push(`LALR(1) 检查：合并为 ${lalr.mergedStateCount} 个状态，合并引入 ${lalr.introducedConflicts.length} 个冲突（不计入上述原冲突）：`);
        for (const c of lalr.introducedConflicts) {
            out.push(describeConflict(grammar, c));
        }
    }
    if (input.verify) {
        const result = verifyItemSets(auto, { maxPrefixLen: 5, maxFormLen: 10 });
        if (result.ok) {
            out.push(`前缀枚举核对：通过（比较了 ${result.comparedPrefixes} 个前缀的项目集）。`);
        }
        else {
            out.push(`前缀枚举核对：失败（${result.mismatches.length} 处不一致）`);
            for (const m of result.mismatches)
                out.push(`  ${m}`);
            process.exitCode = 1;
        }
    }
    process.stdout.write(out.join("\n") + "\n");
    if (conflicts.length > 0 && process.exitCode === undefined)
        process.exitCode = 1;
}
main();
