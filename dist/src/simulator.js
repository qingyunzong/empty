"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Simulator = void 0;
function compare(cmp, left, right) {
    switch (cmp) {
        case 'eq': return left === right;
        case 'ne': return left !== right;
        case 'lt': return left < right;
        case 'le': return left <= right;
        case 'gt': return left > right;
        case 'ge': return left >= right;
    }
}
function resolveOperand(operand, locals) {
    return typeof operand === 'number' ? operand : locals[operand.local] ?? 0;
}
class Simulator {
    constructor(programs, initialShared = {}) {
        if (programs.length < 1 || programs.length > 3) {
            throw new Error(`expected 1 to 3 threads, got ${programs.length}`);
        }
        this.programs = programs;
        this.shared = { ...initialShared };
        this.locks = {};
        programs.forEach((program, index) => {
            program.forEach((instr) => {
                if (instr.op === 'lock' || instr.op === 'unlock') {
                    if (!(instr.lock in this.locks))
                        this.locks[instr.lock] = null;
                }
                if (instr.op === 'branch') {
                    for (const target of [instr.then, instr.else]) {
                        if (!Number.isInteger(target) || target < 0 || target > program.length) {
                            throw new Error(`thread ${index}: branch target ${target} out of range`);
                        }
                    }
                }
            });
        });
        this.threads = programs.map((program) => ({
            pc: 0,
            locals: {},
            done: program.length === 0,
        }));
        this.steps = 0;
    }
    clone() {
        const copy = Object.create(Simulator.prototype);
        copy.programs = this.programs;
        copy.shared = { ...this.shared };
        copy.locks = { ...this.locks };
        copy.threads = this.threads.map((t) => ({ pc: t.pc, locals: { ...t.locals }, done: t.done }));
        copy.steps = this.steps;
        return copy;
    }
    isBlocked(t) {
        const thread = this.threads[t];
        if (!thread || thread.done)
            return false;
        const instr = this.programs[t][thread.pc];
        if (!instr || instr.op !== 'lock')
            return false;
        const holder = this.locks[instr.lock];
        return holder !== null && holder !== undefined && holder !== t;
    }
    isRunnable(t) {
        const thread = this.threads[t];
        return !!thread && !thread.done && !this.isBlocked(t);
    }
    status() {
        if (this.threads.every((t) => t.done))
            return 'finished';
        for (let t = 0; t < this.threads.length; t++) {
            if (this.isRunnable(t))
                return 'running';
        }
        return 'deadlock';
    }
    step(t) {
        const thread = this.threads[t];
        if (!thread)
            throw new Error(`invalid thread id ${t}`);
        if (thread.done)
            throw new Error(`thread ${t} already finished`);
        if (this.isBlocked(t))
            throw new Error(`thread ${t} is blocked on a lock`);
        const instr = this.programs[t][thread.pc];
        if (!instr)
            throw new Error(`thread ${t} has no instruction at pc ${thread.pc}`);
        switch (instr.op) {
            case 'read':
                thread.locals[instr.into] = this.shared[instr.shared] ?? 0;
                thread.pc++;
                break;
            case 'write':
                this.shared[instr.shared] = resolveOperand(instr.from, thread.locals);
                thread.pc++;
                break;
            case 'add':
                thread.locals[instr.local] = (thread.locals[instr.local] ?? 0) + instr.value;
                thread.pc++;
                break;
            case 'lock': {
                const holder = this.locks[instr.lock];
                if (holder === t)
                    throw new Error(`thread ${t} re-acquires lock ${instr.lock}`);
                this.locks[instr.lock] = t;
                thread.pc++;
                break;
            }
            case 'unlock':
                if (this.locks[instr.lock] !== t) {
                    throw new Error(`thread ${t} releases lock ${instr.lock} it does not hold`);
                }
                this.locks[instr.lock] = null;
                thread.pc++;
                break;
            case 'branch': {
                const left = thread.locals[instr.cond.local] ?? 0;
                thread.pc = compare(instr.cond.cmp, left, instr.cond.value) ? instr.then : instr.else;
                break;
            }
        }
        if (thread.pc >= this.programs[t].length)
            thread.done = true;
        this.steps++;
    }
    run(schedule) {
        for (const t of schedule) {
            const status = this.status();
            if (status !== 'running') {
                throw new Error(`schedule continues past ${status} at step ${this.steps}`);
            }
            this.step(t);
        }
        return this.result();
    }
    result() {
        const status = this.status();
        return {
            status: status === 'running' ? 'incomplete' : status,
            shared: { ...this.shared },
            locks: { ...this.locks },
        };
    }
}
exports.Simulator = Simulator;
