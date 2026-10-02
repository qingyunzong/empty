#!/usr/bin/env node
'use strict';

// Calibration lab CLI.
//
//   node cli.js [--dir DIR] <command> [--flag value ...]
//
// Commands: add_artifact | link | unlink | measure | reserve | release |
//           certify | audit
//
// Storage layout inside DIR (default ./.cal-lab or $CAL_LAB_DIR):
//   state.json       lab registry (artifacts, links, leases, certs)
//   measure.journal  append-only measure log; `measure` is the only command
//                    that performs crash-safe durable writes (append+fsync,
//                    torn-tail recovery on load).

const fs = require('node:fs');
const path = require('node:path');
const { Lab } = require('./src/lab.js');
const { LabError } = require('./src/errors.js');
const { Journal, recoverJournal, atomicWriteFile } = require('./src/journal.js');

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function coerce(v) {
  if (v === true) return true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (v.startsWith('{') || v.startsWith('[')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = camel(a.slice(2));
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = coerce(argv[i + 1]);
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function req(args, key) {
  if (args[key] === undefined) throw new LabError('INVALID', `missing required option --${key}`);
  return args[key];
}

function loadLab(dir) {
  const statePath = path.join(dir, 'state.json');
  let state = { artifacts: {}, links: [], leases: {}, certs: {}, measurements: [] };
  if (fs.existsSync(statePath)) {
    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state = { ...state, ...loaded, measurements: [] };
  }
  const journalPath = path.join(dir, 'measure.journal');
  const rec = recoverJournal(journalPath);
  state.measurements = rec.records.map((r) => r.record);
  return { lab: new Lab({ state, journal: new Journal(journalPath) }), statePath, recovered: rec };
}

function saveState(statePath, lab) {
  const { measurements, ...rest } = lab.state;
  atomicWriteFile(statePath, JSON.stringify(rest, null, 2));
}

const USAGE = `usage: node cli.js [--dir DIR] <command> [options]
  add_artifact --id ID --kind standard|uut|point [--root] [--range-class R]
               [--env-class E] [--grade G] [--uncertainty U] [--valid-from D]
               [--valid-to D] [--uut ID] [--budget B] [--margin M]
               [--window '{"tempMin":..,"tempMax":..,"humMin":..,"humMax":..}']
  link --from ID --to ID
  unlink --from ID --to ID
  measure --point ID --value V [--temp T] [--humidity H] [--u-meas U] [--at ISO]
  reserve --standard ID --holder NAME
  release --standard ID --holder NAME
  certify --point ID [--at ISO]
  audit (--cert ID | --cert-file PATH)`;

// Runs one CLI invocation in-process; returns {code, stdout, stderr}.
function runCli(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd) {
    return { code: 2, stdout: '', stderr: USAGE + '\n' };
  }
  const dir = args.dir || process.env.CAL_LAB_DIR || '.cal-lab';
  fs.mkdirSync(dir, { recursive: true });
  let stderr = '';
  try {
    const { lab, statePath, recovered } = loadLab(dir);
    if (recovered.recovered) {
      stderr += `journal recovered: truncated ${recovered.truncatedBytes} torn byte(s)\n`;
    }
    let result;
    let save = true;
    switch (cmd) {
      case 'add_artifact': {
        const spec = {};
        for (const [k, v] of Object.entries(args)) {
          if (k === '_' || k === 'dir') continue;
          spec[k] = v;
        }
        if (spec.uut) {
          spec.uutId = spec.uut;
          delete spec.uut;
        }
        result = lab.addArtifact(spec);
        break;
      }
      case 'link':
        result = lab.link(req(args, 'from'), req(args, 'to'));
        break;
      case 'unlink':
        result = lab.unlink(req(args, 'from'), req(args, 'to'));
        break;
      case 'measure':
        result = lab.measure({
          pointId: req(args, 'point'),
          value: req(args, 'value'),
          temp: args.temp,
          humidity: args.humidity,
          uMeas: args.uMeas,
          at: args.at,
        });
        save = false; // measure persists via the journal only
        break;
      case 'reserve':
        result = lab.reserve(req(args, 'standard'), req(args, 'holder'));
        break;
      case 'release':
        result = lab.release(req(args, 'standard'), req(args, 'holder'));
        break;
      case 'certify':
        result = lab.certify(req(args, 'point'), args.at || new Date().toISOString());
        break;
      case 'audit':
        if (args.cert) result = lab.audit(args.cert);
        else if (args.certFile) result = lab.audit(JSON.parse(fs.readFileSync(args.certFile, 'utf8')));
        else throw new LabError('INVALID', 'audit requires --cert ID or --cert-file PATH');
        save = false;
        break;
      default:
        throw new LabError('UNKNOWN_COMMAND', `unknown command: ${cmd}`);
    }
    if (save) saveState(statePath, lab);
    return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr };
  } catch (e) {
    if (e instanceof LabError) {
      return {
        code: 1,
        stdout:
          JSON.stringify({ error: e.code, message: e.message, details: e.details === undefined ? null : e.details }) + '\n',
        stderr,
      };
    }
    return { code: 2, stdout: '', stderr: stderr + String((e && e.stack) || e) + '\n' };
  }
}

if (require.main === module) {
  const r = runCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

module.exports = { runCli };
