import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GateError,
  EXIT_VIEW_HASH_MISSING_INPUT,
  validatePolicy,
  validateReportFields,
} from './policy.js';
import { parseRedactions, checkRedactions } from './redactions.js';
import {
  computeView,
  computeJointView,
  hashView,
  hashReportFields,
  viewFileName,
} from './views.js';
import { auditView } from './audit.js';

const DEFAULTS = {
  reports: 'reports.jsonl',
  policy: 'field-policy.json',
  redactions: 'redactions.jsonl',
  views: 'views',
  audit: 'leak-audit.jsonl',
};

export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!(key in DEFAULTS)) throw new GateError(`unknown option --${key}`, 1);
      opts[key] = argv[index + 1];
      index += 1;
    }
  }
  return opts;
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new GateError(`cannot read ${file}: ${error.message}`, 1);
  }
}

function readReports(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new GateError(`cannot read ${file}: ${error.message}`, 1);
  }
  const reports = [];
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let report;
    try {
      report = JSON.parse(line);
    } catch {
      throw new GateError(`${file} line ${index + 1}: invalid JSON`, 1);
    }
    if (typeof report.id !== 'string' || !report.fields || typeof report.fields !== 'object') {
      throw new GateError(`${file} line ${index + 1}: needs {id, fields}`, 1);
    }
    reports.push(report);
  }
  return reports;
}

function readExistingViews(viewsDir) {
  if (!existsSync(viewsDir)) return [];
  const views = [];
  for (const fileName of readdirSync(viewsDir)) {
    if (!fileName.endsWith('.view.json')) continue;
    const parsed = readJsonFile(path.join(viewsDir, fileName));
    views.push({ ...parsed, fileName });
  }
  return views;
}

export function main(argv, io = { out: console.log, err: console.error }) {
  try {
    const opts = parseArgs(argv);
    const policy = readJsonFile(opts.policy);
    validatePolicy(policy);

    const reports = readReports(opts.reports);
    for (const report of reports) validateReportFields(policy, report.id, report.fields);

    const redactions = existsSync(opts.redactions)
      ? parseRedactions(readFileSync(opts.redactions, 'utf8'))
      : [];
    checkRedactions(policy, redactions);

    // Every previously generated view must still find the exact input report
    // its hash was computed from; otherwise the view is unverifiable.
    const existing = readExistingViews(opts.views);
    const reportsById = new Map(reports.map((report) => [report.id, report]));
    for (const view of existing) {
      const report = reportsById.get(view.reportId);
      if (!report || hashReportFields(report.fields) !== view.inputs?.report) {
        throw new GateError(
          `view hash missing input: ${view.fileName} (report '${view.reportId}')`,
          EXIT_VIEW_HASH_MISSING_INPUT,
        );
      }
    }

    mkdirSync(opts.views, { recursive: true });
    const audiences = policy.audiences ?? ['operator', 'supplier', 'hq'];
    const jointMembers = policy.joint ?? ['supplier', 'hq'];
    const policyHash = hashReportFields(policy);

    // Compute current views (revocations applied).
    const current = new Map();
    for (const report of reports) {
      const reportHash = hashReportFields(report.fields);
      const targets = [...audiences.map((a) => [a, false]), ['joint', true]];
      for (const [audience, isJoint] of targets) {
        const { fields } = isJoint
          ? computeJointView(policy, redactions, jointMembers, report.fields)
          : computeView(policy, redactions, audience, report.fields);
        const hash = hashView(report.id, audience, fields);
        current.set(`${report.id}.${audience}`, {
          reportId: report.id,
          audience,
          fields,
          hash,
          inputs: { report: reportHash, policy: policyHash },
          status: 'active',
        });
      }
    }

    // Previously generated views that no longer match the current output keep
    // their hash and are marked expired; matching ones stay active.
    let expired = 0;
    for (const view of existing) {
      const key = `${view.reportId}.${view.audience}`;
      const isCurrent = current.get(key)?.hash === view.hash;
      const status = isCurrent ? 'active' : 'expired';
      if (view.status !== status) {
        const { fileName, ...body } = view;
        writeFileSync(
          path.join(opts.views, fileName),
          JSON.stringify({ ...body, status }, null, 2) + '\n',
        );
      }
      if (status === 'expired') expired += 1;
    }

    let written = 0;
    for (const view of current.values()) {
      const fileName = viewFileName(view.reportId, view.audience, view.hash);
      const filePath = path.join(opts.views, fileName);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, JSON.stringify(view, null, 2) + '\n');
        written += 1;
      }
    }

    // Audit every active view: each output field needs an authorization path.
    const auditLines = [];
    let auditOk = true;
    for (const view of current.values()) {
      const audienceIds = view.audience === 'joint' ? jointMembers : [view.audience];
      const result = auditView(policy, audienceIds, {
        ...view,
        fileName: viewFileName(view.reportId, view.audience, view.hash),
      });
      if (!result.ok) auditOk = false;
      auditLines.push(JSON.stringify(result));
    }
    writeFileSync(opts.audit, auditLines.join('\n') + (auditLines.length ? '\n' : ''));

    io.out(
      `views: ${current.size} current (${written} new, ${expired} expired); audit ${auditOk ? 'ok' : 'VIOLATIONS'} -> ${opts.audit}`,
    );
    return auditOk ? 0 : 1;
  } catch (error) {
    if (error instanceof GateError) {
      io.err(`error: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
