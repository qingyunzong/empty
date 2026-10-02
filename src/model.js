'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

// Normalize and validate raw JSON input into an internal model.
// Throws ValidationError on any invalid input (CLI maps this to exit code 2).
function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('input must be a JSON object');
  }
  if (!Array.isArray(raw.machines) || raw.machines.length === 0) {
    throw new ValidationError('missing or empty "machines" array');
  }
  const machineIds = raw.machines.map((m, i) => {
    if (typeof m === 'string') return m;
    if (m !== null && typeof m === 'object' && typeof m.id === 'string') return m.id;
    throw new ValidationError(`machines[${i}] must be a machine id string or an object with "id"`);
  });
  if (new Set(machineIds).size !== machineIds.length) {
    throw new ValidationError('duplicate machine id in "machines"');
  }
  const machineIndex = new Map(machineIds.map((id, i) => [id, i]));

  const setupTime = raw.setupTime === undefined ? 0 : raw.setupTime;
  if (!isInt(setupTime) || setupTime < 0) {
    throw new ValidationError('"setupTime" must be a non-negative integer');
  }

  if (!Array.isArray(raw.jobs)) {
    throw new ValidationError('missing "jobs" array');
  }
  const seenJobIds = new Set();
  const jobs = raw.jobs.map((j, i) => {
    const where = j && j.id !== undefined ? `job "${j.id}"` : `jobs[${i}]`;
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
      throw new ValidationError(`${where}: must be an object`);
    }
    if (j.id === undefined || j.id === null) {
      throw new ValidationError(`jobs[${i}]: missing "id"`);
    }
    const id = String(j.id);
    if (seenJobIds.has(id)) {
      throw new ValidationError(`duplicate job id "${id}"`);
    }
    seenJobIds.add(id);
    for (const field of ['release', 'duration', 'deadline']) {
      if (j[field] === undefined) {
        throw new ValidationError(`${where}: missing "${field}"`);
      }
      if (!isInt(j[field])) {
        throw new ValidationError(`${where}: "${field}" must be an integer, got ${JSON.stringify(j[field])}`);
      }
    }
    if (j.release < 0) {
      throw new ValidationError(`${where}: "release" must be >= 0`);
    }
    if (j.duration <= 0) {
      throw new ValidationError(`${where}: "duration" must be a positive integer`);
    }
    let machines;
    if (j.machines === undefined) {
      machines = machineIds.slice();
    } else {
      if (!Array.isArray(j.machines) || j.machines.length === 0) {
        throw new ValidationError(`${where}: "machines" must be a non-empty array of machine ids`);
      }
      machines = [...new Set(j.machines)].map((mid) => {
        if (!machineIndex.has(mid)) {
          throw new ValidationError(`${where}: undefined machine ${JSON.stringify(mid)}`);
        }
        return mid;
      });
    }
    const family = j.family === undefined ? 'default' : String(j.family);
    return { id, release: j.release, duration: j.duration, deadline: j.deadline, machines, family };
  });

  return { machineIds, setupTime, jobs };
}

module.exports = { normalize, ValidationError };
