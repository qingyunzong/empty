import fs from 'node:fs';
import {
  initPack, appendBlock, verifyPack, digest, setMembership,
  hashBlock, readBlock,
} from './store.js';
import { prove as merkleProve, verifyProof } from './merkle.js';
import { syncPacks } from './sync.js';
import { PackError, Code, exitCodeFor } from './errors.js';

const USAGE = `evpack - offline evidence pack
  evpack init <pack> [--members a,b,c]
  evpack add <pack> (--data '<json>' | --file <evidence.jsonl>)
  evpack prove <pack> --index N [--out proof.json]
  evpack verify <pack> [--proof proof.json]
  evpack digest <pack>
  evpack sync <packA> <packB>
  evpack epoch <pack> --members a,b,c
All output is JSON on stdout; errors are JSON on stderr with fixed exit codes:
  2 TAMPER_DETECTED  3 MISSING_BLOCK  4 INVALID_PROOF  5 STALE_EPOCH  6 USAGE`;

function parseFlags(args) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function need(cond, msg) {
  if (!cond) throw new PackError(Code.USAGE, msg, {});
}

function parseMembers(flags) {
  if (!flags.members) return [];
  return String(flags.members).split(',').map((s) => s.trim()).filter(Boolean);
}

function cmdAdd(pack, flags) {
  const items = [];
  if (flags.data !== undefined && flags.data !== true) {
    items.push(JSON.parse(flags.data));
  }
  if (flags.file) {
    const text = fs.readFileSync(String(flags.file), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t) items.push(JSON.parse(t));
    }
  }
  need(items.length > 0, 'add requires --data or --file');
  const added = [];
  let last;
  for (const data of items) {
    last = appendBlock(pack, data);
    added.push({ index: last.block.index, hash: last.block.hash });
  }
  return {
    ok: true, added,
    length: last.commit.length, head: last.commit.head, root: last.commit.root,
    epoch: last.commit.epoch,
  };
}

function cmdProve(pack, flags) {
  need(flags.index !== undefined, 'prove requires --index');
  const index = Number(flags.index);
  const { commit, hashes } = verifyPack(pack);
  if (!Number.isInteger(index) || index < 0 || index >= commit.length) {
    throw new PackError(Code.INDEX_OUT_OF_RANGE, 'index out of range', {
      index, length: commit.length,
    });
  }
  const block = readBlock(pack, index);
  const result = {
    ok: true,
    index,
    epoch: block.epoch,
    block,
    leaf: block.hash,
    length: commit.length,
    root: commit.root,
    proof: merkleProve(hashes, index),
  };
  if (flags.out) {
    fs.writeFileSync(String(flags.out), JSON.stringify(result, null, 2) + '\n');
    return { ok: true, out: String(flags.out), index, root: commit.root };
  }
  return result;
}

function cmdVerify(pack, flags) {
  if (flags.proof) {
    const { commit } = verifyPack(pack);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(String(flags.proof), 'utf8'));
    } catch {
      throw new PackError(Code.INVALID_PROOF, 'unparseable proof file', { file: String(flags.proof) });
    }
    const valid = doc && doc.block && Array.isArray(doc.proof)
      && doc.root === commit.root
      && doc.length === commit.length
      && hashBlock(doc.block) === doc.leaf
      && verifyProof(doc.leaf, doc.index, doc.length, doc.proof, commit.root);
    if (!valid) {
      throw new PackError(Code.INVALID_PROOF, 'inclusion proof does not verify', {
        index: doc && doc.index,
      });
    }
    return { ok: true, proof: 'valid', index: doc.index, root: commit.root };
  }
  const { commit, epoch } = verifyPack(pack);
  return {
    ok: true, length: commit.length, head: commit.head, root: commit.root, epoch: epoch.epoch,
  };
}

function dispatch(argv) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseFlags(rest);
  switch (cmd) {
    case 'init': {
      need(pos.length === 1, 'init requires <pack>');
      initPack(pos[0], parseMembers(flags));
      return { ok: true, pack: pos[0], ...digest(pos[0]) };
    }
    case 'add': {
      need(pos.length === 1, 'add requires <pack>');
      return cmdAdd(pos[0], flags);
    }
    case 'prove': {
      need(pos.length === 1, 'prove requires <pack>');
      return cmdProve(pos[0], flags);
    }
    case 'verify': {
      need(pos.length === 1, 'verify requires <pack>');
      return cmdVerify(pos[0], flags);
    }
    case 'digest': {
      need(pos.length === 1, 'digest requires <pack>');
      return { ok: true, ...digest(pos[0]) };
    }
    case 'sync': {
      need(pos.length === 2, 'sync requires <packA> <packB>');
      return { ok: true, ...syncPacks(pos[0], pos[1]) };
    }
    case 'epoch': {
      need(pos.length === 1, 'epoch requires <pack>');
      return { ok: true, ...setMembership(pos[0], parseMembers(flags)) };
    }
    default:
      throw new PackError(Code.USAGE, USAGE, {});
  }
}

// In-process entry: returns {code, stdout, stderr}. Testable without spawning.
export function run(argv) {
  try {
    const result = dispatch(argv);
    return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const code = err instanceof PackError ? err.code : Code.INTERNAL;
    const details = err instanceof PackError ? err.details : {};
    const stderr = JSON.stringify({
      ok: false,
      error: { code, message: err.message, ...details },
    }) + '\n';
    return { code: exitCodeFor(code), stdout: '', stderr };
  }
}

export function main(argv) {
  const r = run(argv);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
