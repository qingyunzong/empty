#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { PackWriter } = require('./src/writer');
const { readPack } = require('./src/reader');
const { canonicalLine } = require('./src/canonical');

const USAGE = `Usage:
  ptag pack <out.ptp> <tags.json>   Pack a JSON array of tags into a pack file
  ptag enum <file.ptp>              Emit canonical JSON, one tag per line
  ptag verify <file.ptp>            Check integrity, report errors
  ptag dict <file.ptp>              Show dictionary manifest

Tag: { "gtin": "...", "batch": "...", "serial": "...", "station": "...", "time": <iso|ms> }`;

function cmdPack(args, io) {
  const [out, input] = args;
  if (!out || !input) return io.usage();
  const tags = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (!Array.isArray(tags)) {
    io.err('tags.json must be a JSON array');
    return 2;
  }
  const writer = new PackWriter(out);
  for (const tag of tags) writer.addTag(tag);
  writer.close();
  io.out(`packed ${tags.length} tag(s) into ${out}`);
  return 0;
}

function cmdEnum(args, io) {
  const [file] = args;
  if (!file) return io.usage();
  const { records, errors } = readPack(file);
  for (const rec of records) io.out(canonicalLine(rec));
  for (const err of errors) {
    io.err(`ERROR ${err.code} at block offset ${err.blockOffset}`);
  }
  return errors.length ? 1 : 0;
}

function cmdVerify(args, io) {
  const [file] = args;
  if (!file) return io.usage();
  const { records, errors, dictVersions } = readPack(file);
  for (const err of errors) {
    io.err(
      `ERROR ${err.code} at block offset ${err.blockOffset}` +
        (err.dictVersion != null ? ` (dict v${err.dictVersion})` : '') +
        (err.recordIndex != null ? ` record #${err.recordIndex}` : '')
    );
  }
  io.out(
    `records=${records.length} errors=${errors.length} dictVersions=[${dictVersions.join(',')}]`
  );
  return errors.length ? 1 : 0;
}

function cmdDict(args, io) {
  const [file] = args;
  if (!file) return io.usage();
  const manifestPath = `${file}.manifest.json`;
  if (!fs.existsSync(manifestPath)) {
    io.err(`no manifest: ${manifestPath}`);
    return 2;
  }
  io.out(fs.readFileSync(manifestPath, 'utf8').trimEnd());
  return 0;
}

const commands = { pack: cmdPack, enum: cmdEnum, verify: cmdVerify, dict: cmdDict };

// Runs a command, returns the exit code. io: {out, err} line sinks.
function run(argv, io) {
  const sinks = {
    out: io.out,
    err: io.err,
    usage() {
      io.err(USAGE);
      return 2;
    },
  };
  const [cmd, ...args] = argv;
  const fn = commands[cmd];
  if (!fn) return sinks.usage();
  try {
    return fn(args, sinks);
  } catch (err) {
    io.err(`ERROR ${err.code || 'E_FATAL'} ${err.message}`);
    return 1;
  }
}

function main(argv) {
  const code = run(argv, {
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  });
  process.exit(code);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { run };
