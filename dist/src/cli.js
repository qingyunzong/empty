"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * CLI：
 *   node dist/src/cli.js problem.json [--checkpoint FILE] [--max-nodes N]
 * 若 checkpoint 文件存在则从中恢复；--max-nodes 为本次调用最多新扩展的节点数；
 * 未跑完且指定了 --checkpoint 时保存断点。
 * 输出 JSON：用量、收益、分配向量、逐条证书、搜索状态。
 */
const node_fs_1 = require("node:fs");
const node_fs_2 = require("node:fs");
const solver_1 = require("./solver");
const certificate_1 = require("./certificate");
function main(argv) {
    const args = argv.slice(2);
    if (args.length < 1) {
        process.stderr.write('usage: cli.js problem.json [--checkpoint FILE] [--max-nodes N]\n');
        process.exitCode = 2;
        return;
    }
    const problemFile = args[0];
    let checkpointFile = null;
    let maxNodes = Infinity;
    for (let k = 1; k < args.length; k++) {
        if (args[k] === '--checkpoint')
            checkpointFile = args[++k];
        else if (args[k] === '--max-nodes')
            maxNodes = Number(args[++k]);
        else
            throw new Error(`unknown argument ${args[k]}`);
    }
    const problem = JSON.parse((0, node_fs_2.readFileSync)(problemFile, 'utf8'));
    let solver;
    if (checkpointFile !== null && (0, node_fs_1.existsSync)(checkpointFile)) {
        solver = solver_1.Solver.loadFromFile(problem, checkpointFile);
    }
    else {
        solver = new solver_1.Solver(problem);
    }
    const budget = maxNodes === Infinity ? Infinity : solver.nodeCount + maxNodes;
    solver.run(budget);
    if (!solver.isDone && checkpointFile !== null) {
        solver.saveToFile(problem, checkpointFile);
    }
    const best = solver.getBest();
    const out = {
        done: solver.isDone,
        nodes: solver.nodeCount,
    };
    if (solver.isDone && best) {
        const v = (0, certificate_1.verifySolution)(problem, best.assignment);
        out.assignment = best.assignment;
        out.benefit = best.benefit;
        out.usage = { r1: best.used1, r2: best.used2 };
        out.verified = v.ok;
        out.certificates = v.certificates.map((c) => c.detail);
    }
    else {
        out.paused = true;
        out.checkpoint = checkpointFile;
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
main(process.argv);
