'use strict';

// Per-machine verification of a produced schedule against an instance.
function verifySchedule(instance, schedule) {
  const errors = [];
  const jobById = new Map(instance.jobs.map((j) => [j.id, j]));
  const seen = new Set();

  for (const m of instance.machines) {
    const entries = (schedule[m] || []).slice().sort((a, b) => a.start - b.start);
    let prevEnd = null;
    let prevFamily = null;
    for (const e of entries) {
      const job = jobById.get(e.job);
      if (!job) {
        errors.push(`machine ${m}: unknown job ${e.job}`);
        continue;
      }
      if (seen.has(e.job)) errors.push(`job ${e.job}: scheduled more than once`);
      seen.add(e.job);
      if (!job.machines.includes(m)) {
        errors.push(`job ${e.job}: not eligible for machine ${m}`);
      }
      if (!Number.isInteger(e.start) || !Number.isInteger(e.end)) {
        errors.push(`job ${e.job}: non-integer start/end`);
      }
      if (e.start < job.release) {
        errors.push(`job ${e.job}: starts at ${e.start} before release ${job.release}`);
      }
      if (e.end !== e.start + job.duration) {
        errors.push(`job ${e.job}: end ${e.end} != start + duration ${job.duration}`);
      }
      if (e.end > job.deadline) {
        errors.push(`job ${e.job}: ends at ${e.end} after deadline ${job.deadline}`);
      }
      if (prevEnd !== null) {
        const gap = prevFamily !== job.family ? instance.setupTime : 0;
        if (e.start < prevEnd + gap) {
          errors.push(
            `machine ${m}: job ${e.job} starts at ${e.start}, needs ${prevEnd} + changeover ${gap}`);
        }
      }
      prevEnd = e.end;
      prevFamily = job.family;
    }
  }
  for (const j of instance.jobs) {
    if (!seen.has(j.id)) errors.push(`job ${j.id}: not scheduled`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { verifySchedule };
