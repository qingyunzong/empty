export class CancelledError extends Error {
    constructor(message = "saga cancelled") {
        super(message);
        this.name = "CancelledError";
    }
}
export class SagaError extends Error {
    cause;
    compensationErrors;
    constructor(cause, compensationErrors) {
        const base = cause instanceof Error ? cause.message : String(cause);
        const suffix = compensationErrors.length > 0
            ? `; rollback incomplete: ${compensationErrors.length} compensation(s) failed`
            : "; rollback completed";
        super(`saga failed: ${base}${suffix}`);
        this.name = "SagaError";
        this.cause = cause;
        this.compensationErrors = compensationErrors;
    }
}
export class Saga {
    states = new Map();
    order;
    controller = new AbortController();
    constructor(steps) {
        for (const step of steps) {
            if (this.states.has(step.id)) {
                throw new Error(`duplicate step id: ${step.id}`);
            }
            this.states.set(step.id, { step, status: "pending" });
        }
        for (const step of steps) {
            for (const dep of step.dependsOn ?? []) {
                if (!this.states.has(dep)) {
                    throw new Error(`step "${step.id}" depends on unknown step "${dep}"`);
                }
            }
        }
        this.order = topoSort(steps);
    }
    cancel() {
        this.controller.abort();
    }
    get signal() {
        return this.controller.signal;
    }
    async execute() {
        const ctx = { signal: this.controller.signal };
        let failure = null;
        for (const step of this.order) {
            const state = this.states.get(step.id);
            if (failure !== null || this.controller.signal.aborted) {
                state.status = "skipped";
                continue;
            }
            const depsFailed = (step.dependsOn ?? []).some((dep) => this.states.get(dep).status !== "succeeded");
            if (depsFailed) {
                state.status = "skipped";
                continue;
            }
            state.status = "running";
            try {
                await step.run(ctx);
                state.status = "succeeded";
            }
            catch (err) {
                state.status = "failed";
                failure = err;
            }
        }
        if (failure === null && this.controller.signal.aborted) {
            failure = new CancelledError();
        }
        if (failure === null)
            return;
        throw new SagaError(failure, await this.compensate(ctx));
    }
    async compensate(ctx) {
        const errors = [];
        for (const step of [...this.order].reverse()) {
            const state = this.states.get(step.id);
            if (state.status !== "succeeded" || !step.compensate)
                continue;
            try {
                await step.compensate(ctx);
            }
            catch (err) {
                errors.push(err);
            }
        }
        return errors;
    }
}
function topoSort(steps) {
    const indegree = new Map();
    const dependents = new Map();
    for (const step of steps) {
        indegree.set(step.id, step.dependsOn?.length ?? 0);
        for (const dep of step.dependsOn ?? []) {
            const list = dependents.get(dep) ?? [];
            list.push(step.id);
            dependents.set(dep, list);
        }
    }
    const byId = new Map(steps.map((s) => [s.id, s]));
    const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
    const order = [];
    while (queue.length > 0) {
        const id = queue.shift();
        order.push(byId.get(id));
        for (const next of dependents.get(id) ?? []) {
            const remaining = indegree.get(next) - 1;
            indegree.set(next, remaining);
            if (remaining === 0)
                queue.push(next);
        }
    }
    if (order.length !== steps.length) {
        throw new Error("dependency cycle detected");
    }
    return order;
}
