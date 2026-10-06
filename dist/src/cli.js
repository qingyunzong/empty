"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const linker_1 = require("./linker");
const format_1 = require("./format");
function main(argv) {
    const file = argv[2];
    if (!file) {
        process.stderr.write("usage: node dist/src/cli.js <graph.json>\n");
        return 1;
    }
    const modules = JSON.parse((0, node_fs_1.readFileSync)(file, "utf8"));
    const result = (0, linker_1.link)(modules, { trace: true });
    process.stdout.write((0, format_1.formatReport)(result, modules.map((m) => m.path)) + "\n");
    return result.diagnostics.length > 0 ? 2 : 0;
}
process.exitCode = main(process.argv);
