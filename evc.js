#!/usr/bin/env node
'use strict';

const path = require('node:path');
const ev = require('./src/evchain.js');

const USAGE = `Usage: evc <command> [args]

Commands:
  init                      Initialize a repository in the current directory
  commit [-m message]       Commit evidence/ + claims.json as a new version
  verify <version-hash>     Incrementally verify genesis..target, emit certificate
  checkout <version-hash>   Verify then rebuild the version into ./checkout

Exit codes: 0 ok, 1 error (verify/commit failures), 2 checkout of corrupt version
`;

function run(argv, cwd) {
  const root = cwd || process.cwd();
  const [cmd, ...rest] = argv;
  let stdout = '';
  let stderr = '';
  const out = (s) => { stdout += s + '\n'; };
  const err = (s) => { stderr += s + '\n'; };
  const fail = (code, message, exitCode) => {
    err(`error[${code}]: ${message}`);
    return { code: exitCode, stdout, stderr };
  };
  try {
    switch (cmd) {
      case 'init': {
        const hash = ev.initRepo(root);
        out(`initialized evchain repository, genesis ${hash}`);
        return { code: 0, stdout, stderr };
      }
      case 'commit': {
        let message = '';
        const mi = rest.indexOf('-m');
        if (mi !== -1) message = rest[mi + 1] || '';
        out(ev.commit(root, message));
        return { code: 0, stdout, stderr };
      }
      case 'verify': {
        const target = rest[0];
        if (!target) return fail('USAGE', 'verify requires a version hash', 1);
        const { certificate } = ev.verify(root, target);
        out(`verified ${target}`);
        out(`certificate: ${path.join(ev.REPO_DIR, 'certs', target + '.json')}`);
        out(`contentHash=${certificate.contentHash} parentHash=${certificate.parentHash}`);
        return { code: 0, stdout, stderr };
      }
      case 'checkout': {
        const target = rest[0];
        if (!target) return fail('USAGE', 'checkout requires a version hash', 2);
        const { dir, certificate } = ev.checkout(root, target);
        out(`checked out ${target} into ${dir}`);
        out(`contentHash=${certificate.contentHash} parentHash=${certificate.parentHash}`);
        return { code: 0, stdout, stderr };
      }
      default: {
        stderr += USAGE;
        const code = cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
        return { code, stdout, stderr };
      }
    }
  } catch (e) {
    if (e instanceof ev.EvchainError) {
      return fail(e.code, e.message, cmd === 'checkout' ? 2 : 1);
    }
    throw e;
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

module.exports = { run };
