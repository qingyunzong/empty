export class PlanError extends Error {
  constructor(details) {
    super(`INVALID_PLAN: ${details.join('; ')}`);
    this.name = 'PlanError';
    this.details = details;
  }
}

const STEP_TYPES = new Set(['reserve', 'commit', 'cancel', 'freeze']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeStep(raw, actorId, accountIds, errors) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`actor ${actorId}: step must be an object`);
    return null;
  }
  if (!isNonEmptyString(raw.id)) {
    errors.push(`actor ${actorId}: every step needs a non-empty string id`);
    return null;
  }
  if (!STEP_TYPES.has(raw.type)) {
    errors.push(`step ${raw.id}: unknown step type: ${String(raw.type)}`);
    return null;
  }
  switch (raw.type) {
    case 'reserve': {
      if (!isNonEmptyString(raw.transfer)) {
        errors.push(`step ${raw.id}: reserve needs a transfer id`);
        return null;
      }
      if (!accountIds.has(raw.from)) {
        errors.push(`step ${raw.id}: unknown account id: ${String(raw.from)}`);
        return null;
      }
      if (!accountIds.has(raw.to)) {
        errors.push(`step ${raw.id}: unknown account id: ${String(raw.to)}`);
        return null;
      }
      if (!Number.isInteger(raw.amount) || raw.amount <= 0) {
        errors.push(`step ${raw.id}: amount must be a positive integer`);
        return null;
      }
      return { id: raw.id, type: 'reserve', transfer: raw.transfer, from: raw.from, to: raw.to, amount: raw.amount };
    }
    case 'commit':
    case 'cancel': {
      if (!isNonEmptyString(raw.transfer)) {
        errors.push(`step ${raw.id}: ${raw.type} needs a transfer id`);
        return null;
      }
      return { id: raw.id, type: raw.type, transfer: raw.transfer };
    }
    case 'freeze': {
      if (!accountIds.has(raw.account)) {
        errors.push(`step ${raw.id}: unknown account id: ${String(raw.account)}`);
        return null;
      }
      return { id: raw.id, type: 'freeze', account: raw.account };
    }
    default:
      return null;
  }
}

// Validates a raw plan object and returns a normalized plan:
//   { accounts: [{id, balance}], actors: [{id, steps: [...]}], initialTotal }
// Freeze-plan entries become the ordered steps of an extra "freeze" actor.
// Throws PlanError listing every problem found.
export function normalizePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new PlanError(['plan must be a JSON object']);
  }
  const { accounts, actors, freeze } = plan;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    errors.push('accounts must be a non-empty array');
  }
  if (!Array.isArray(actors)) {
    errors.push('actors must be an array');
  }
  if (freeze !== undefined && !Array.isArray(freeze)) {
    errors.push('freeze must be an array when present');
  }
  if (errors.length > 0) throw new PlanError(errors);

  const accountIds = new Set();
  const normalizedAccounts = [];
  for (const account of accounts) {
    if (!account || typeof account !== 'object' || !isNonEmptyString(account.id)) {
      errors.push('every account needs a non-empty string id');
      continue;
    }
    if (accountIds.has(account.id)) {
      errors.push(`duplicate account id: ${account.id}`);
      continue;
    }
    accountIds.add(account.id);
    if (!Number.isInteger(account.balance) || account.balance < 0) {
      errors.push(`account ${account.id}: balance must be a non-negative integer`);
      continue;
    }
    normalizedAccounts.push({ id: account.id, balance: account.balance });
  }

  const normalizedActors = [];
  const actorIds = new Set();
  for (const actor of actors) {
    if (!actor || typeof actor !== 'object' || !isNonEmptyString(actor.id)) {
      errors.push('every actor needs a non-empty string id');
      continue;
    }
    if (actorIds.has(actor.id)) {
      errors.push(`duplicate actor id: ${actor.id}`);
      continue;
    }
    actorIds.add(actor.id);
    if (!Array.isArray(actor.steps)) {
      errors.push(`actor ${actor.id}: steps must be an array`);
      continue;
    }
    normalizedActors.push({ id: actor.id, steps: actor.steps });
  }
  if (Array.isArray(freeze) && freeze.length > 0) {
    if (actorIds.has('freeze')) {
      errors.push('duplicate actor id: freeze');
    } else {
      actorIds.add('freeze');
      const freezeSteps = freeze.map((entry) => ({
        ...(entry && typeof entry === 'object' ? entry : {}),
        type: 'freeze',
      }));
      normalizedActors.push({ id: 'freeze', steps: freezeSteps });
    }
  }
  if (errors.length > 0) throw new PlanError(errors);

  const stepIds = new Set();
  const transfers = new Map();
  const references = [];
  for (const actor of normalizedActors) {
    const steps = [];
    for (const raw of actor.steps) {
      const step = normalizeStep(raw, actor.id, accountIds, errors);
      if (!step) continue;
      if (stepIds.has(step.id)) {
        errors.push(`duplicate step id: ${step.id}`);
        continue;
      }
      stepIds.add(step.id);
      steps.push(step);
      if (step.type === 'reserve') {
        if (transfers.has(step.transfer)) {
          errors.push(`duplicate transfer id: ${step.transfer}`);
        } else {
          transfers.set(step.transfer, step);
        }
      } else if (step.type === 'commit' || step.type === 'cancel') {
        references.push(step);
      }
    }
    actor.steps = steps;
  }
  for (const step of references) {
    if (!transfers.has(step.transfer)) {
      errors.push(`step ${step.id}: unknown transfer id: ${step.transfer}`);
    }
  }

  // Program-order rules inside each actor: a transfer's reserve must come
  // before its commit/cancel, and cancel must never precede commit.
  for (const actor of normalizedActors) {
    const positions = new Map();
    actor.steps.forEach((step, index) => {
      if (step.type === 'reserve' || step.type === 'commit' || step.type === 'cancel') {
        if (!positions.has(step.transfer)) positions.set(step.transfer, {});
        positions.get(step.transfer)[step.type] = index;
      }
    });
    for (const [transfer, pos] of positions) {
      if (pos.reserve !== undefined && pos.commit !== undefined && pos.commit < pos.reserve) {
        errors.push(`actor ${actor.id}: commit of transfer ${transfer} before its reserve`);
      }
      if (pos.reserve !== undefined && pos.cancel !== undefined && pos.cancel < pos.reserve) {
        errors.push(`actor ${actor.id}: cancel of transfer ${transfer} before its reserve`);
      }
      if (pos.cancel !== undefined && pos.commit !== undefined && pos.cancel < pos.commit) {
        errors.push(`actor ${actor.id}: cancel of transfer ${transfer} before its commit`);
      }
    }
  }
  if (errors.length > 0) throw new PlanError(errors);

  const initialTotal = normalizedAccounts.reduce((sum, account) => sum + account.balance, 0);
  return { accounts: normalizedAccounts, actors: normalizedActors, initialTotal };
}
