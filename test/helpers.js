"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "cli.js");

function makeWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rework-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// NOTE: this sandbox swallows stdout/stderr of grandchild node processes
// spawned directly, so capture via shell redirection into files instead.
function runCli(args) {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "rework-cli-"));
  const outFile = path.join(captureDir, "stdout.txt");
  const errFile = path.join(captureDir, "stderr.txt");
  const codeFile = path.join(captureDir, "code.txt");
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd =
    [process.execPath, CLI, ...args].map(quote).join(" ") +
    ` > ${quote(outFile)} 2> ${quote(errFile)}; echo $? > ${quote(codeFile)}`;
  spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  return {
    status: Number(fs.readFileSync(codeFile, "utf8").trim()),
    stdout: fs.readFileSync(outFile, "utf8"),
    stderr: fs.readFileSync(errFile, "utf8"),
  };
}

function basePolicy(overrides = {}) {
  return {
    currency: "CNY",
    shiftBudget: 1000,
    stockUseCap: 50,
    concessionThreshold: 100,
    categories: {
      BOX: { level: "major", reworkCost: 10 },
      LABEL: { level: "minor", reworkCost: 5 },
      SEAL: { level: "critical" },
    },
    blacklist: [],
    ...overrides,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { CLI, makeWorkspace, runCli, basePolicy, mulberry32 };
