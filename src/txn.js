// Transaction manager: tracks the working set of jobs plus nested savepoints.
// rollback(name) restores the state captured at that savepoint, removes all
// savepoints created after it; the named savepoint and earlier ones stay valid.

export class TxnError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'TxnError';
  }
}

export class Txn {
  constructor(jobs) {
    // jobs: array of { id, duration, priority, lines } (committed state)
    this.jobs = new Map(jobs.map((j) => [j.id, structuredClone(j)]));
    this.savepoints = [];
    this.changedLines = []; // line names touched since last commit (for incremental validation)
  }

  snapshot() {
    return new Map([...this.jobs].map(([k, v]) => [k, structuredClone(v)]));
  }

  addJob(job) {
    if (this.jobs.has(job.id)) throw new TxnError(`job '${job.id}' already exists`);
    this.jobs.set(job.id, structuredClone(job));
    for (const ln of job.lines ?? []) this.changedLines.push(ln);
  }

  moveJob(id, line) {
    const job = this.jobs.get(id);
    if (!job) throw new TxnError(`unknown job '${id}'`);
    job.lines = [line];
    this.changedLines.push(line);
  }

  savepoint(name) {
    this.savepoints.push({ name, snap: this.snapshot() });
  }

  rollback(name) {
    for (let i = this.savepoints.length - 1; i >= 0; i--) {
      if (this.savepoints[i].name === name) {
        this.jobs = this.savepoints[i].snap;
        this.savepoints.length = i + 1; // keep the named savepoint, drop later ones
        return;
      }
    }
    throw new TxnError(`no such savepoint '${name}'`);
  }

  jobList() {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }
}
