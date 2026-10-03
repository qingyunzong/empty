import { run } from './store.js';

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'quarantine') {
    process.stderr.write('usage: pack quarantine --in <dir> --out <dir>\n');
    return 2;
  }
  let inDir = null;
  let outDir = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--in') inDir = rest[++i];
    else if (rest[i] === '--out') outDir = rest[++i];
    else {
      process.stderr.write(`unknown arg: ${rest[i]}\n`);
      return 2;
    }
  }
  if (!inDir || !outDir) {
    process.stderr.write('usage: pack quarantine --in <dir> --out <dir>\n');
    return 2;
  }
  const crashAt = process.env.PACK_CRASH_AT || null; // test-only crash injection
  const out = run({ inDir, outDir, crashAt });
  const release = JSON.parse(out.release);
  process.stdout.write(
    `released=${release.released.length} quarantined=${release.quarantined.length} ` +
      `conflicts=${release.conflicts.length} errors=${release.errors.length}\n`,
  );
  for (const e of release.errors) process.stderr.write(`${e.error} case=${e.case}\n`);
  return 0;
}
