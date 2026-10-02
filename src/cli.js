import { readFileSync, writeFileSync } from 'node:fs';
import { PolicyError, parsePolicies } from './policy.js';
import { evaluate } from './evaluate.js';

const USAGE = `Usage: mes-interlock --policies <policies.json> --requests <requests.jsonl> \\
                     --decisions <decisions.jsonl> --audit <audit.log>

Evaluates safety interlock policies against operator requests.

Exit codes: 0 ok, 2 invalid JSON/config, 3 unknown subject/device, 4 inheritance cycle
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--policies' || a === '-p') args.policies = argv[++i];
    else if (a === '--requests' || a === '-r') args.requests = argv[++i];
    else if (a === '--decisions' || a === '-d') args.decisions = argv[++i];
    else if (a === '--audit' || a === '-a') args.audit = argv[++i];
    else throw new PolicyError(`unknown argument: ${a}`, 2);
  }
  return args;
}

export function parseRequests(text) {
  const requests = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      throw new PolicyError(`requests line ${i + 1}: invalid JSON: ${err.message}`, 2);
    }
    for (const field of ['subject', 'device', 'action', 'time']) {
      if (typeof rec[field] !== 'string') {
        throw new PolicyError(`requests line ${i + 1}: missing or invalid field '${field}'`, 2);
      }
    }
    if (Number.isNaN(Date.parse(rec.time))) {
      throw new PolicyError(`requests line ${i + 1}: invalid time '${rec.time}'`, 2);
    }
    rec.id = rec.id ?? `req-${requests.length + 1}`;
    requests.push(rec);
  }
  return requests;
}

function cexSummary(cex) {
  if (!cex) return '-';
  if (cex.kind === 'request') {
    const [field, value] = Object.entries(cex.change)[0];
    return `request:${field}=${value}`;
  }
  if (cex.kind === 'policy') {
    if (cex.change.removeRules) return `policy:removeRules(${cex.change.removeRules.join(',')})`;
    if (cex.change.addRule) return `policy:addRule(${cex.change.addRule.id})`;
  }
  return cex.kind;
}

export function formatAudit(r) {
  const overridden = r.overridden.map((o) => `${o.rule}:${o.why}`).join(',') || '-';
  const conflict = r.conflict
    ? `allow[${r.conflict.allow.join(',')}]deny[${r.conflict.deny.join(',')}]->deny`
    : '-';
  const retro = r.retroactiveRevocations.length ? r.retroactiveRevocations.join(',') : '-';
  return `time=${r.time} id=${r.requestId} subject=${r.subject} device=${r.device} action=${r.action} `
    + `decision=${r.decision} reason=${r.reason} winners=${r.winners.join(',') || '-'} `
    + `overridden=${overridden} conflict=${conflict} retro=${retro} cex=${cexSummary(r.counterexample)}`;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.policies || !args.requests || !args.decisions || !args.audit) {
    console.error('missing required arguments');
    console.error(USAGE);
    return 2;
  }

  try {
    const policies = parsePolicies(readFileSync(args.policies, 'utf8'));
    const requests = parseRequests(readFileSync(args.requests, 'utf8'));

    const unknown = [];
    for (const req of requests) {
      if (!policies.subjects[req.subject]) unknown.push(`request ${req.id}: unknown subject '${req.subject}'`);
      if (!policies.devices[req.device]) unknown.push(`request ${req.id}: unknown device '${req.device}'`);
    }
    if (unknown.length) {
      for (const line of unknown) console.error(line);
      return 3;
    }

    const records = requests.map((req) => evaluate(policies, req));
    writeFileSync(args.decisions, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(args.audit, records.map(formatAudit).join('\n') + '\n');

    const allows = records.filter((r) => r.decision === 'allow').length;
    console.log(`evaluated ${records.length} requests: ${allows} allow, ${records.length - allows} deny`);
    console.log(`decisions -> ${args.decisions}`);
    console.log(`audit     -> ${args.audit}`);
    return 0;
  } catch (err) {
    if (err instanceof PolicyError) {
      console.error(err.message);
      return err.exitCode;
    }
    if (err.code === 'ENOENT') {
      console.error(`cannot read file: ${err.path}`);
      return 2;
    }
    throw err;
  }
}
