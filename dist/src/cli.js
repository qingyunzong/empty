"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const node_fs_1 = require("node:fs");
const rational_1 = require("./rational");
const solve_1 = require("./solve");
function run(input) {
    if (!Array.isArray(input.segments))
        throw new Error("input.segments must be an array");
    if (input.segments.length > solve_1.MAX_SEGMENTS)
        throw new Error(`at most ${solve_1.MAX_SEGMENTS} segments allowed`);
    const segments = input.segments.map((s, i) => {
        if (!Array.isArray(s.points) || s.points.length !== 4)
            throw new Error(`segment ${i}: expected exactly 4 control points`);
        return s.points.map((p, j) => {
            if (!Array.isArray(p) || p.length !== 2)
                throw new Error(`segment ${i} point ${j}: expected [x, y]`);
            return [(0, rational_1.parseRat)(p[0]), (0, rational_1.parseRat)(p[1])];
        });
    });
    const line = {
        a: (0, rational_1.parseRat)(input.line.a),
        b: (0, rational_1.parseRat)(input.line.b),
        c: (0, rational_1.parseRat)(input.line.c),
    };
    return (0, solve_1.solve)(segments, line, {
        budget: input.budget,
        tol: input.tol !== undefined ? (0, rational_1.parseRat)(input.tol) : undefined,
    });
}
if (require.main === module) {
    const arg = process.argv[2];
    try {
        const text = arg && arg !== "-" ? (0, node_fs_1.readFileSync)(arg, "utf8") : (0, node_fs_1.readFileSync)(0, "utf8");
        const result = run(JSON.parse(text));
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
    catch (err) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(1);
    }
}
