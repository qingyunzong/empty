#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runCli } from "./main.js";

const { code, out, err } = runCli(process.argv.slice(2), () => readFileSync(0, "utf8"));
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exitCode = code;
