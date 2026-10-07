"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const app_1 = require("../src/app");
(0, node_test_1.default)("SAT exits 0 and prints minimal step intervals", () => {
    const r = (0, app_1.runCli)([], "var x in [0, 100]\nx % 7 == 3\nx != 10\n");
    node_assert_1.default.equal(r.code, 0, r.err);
    node_assert_1.default.match(r.out, /\{3\}/);
    node_assert_1.default.match(r.out, /\[17 .. 94\] step 7/);
    node_assert_1.default.match(r.out, /verification \[exhaustive\]: OK/);
    node_assert_1.default.match(r.out, /status: SAT/);
});
(0, node_test_1.default)("UNSAT exits 1 and prints a certificate", () => {
    const r = (0, app_1.runCli)([], "var x in [0, 10]\nx >= 5\nx <= 3\n");
    node_assert_1.default.equal(r.code, 1, r.err);
    node_assert_1.default.match(r.out, /certificate: empty interval/);
    node_assert_1.default.match(r.out, /status: UNSAT/);
});
(0, node_test_1.default)("--json emits parseable output with stringified bigints", () => {
    const r = (0, app_1.runCli)(["--json"], "var x in [0, 20]\n3*x % 12 == 6\n");
    node_assert_1.default.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out);
    node_assert_1.default.equal(parsed.status, "sat");
    node_assert_1.default.deepStrictEqual(parsed.variables[0].intervals, [{ start: "2", end: "18", step: "4" }]);
    node_assert_1.default.equal(parsed.verification[0].mode, "exhaustive");
});
(0, node_test_1.default)("strict bounds are exact in CLI output (no float rounding)", () => {
    const r = (0, app_1.runCli)([], `var x in [0, ${2n ** 62n}]\n8*x + 3 <= 9223372036854775799\n`);
    node_assert_1.default.equal(r.code, 0, r.err);
    node_assert_1.default.match(r.out, /1152921504606846974/);
    node_assert_1.default.doesNotMatch(r.out, /1152921504606846976/);
});
(0, node_test_1.default)("parse errors exit 2 with a message on stderr", () => {
    const r = (0, app_1.runCli)([], "var x in [0, 10]\nx + <= 3\n");
    node_assert_1.default.equal(r.code, 2);
    node_assert_1.default.match(r.err, /error:/);
});
(0, node_test_1.default)("huge domains fall back to boundary verification", () => {
    const r = (0, app_1.runCli)(["--verify-limit", "100"], `var x in [${-(2n ** 63n)}, ${2n ** 63n - 1n}]\nx % 2 == 1\n`);
    node_assert_1.default.equal(r.code, 0, r.err);
    node_assert_1.default.match(r.out, /verification \[boundary\]: OK/);
});
(0, node_test_1.default)("--no-verify skips verification output", () => {
    const r = (0, app_1.runCli)(["--no-verify"], "var x in [0, 5]\n");
    node_assert_1.default.equal(r.code, 0, r.err);
    node_assert_1.default.doesNotMatch(r.out, /verification/);
});
