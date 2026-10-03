#!/usr/bin/env node
'use strict';

const path = require('node:path');
const repo = require('./lib/repo');

const USAGE = `evc - evidence-chain version repository

usage:
  evc init                       initialize a repository in the current directory
  evc commit -m <message>        snapshot evidence/ + claims.json as a new version
  evc verify [version]           incrementally verify genesis..version (default HEAD)
  evc checkout <version> [dir]   rebuild the full manifest of <version> into [dir]

exit codes: 0 ok, 1 usage/io error, 2 verification failure (corrupt chain)
`;

function main(argv) {
  const [cmd, ...args] = argv;
  const root = process.cwd();

  switch (cmd) {
    case 'init': {
      repo.init(root);
      console.log(`initialized evidence-chain repository in ${path.join(root, repo.REPO_DIR)}`);
      return 0;
    }
    case 'commit': {
      let message = '';
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-m' || args[i] === '--message') {
          message = args[++i] || '';
        }
      }
      const { hash } = repo.commit(root, message);
      console.log(`committed version ${hash}`);
      return 0;
    }
    case 'verify': {
      const target = args[0];
      const { certificate, manifest } = repo.verify(root, target);
      console.log(`verification ok: ${certificate.version}`);
      console.log(`  contentHash:     ${certificate.contentHash}`);
      console.log(`  parentHash:      ${certificate.parentHash}`);
      console.log(`  certificateHash: ${certificate.certificateHash}`);
      console.log(`  evidence files:  ${Object.keys(manifest).length}`);
      return 0;
    }
    case 'checkout': {
      const target = args[0];
      if (!target) {
        console.error('checkout requires a version hash');
        return 1;
      }
      const { dest, manifest } = repo.checkout(root, target, args[1] && path.resolve(args[1]));
      console.log(`checked out ${target} into ${dest} (${Object.keys(manifest).length} files)`);
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  if (err instanceof repo.VerifyError) {
    console.error(`verification failed [${err.code}]: ${err.message}`);
    process.exit(2);
  }
  console.error(`error: ${err.message}`);
  process.exit(1);
}
