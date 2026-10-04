import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadInstance } from "./instance.js";
import { solve } from "./solver.js";
import { solveBrute } from "./brute.js";
import { buildCertificate, formatCertificate, verifyCertificate } from "./certificate.js";
import type { Certificate } from "./types.js";

const USAGE = `巡检路线 CLI（基地出发返回，时间窗 + 服务时间 + 收益，可选访问）

用法:
  node dist/cli.js solve  <instance.json> [--json] [--out <cert.json>]
  node dist/cli.js verify <instance.json> <cert.json>
  node dist/cli.js check  <instance.json>     # 小图穷举交叉验证（n <= 10）

目标: 总耗时（行驶+等待+服务，含返回）不超过 timeLimit（整数 60）；
      先最大化总收益，再最小化总路程。
`;

function cmdSolve(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const file = positionals[0];
  if (!file) {
    process.stderr.write("solve 需要实例文件\n");
    return 2;
  }
  const inst = loadInstance(file);
  const res = solve(inst);
  const cert = buildCertificate(inst, res);
  const json = JSON.stringify(cert, null, 2);
  const out = values.out;
  if (typeof out === "string") writeFileSync(out, json + "\n");
  process.stdout.write(values.json ? json + "\n" : formatCertificate(cert) + "\n");
  return 0;
}

function cmdVerify(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [instFile, certFile] = positionals;
  if (!instFile || !certFile) {
    process.stderr.write("verify 需要实例文件与证书文件\n");
    return 2;
  }
  const inst = loadInstance(instFile);
  const cert = JSON.parse(readFileSync(certFile, "utf8")) as Certificate;
  const errors = verifyCertificate(inst, cert);
  if (errors.length === 0) {
    process.stdout.write(`证书有效: 收益 ${cert.profit}, 路程 ${cert.distance}, 总耗时 ${cert.totalTime} / ${inst.timeLimit}\n`);
    return 0;
  }
  process.stdout.write("证书无效:\n" + errors.map((e) => `  - ${e}`).join("\n") + "\n");
  return 1;
}

function cmdCheck(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const file = positionals[0];
  if (!file) {
    process.stderr.write("check 需要实例文件\n");
    return 2;
  }
  const inst = loadInstance(file);
  const fast = solve(inst);
  const brute = solveBrute(inst);
  const match =
    fast.profit === brute.profit && Math.abs(fast.distance - brute.distance) < 1e-6;
  process.stdout.write(`DP 求解:   收益 ${fast.profit}, 路程 ${fast.distance.toFixed(4)}, 路线 ${fast.route.map((i) => inst.ids[i]).join(" -> ") || "(空)"}\n`);
  process.stdout.write(`穷举验证:  收益 ${brute.profit}, 路程 ${brute.distance.toFixed(4)}, 路线 ${brute.route.map((i) => inst.ids[i]).join(" -> ") || "(空)"}\n`);
  process.stdout.write(match ? "一致: 最优性通过穷举验证\n" : "不一致!\n");
  return match ? 0 : 1;
}

function main(): number {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "solve":
      return cmdSolve(rest);
    case "verify":
      return cmdVerify(rest);
    case "check":
      return cmdCheck(rest);
    default:
      process.stdout.write(USAGE);
      return cmd === undefined ? 0 : 2;
  }
}

process.exitCode = main();
