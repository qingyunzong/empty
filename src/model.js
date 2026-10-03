'use strict';

// Plain model mutations, shared by the engine (exec) and the reference
// reducer. Model shape:
//   { plates: Map<plate, { wells: Map<well, raw>, controls: { neg, pos } }>,
//     groups: Map<group, Set<"plate/well">> }

function createModel() {
  return { plates: new Map(), groups: new Map() };
}

function memberKey(plate, well) {
  return `${plate}/${well}`;
}

function requirePlate(model, plate) {
  const p = model.plates.get(plate);
  if (!p) throw new Error(`unknown plate: ${plate}`);
  return p;
}

function requireGroup(model, group) {
  const g = model.groups.get(group);
  if (!g) throw new Error(`unknown group: ${group}`);
  return g;
}

function applyToModel(model, op) {
  switch (op.type) {
    case 'noop':
      return;
    case 'batch':
      for (const sub of op.ops) applyToModel(model, sub);
      return;
    case 'addPlate':
      if (model.plates.has(op.plate)) throw new Error(`plate exists: ${op.plate}`);
      model.plates.set(op.plate, { wells: new Map(), controls: { neg: null, pos: null } });
      return;
    case 'removePlate': {
      const p = requirePlate(model, op.plate);
      model.plates.delete(op.plate);
      for (const members of model.groups.values()) {
        for (const key of [...members]) {
          const sep = key.indexOf('/');
          if (key.slice(0, sep) === op.plate && p.wells.has(key.slice(sep + 1))) members.delete(key);
        }
      }
      return;
    }
    case 'setWell':
      requirePlate(model, op.plate).wells.set(op.well, op.value);
      return;
    case 'removeWell': {
      const p = requirePlate(model, op.plate);
      p.wells.delete(op.well);
      const key = memberKey(op.plate, op.well);
      for (const members of model.groups.values()) members.delete(key);
      return;
    }
    case 'setControl': {
      if (op.kind !== 'neg' && op.kind !== 'pos') throw new Error(`bad control kind: ${op.kind}`);
      requirePlate(model, op.plate).controls[op.kind] = op.well == null ? null : op.well;
      return;
    }
    case 'addGroup':
      if (model.groups.has(op.group)) throw new Error(`group exists: ${op.group}`);
      model.groups.set(op.group, new Set());
      return;
    case 'removeGroup':
      requireGroup(model, op.group);
      model.groups.delete(op.group);
      return;
    case 'addToGroup':
      requireGroup(model, op.group).add(memberKey(op.plate, op.well));
      return;
    case 'removeFromGroup':
      requireGroup(model, op.group).delete(memberKey(op.plate, op.well));
      return;
    case 'moveWell': {
      const key = memberKey(op.plate, op.well);
      if (op.from != null) requireGroup(model, op.from).delete(key);
      if (op.to != null) requireGroup(model, op.to).add(key);
      return;
    }
    default:
      throw new Error(`unknown op type: ${op.type}`);
  }
}

module.exports = { createModel, memberKey, applyToModel };
