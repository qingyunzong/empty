"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "snapdiff.js");

function tmpdir(prefix = "snapdiff-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRun(dir, { params, schema, data }) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "params.json"), JSON.stringify(params, null, 2) + "\n");
  if (schema) fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(schema, null, 2) + "\n");
  for (const [name, csv] of Object.entries(data || {})) {
    fs.writeFileSync(path.join(dir, "data", name + ".csv"), csv);
  }
  return dir;
}

// Runs the CLI in-process (the sandbox forbids nested process spawns),
// capturing stdout/stderr and the exit code exactly as bin/snapdiff.js would.
function cli(args, opts = {}) {
  const savedEnv = { ...process.env };
  if (opts.env) {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, opts.env);
  }
  let stdout = "";
  let stderr = "";
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  const savedExitCode = process.exitCode;
  process.exitCode = 0;
  let status = 0;
  try {
    require("../src/cli").main(args);
    status = process.exitCode ?? 0;
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    process.exitCode = savedExitCode;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
  return {
    status,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
  };
}

function csv(header, rows) {
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = { tmpdir, writeRun, cli, csv, readJson, CLI };
