'use strict';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.exitCode = 2;
  }
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function validateInstance(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('input must be a JSON object');
  }
  if (!Array.isArray(raw.machines) || raw.machines.length === 0) {
    throw new InputError('input.machines must be a non-empty array of machine names');
  }
  const machines = [];
  const machineSet = new Set();
  for (const m of raw.machines) {
    if (typeof m !== 'string' || m.length === 0) {
      throw new InputError('machine names must be non-empty strings');
    }
    if (machineSet.has(m)) throw new InputError(`duplicate machine: ${m}`);
    machineSet.add(m);
    machines.push(m);
  }

  let setupTime = 0;
  if (raw.setupTime !== undefined) {
    if (!isInt(raw.setupTime) || raw.setupTime < 0) {
      throw new InputError('input.setupTime must be a non-negative integer');
    }
    setupTime = raw.setupTime;
  }

  if (!Array.isArray(raw.jobs)) {
    throw new InputError('input.jobs must be an array');
  }
  const ids = new Set();
  const jobs = raw.jobs.map((rawJob, idx) => {
    if (rawJob === null || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
      throw new InputError(`jobs[${idx}] must be an object`);
    }
    const { id, release, deadline, duration, family } = rawJob;
    if (typeof id !== 'string' || id.length === 0) {
      throw new InputError(`jobs[${idx}].id must be a non-empty string`);
    }
    if (ids.has(id)) throw new InputError(`duplicate job id: ${id}`);
    ids.add(id);
    for (const [field, value] of [['release', release], ['deadline', deadline], ['duration', duration]]) {
      if (!isInt(value)) {
        throw new InputError(`job ${id}: ${field} must be an integer (got ${JSON.stringify(value)})`);
      }
    }
    if (duration <= 0) throw new InputError(`job ${id}: duration must be positive`);
    if (deadline < release) throw new InputError(`job ${id}: deadline < release`);
    let eligible = machines.slice();
    if (rawJob.machines !== undefined) {
      if (!Array.isArray(rawJob.machines) || rawJob.machines.length === 0) {
        throw new InputError(`job ${id}: machines must be a non-empty array`);
      }
      eligible = rawJob.machines.map((m) => {
        if (typeof m !== 'string' || !machineSet.has(m)) {
          throw new InputError(`job ${id}: undefined machine ${JSON.stringify(m)}`);
        }
        return m;
      });
      if (new Set(eligible).size !== eligible.length) {
        throw new InputError(`job ${id}: duplicate machine in machines list`);
      }
    }
    if (family !== undefined && typeof family !== 'string') {
      throw new InputError(`job ${id}: family must be a string`);
    }
    return { id, release, deadline, duration, machines: eligible, family: family ?? 'default' };
  });

  return { machines, setupTime, jobs };
}

function loadInstanceFile(fs, path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new InputError(`cannot read input file: ${path}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new InputError(`invalid JSON in ${path}: ${err.message}`);
  }
  return validateInstance(raw);
}

module.exports = { InputError, validateInstance, loadInstanceFile };
