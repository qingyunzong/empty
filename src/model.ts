export type VarName = string;
export type Value = string;
export type State = Map<VarName, Value>;

export interface ControlDep {
  on: number;
  when: boolean;
}

export interface Event {
  id: number;
  kind: 'assign' | 'branch';
  reads: VarName[];
  writes: VarName[];
  controlDeps: ControlDep[];
  apply?: (state: State) => Record<VarName, Value>;
  decide?: (state: State) => boolean;
}

export interface Criterion {
  event: number;
  var: VarName;
}

export function validateTrace(trace: Event[]): void {
  trace.forEach((e, i) => {
    if (e.id !== i) throw new Error(`event id ${e.id} != position ${i}`);
    if (e.kind === 'assign' && typeof e.apply !== 'function') {
      throw new Error(`assign event ${e.id} missing apply`);
    }
    if (e.kind === 'branch' && typeof e.decide !== 'function') {
      throw new Error(`branch event ${e.id} missing decide`);
    }
    for (const dep of e.controlDeps) {
      if (dep.on >= e.id) throw new Error(`event ${e.id} controlled by later event ${dep.on}`);
      const ctrl = trace[dep.on];
      if (!ctrl || ctrl.kind !== 'branch') throw new Error(`event ${e.id} controller ${dep.on} is not a branch`);
    }
  });
}
