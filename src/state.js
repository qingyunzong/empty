'use strict';
// Event log folding: turns a JSONL event stream into a materialized state.
// All constraint violations are recorded (not thrown) so verify can explain them.

const EVENT_TYPES = ['register', 'aliquot', 'assay', 'qc_fail', 'revoke', 'attest', 'snapshot'];

function emptyState() {
  return {
    entities: new Map(),   // id -> {id, kind, ...}
    parents: new Map(),    // child id -> [parent ids]
    children: new Map(),   // parent id -> [child ids]
    qcFailed: new Set(),
    revoked: new Map(),    // id -> {reason, time}
    attestations: new Map(), // assay id -> {signature, time}
    violations: [],        // [{code, target, detail, event}]
    order: [],             // event sequence for auditability
  };
}

function addEdge(state, child, parent) {
  if (!state.parents.has(child)) state.parents.set(child, []);
  state.parents.get(child).push(parent);
  if (!state.children.has(parent)) state.children.set(parent, []);
  state.children.get(parent).push(child);
}

function violate(state, code, target, detail, event) {
  state.violations.push({ code, target, detail, event });
}

function foldEvent(state, ev) {
  state.order.push(ev);
  switch (ev.type) {
    case 'register': {
      if (state.entities.has(ev.id)) {
        violate(state, 'DUP_ID', ev.id, `duplicate register of ${ev.id}`, ev);
        return state;
      }
      if (ev.kind === 'sample') {
        state.entities.set(ev.id, { id: ev.id, kind: 'sample', volume: ev.volume, time: ev.time });
      } else if (ev.kind === 'batch') {
        state.entities.set(ev.id, {
          id: ev.id, kind: 'batch', reagent: ev.reagent,
          compatible: ev.compatible || [ev.reagent], time: ev.time,
        });
      } else {
        violate(state, 'BAD_KIND', ev.id, `unknown entity kind ${ev.kind}`, ev);
      }
      return state;
    }
    case 'aliquot': {
      if (state.entities.has(ev.id)) {
        violate(state, 'DUP_ID', ev.id, `duplicate id ${ev.id}`, ev);
        return state;
      }
      const parent = state.entities.get(ev.parent);
      if (!parent) {
        violate(state, 'NO_PARENT', ev.id, `aliquot parent ${ev.parent} not registered`, ev);
        return state;
      }
      state.entities.set(ev.id, { id: ev.id, kind: 'aliquot', volume: ev.volume, time: ev.time });
      addEdge(state, ev.id, ev.parent);
      // Volume conservation: sum of aliquot volumes drawn from a parent must
      // not exceed the parent's volume.
      const drawn = state.children.get(ev.parent)
        .filter((c) => state.entities.get(c).kind === 'aliquot')
        .reduce((s, c) => s + (state.entities.get(c).volume || 0), 0);
      if (typeof parent.volume === 'number' && drawn > parent.volume) {
        violate(state, 'VOLUME', ev.id,
          `volume conservation violated on ${ev.parent}: drawn ${drawn} > ${parent.volume}`, ev);
      }
      return state;
    }
    case 'assay': {
      if (state.entities.has(ev.id)) {
        violate(state, 'DUP_ID', ev.id, `duplicate id ${ev.id}`, ev);
        return state;
      }
      const parent = state.entities.get(ev.parent);
      if (!parent) {
        violate(state, 'NO_PARENT', ev.id, `assay parent ${ev.parent} not registered`, ev);
        return state;
      }
      const batch = state.entities.get(ev.batch);
      state.entities.set(ev.id, {
        id: ev.id, kind: 'assay', reagent: ev.reagent,
        conclusion: ev.conclusion, batch: ev.batch, time: ev.time,
      });
      addEdge(state, ev.id, ev.parent);
      if (!batch || batch.kind !== 'batch') {
        violate(state, 'NO_BATCH', ev.id, `reagent batch ${ev.batch} not registered`, ev);
      } else {
        addEdge(state, ev.id, ev.batch);
        // Batch/reagent compatibility gate.
        if (!batch.compatible.includes(ev.reagent)) {
          violate(state, 'REAGENT', ev.id,
            `reagent ${ev.reagent} incompatible with batch ${ev.batch} (allows ${batch.compatible.join(',')})`, ev);
        }
      }
      return state;
    }
    case 'qc_fail': {
      if (!state.entities.has(ev.target)) {
        violate(state, 'NO_TARGET', ev.target, `qc_fail target ${ev.target} unknown`, ev);
        return state;
      }
      state.qcFailed.add(ev.target);
      return state;
    }
    case 'revoke': {
      if (!state.entities.has(ev.target)) {
        violate(state, 'NO_TARGET', ev.target, `revoke target ${ev.target} unknown`, ev);
        return state;
      }
      state.revoked.set(ev.target, { reason: ev.reason || '', time: ev.time });
      return state;
    }
    case 'attest': {
      const t = state.entities.get(ev.target);
      if (!t || t.kind !== 'assay') {
        violate(state, 'NO_TARGET', ev.target, `attest target ${ev.target} is not an assay`, ev);
        return state;
      }
      state.attestations.set(ev.target, { signature: ev.signature, time: ev.time });
      return state;
    }
    case 'snapshot': {
      // A compact-produced snapshot replaces the folded state wholesale.
      return stateFromSnapshot(ev.state);
    }
    default:
      violate(state, 'BAD_EVENT', null, `unknown event type ${ev.type}`, ev);
      return state;
  }
}

function stateFromSnapshot(s) {
  const state = emptyState();
  state.entities = new Map(s.entities.map((e) => [e.id, e]));
  state.parents = new Map(s.parents.map(([k, v]) => [k, v]));
  state.children = new Map(s.children.map(([k, v]) => [k, v]));
  state.qcFailed = new Set(s.qcFailed);
  state.revoked = new Map(s.revoked);
  state.attestations = new Map(s.attestations);
  state.violations = s.violations.slice();
  state.order = s.order ? s.order.slice() : [];
  return state;
}

function snapshotOf(state) {
  return {
    entities: [...state.entities.values()],
    parents: [...state.parents.entries()],
    children: [...state.children.entries()],
    qcFailed: [...state.qcFailed],
    revoked: [...state.revoked.entries()],
    attestations: [...state.attestations.entries()],
    violations: state.violations,
    order: state.order,
  };
}

function foldEvents(events) {
  let state = emptyState();
  for (const ev of events) state = foldEvent(state, ev);
  return state;
}

module.exports = { EVENT_TYPES, emptyState, foldEvent, foldEvents, snapshotOf, stateFromSnapshot };
