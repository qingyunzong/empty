'use strict';

// Pure node-state computation shared by the incremental engine and the
// naive reference evaluator. A node state is always:
//   { value: number|null, error: string|null, reason: string|null, invalid: boolean }

const E_QC = 'E_QC';

const ok = (value) => ({ value, error: null, reason: null, invalid: false });
const qcError = (reason) => ({ value: null, error: E_QC, reason, invalid: false });
const invalidValue = () => ({ value: null, error: null, reason: null, invalid: true });

function propagate(spec, depStates) {
  for (const depId of [...spec.deps].sort()) {
    const st = depStates.get(depId);
    if (st && st.error) return qcError(`propagated from ${depId}: ${st.reason}`);
  }
  return null;
}

function meanOf(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// spec: { kind, deps: [sorted ids], ctx: {...} }
// depStates: Map<id, state>
function compute(spec, depStates) {
  switch (spec.kind) {
    case 'well':
      return ok(spec.ctx.raw);

    case 'ctrl': {
      if (spec.ctx.mapping === 'none') return qcError(`missing ${spec.ctx.ctrlKind} control mapping`);
      if (spec.ctx.mapping === 'missing') return qcError(`${spec.ctx.ctrlKind} control well missing`);
      const prop = propagate(spec, depStates);
      if (prop) return prop;
      return ok(depStates.get(spec.ctx.mappedId).value);
    }

    case 'corr': {
      const prop = propagate(spec, depStates);
      if (prop) return prop;
      return ok(depStates.get(spec.ctx.wellId).value - depStates.get(spec.ctx.negId).value);
    }

    case 'ratio': {
      const prop = propagate(spec, depStates);
      if (prop) return prop;
      const raw = depStates.get(spec.ctx.wellId).value;
      const neg = depStates.get(spec.ctx.negId).value;
      const pos = depStates.get(spec.ctx.posId).value;
      const denom = pos - neg;
      if (denom === 0) return invalidValue();
      return ok((raw - neg) / denom);
    }

    case 'plateMean': {
      if (spec.ctx.nWells === 0) return qcError('empty plate');
      const prop = propagate(spec, depStates);
      if (prop) return prop;
      return ok(meanOf(spec.deps.map((d) => depStates.get(d).value)));
    }

    case 'repMean': {
      if (spec.ctx.n === 0) return qcError('empty replicate group');
      if (spec.ctx.missing > 0) return qcError('member well missing');
      const prop = propagate(spec, depStates);
      if (prop) return prop;
      return ok(meanOf(spec.deps.map((d) => depStates.get(d).value)));
    }

    case 'repCV': {
      if (spec.ctx.n === 0) return qcError('empty replicate group');
      if (spec.ctx.missing > 0) return qcError('member well missing');
      if (spec.ctx.n < 2) return qcError('insufficient replicates');
      const prop = propagate(spec, depStates);
      if (prop) return prop;
      const values = spec.deps.map((d) => depStates.get(d).value);
      const mean = meanOf(values);
      if (mean === 0) return invalidValue(); // CV denominator is zero
      let sq = 0;
      for (const v of values) sq += (v - mean) * (v - mean);
      const sd = Math.sqrt(sq / (values.length - 1)); // sample SD (n-1)
      return ok((sd / mean) * 100);
    }

    default:
      throw new Error(`unknown node kind: ${spec.kind}`);
  }
}

// Build the desired node set (id -> spec) from the plain model.
// model: { plates: Map<plate,{wells:Map<well,raw>,controls:{neg,pos}}>, groups: Map<group,Set<"plate/well">> }
function buildSpecs(model) {
  const specs = new Map();
  for (const plate of [...model.plates.keys()].sort()) {
    const p = model.plates.get(plate);
    for (const ctrlKind of ['neg', 'pos']) {
      const id = `ctrl:${plate}:${ctrlKind}`;
      const mapped = p.controls[ctrlKind];
      const spec = { kind: 'ctrl', deps: [], ctx: { ctrlKind } };
      if (mapped == null) {
        spec.ctx.mapping = 'none';
      } else if (!p.wells.has(mapped)) {
        spec.ctx.mapping = 'missing';
      } else {
        spec.ctx.mapping = 'ok';
        spec.ctx.mappedId = `well:${plate}:${mapped}`;
        spec.deps = [spec.ctx.mappedId];
      }
      specs.set(id, spec);
    }
    const corrIds = [];
    for (const well of [...p.wells.keys()].sort()) {
      const wellId = `well:${plate}:${well}`;
      const negId = `ctrl:${plate}:neg`;
      const posId = `ctrl:${plate}:pos`;
      specs.set(wellId, { kind: 'well', deps: [], ctx: { raw: p.wells.get(well) } });
      const corrId = `corr:${plate}:${well}`;
      specs.set(corrId, { kind: 'corr', deps: [negId, wellId], ctx: { wellId, negId } });
      specs.set(`ratio:${plate}:${well}`, {
        kind: 'ratio',
        deps: [negId, posId, wellId],
        ctx: { wellId, negId, posId },
      });
      corrIds.push(corrId);
    }
    specs.set(`mean:${plate}`, { kind: 'plateMean', deps: corrIds, ctx: { nWells: p.wells.size } });
  }
  for (const group of [...model.groups.keys()].sort()) {
    const members = model.groups.get(group);
    const deps = [];
    let missing = 0;
    for (const key of [...members].sort()) {
      const sep = key.indexOf('/');
      const plate = key.slice(0, sep);
      const well = key.slice(sep + 1);
      const p = model.plates.get(plate);
      if (p && p.wells.has(well)) deps.push(`corr:${plate}:${well}`);
      else missing += 1;
    }
    specs.set(`rep:${group}:mean`, { kind: 'repMean', deps, ctx: { n: members.size, missing } });
    specs.set(`rep:${group}:cv`, { kind: 'repCV', deps, ctx: { n: members.size, missing } });
  }
  return specs;
}

module.exports = { E_QC, ok, qcError, invalidValue, compute, buildSpecs };
