// Process entry point for the policy-cli binary.

import { runCli } from "./cli";

const result = runCli(process.argv.slice(2));
if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exitCode = result.code;
