import test from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type CliIO } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, "..", "..", "examples", "sample.json");

interface Captured {
  code: number;
  out: string;
  err: string;
}

function runCli(args: string[], stdinText = ""): Captured {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: (t) => { out += t; },
    stderr: (t) => { err += t; },
    readStdin: () => stdinText,
  };
  const code = run(args, io);
  return { code, out, err };
}

test("CLI 对示例输出逐步空间证书", () => {
  const res = runCli(["plan", samplePath]);
  equal(res.code, 0, res.err);
  ok(res.out.includes("升级规划: v1.0 -> v2.0"));
  ok(res.out.includes("总下载量: 450 B"));
  ok(res.out.includes("峰值暂存: 250 B"));
  ok(res.out.includes("包 ID 序列: delta-ac, delta-cd"));
  ok(res.out.includes("download"));
  ok(res.out.includes("apply"));
  ok(res.out.includes("delete"));
  ok(res.out.includes("空间证书: OK"));
});

test("CLI --json 输出可解析的结构化结果", () => {
  const res = runCli(["plan", samplePath, "--json"]);
  equal(res.code, 0, res.err);
  const payload = JSON.parse(res.out);
  deepEqual(payload.plan.packageIds, ["delta-ac", "delta-cd"]);
  equal(payload.plan.totalBytes, 450);
  equal(payload.plan.peakBytes, 250);
  equal(payload.certificate.ok, true);
  equal(payload.certificate.steps.length, 6);
});

test("CLI --enumerate 小图枚举对照一致", () => {
  const res = runCli(["plan", samplePath, "--enumerate"]);
  equal(res.code, 0, res.err);
  ok(res.out.includes("枚举对照: 一致"));
});

test("CLI 从标准输入读取（-）", () => {
  const input = JSON.stringify({
    source: "A",
    target: "B",
    spaceLimitBytes: 10,
    packages: [{ id: "only", from: "A", to: "B", bytes: 7 }],
  });
  const res = runCli(["plan", "-"], input);
  equal(res.code, 0, res.err);
  ok(res.out.includes("包 ID 序列: only"));
});

test("CLI 输入非法时退出码 2", () => {
  const res = runCli(["plan", "-"], "{ not json");
  equal(res.code, 2);
  ok(res.err.includes("JSON 解析失败"));
  const tooMany = JSON.stringify({
    source: "A",
    target: "B",
    spaceLimitBytes: 10,
    packages: Array.from({ length: 19 }, (_, i) => ({ id: `p${i}`, from: "A", to: "B", bytes: 1 })),
  });
  const res2 = runCli(["plan", "-"], tooMany);
  equal(res2.code, 2);
  ok(res2.err.includes("超过上限 18"));
});

test("CLI 无可行方案时退出码 3", () => {
  const input = JSON.stringify({
    source: "A",
    target: "B",
    spaceLimitBytes: 5,
    packages: [{ id: "big", from: "A", to: "B", bytes: 50 }],
  });
  const res = runCli(["plan", "-"], input);
  equal(res.code, 3);
  ok(res.err.includes("无可行方案"));
});

test("CLI --help 输出用法且退出码 0", () => {
  const res = runCli(["--help"]);
  equal(res.code, 0);
  ok(res.out.includes("用法"));
});
