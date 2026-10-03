import test from "node:test";
import assert from "node:assert/strict";
import { crossCheck } from "../src/enumerate.js";

const IDS = { team: "T1", station: "S1", robot: "R1" };
const mk = (type, rest) => (i) => ({ seq: i, clock: i, source: "sim", type, ...rest });

const ALPHABETS = [
  {
    name: "门磁/模式/钥匙/启动",
    maxLen: 9,
    factories: [
      mk("door", { state: "closed" }),
      mk("mode_request", { mode: "auto" }),
      mk("key_grant", { key: "K1", scope: "team", scopeId: "T1", perms: ["auto"] }),
      mk("auto_start", IDS),
    ],
  },
  {
    name: "授权/撤销/减速窗口",
    maxLen: 9,
    factories: [
      mk("key_grant", { key: "K1", scope: "team", scopeId: "T1", perms: ["auto"] }),
      mk("key_revoke", { key: "K1" }),
      mk("mode_request", { mode: "auto" }),
      mk("auto_start", IDS),
    ],
  },
  {
    name: "示教限速/产能冲突",
    maxLen: 9,
    factories: [
      mk("mode_request", { mode: "teach" }),
      mk("speed_request", { value: 600 }),
      mk("speed_request", { value: 200 }),
    ],
  },
  {
    name: "光幕/门磁安全停机",
    maxLen: 7,
    factories: [
      mk("mode_request", { mode: "auto" }),
      mk("door", { state: "closed" }),
      mk("curtain", { state: "blocked" }),
      mk("curtain", { state: "clear" }),
      mk("auto_start", IDS),
    ],
  },
  {
    name: "启动/停止/维护",
    maxLen: 7,
    factories: [
      mk("mode_request", { mode: "auto" }),
      mk("mode_request", { mode: "maintenance" }),
      mk("door", { state: "closed" }),
      mk("auto_start", IDS),
      mk("auto_stop", {}),
    ],
  },
];

for (const { name, factories, maxLen } of ALPHABETS) {
  test(
    `D: 枚举对照 [${name}] 字母表${factories.length} 长度<=${maxLen}`,
    { timeout: 300000 },
    (t) => {
      const { checked, mismatches } = crossCheck(factories, maxLen);
      t.diagnostic(`checked ${checked} sequences`);
      assert.equal(mismatches.length, 0, JSON.stringify(mismatches[0] ?? null, null, 2));
      assert.ok(checked > 0);
    },
  );
}
