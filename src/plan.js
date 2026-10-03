'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { PlanError } = require('./errors');

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashPlan(plan) {
  return crypto.createHash('sha256').update(canonical(plan)).digest('hex');
}

// Atomic save: write to a temp file, then rename over plan.json. The rename
// is the recovery point -- after it succeeds the new plan is durable and
// readers never observe a half-written file.
function savePlan(planPath, plan) {
  const payload = { plan, planHash: hashPlan(plan) };
  const tmpPath = `${planPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmpPath, planPath);
  return payload.planHash;
}

function loadPlan(planPath) {
  let raw;
  try {
    raw = fs.readFileSync(planPath, 'utf8');
  } catch {
    throw new PlanError(`cannot read plan file: ${planPath}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new PlanError(`plan file is corrupt or truncated: ${planPath}`);
  }
  if (!data || typeof data !== 'object' || data.plan === undefined || typeof data.planHash !== 'string') {
    throw new PlanError(`plan file is missing plan or planHash: ${planPath}`);
  }
  if (hashPlan(data.plan) !== data.planHash) {
    throw new PlanError(`plan hash mismatch (file modified or truncated): ${planPath}`);
  }
  return data.plan;
}

module.exports = { canonical, hashPlan, savePlan, loadPlan };
