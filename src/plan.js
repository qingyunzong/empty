// Plan JSON construction and certificate verification. The certificate is a
// SHA-256 hash over the canonical (key-sorted) JSON of every plan field
// except the certificate itself; `verify` also re-runs the full pipeline on
// the embedded DSL source and checks the recorded plan is still optimal.

import { createHash } from 'node:crypto';
import { formatRational } from './rational.js';

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function certificateOf(planWithoutCert) {
  return createHash('sha256').update(canonicalize(planWithoutCert), 'utf8').digest('hex');
}

export function buildPlan({ source, file, model, result }) {
  const plan = {
    format: 'recipe-plan/1',
    recipe: model.recipe ?? null,
    source_file: file,
    source,
    status: result.status,
    ingredients: model.ingredients.map((ing, i) => ({
      name: ing.name,
      grams: result.plan.grams[ing.name],
      cost_per_g: formatRational(ing.attrs.get('cost').value),
      allergen_per_g: formatRational(ing.attrs.get('allergen').value),
    })),
    total_grams: result.plan.grams ? Object.values(result.plan.grams).reduce((a, b) => a + b, 0) : 0,
    cost: formatRational(result.plan.cost),
    budget: model.budget ? formatRational(model.budget) : null,
    allergen: formatRational(result.plan.allergen),
    constraints: result.plan.margins.map((m) => ({
      line: m.line,
      op: m.op,
      lhs: formatRational(m.lhs),
      rhs: formatRational(m.rhs),
      margin: formatRational(m.margin),
    })),
  };
  plan.certificate = certificateOf(plan);
  return plan;
}

// Returns { ok, reasons }.
export function verifyPlan(plan, pipeline) {
  const reasons = [];
  if (!plan || typeof plan !== 'object') return { ok: false, reasons: ['plan is not a JSON object'] };
  if (plan.format !== 'recipe-plan/1') reasons.push(`unsupported format ${JSON.stringify(plan.format)}`);
  if (typeof plan.source !== 'string') reasons.push('plan is missing the embedded DSL source');
  if (typeof plan.certificate !== 'string') reasons.push('plan is missing the certificate');
  if (reasons.length) return { ok: false, reasons };

  const { certificate, ...rest } = plan;
  const actual = certificateOf(rest);
  if (actual !== certificate) {
    reasons.push(`certificate mismatch: expected ${actual}, found ${certificate}`);
  }

  if (typeof plan.source === 'string') {
    const { model, result } = pipeline(plan.source, plan.source_file ?? '<plan>');
    if (result.status !== plan.status) {
      reasons.push(`re-optimization yields status ${result.status}, plan claims ${plan.status}`);
    } else if (result.status === 'OPTIMAL' || result.status === 'OVER_BUDGET') {
      const replanned = buildPlan({ source: plan.source, file: plan.source_file ?? '<plan>', model, result });
      const fields = ['cost', 'allergen', 'budget'];
      for (const f of fields) {
        if (replanned[f] !== plan[f]) reasons.push(`field '${f}' mismatch: re-optimized ${replanned[f]}, plan says ${plan[f]}`);
      }
      const reg = replanned.ingredients.map((i) => [i.name, i.grams]);
      const plg = (plan.ingredients ?? []).map((i) => [i.name, i.grams]);
      if (JSON.stringify(reg) !== JSON.stringify(plg)) {
        reasons.push(`ingredient grams mismatch: re-optimized ${JSON.stringify(reg)}, plan says ${JSON.stringify(plg)}`);
      }
      if (JSON.stringify(replanned.constraints) !== JSON.stringify(plan.constraints)) {
        reasons.push('constraint margins mismatch');
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}
