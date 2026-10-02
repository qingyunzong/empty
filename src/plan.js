'use strict';

class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

const STEP_TYPES = new Set(['reserve', 'commit', 'cancel', 'freeze']);

function fail(message) {
  throw new PlanError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePlan(plan) {
  if (!isObject(plan)) fail('plan must be an object');

  const accounts = plan.accounts;
  if (!isObject(accounts)) fail('accounts must be an object');
  const accountNames = Object.keys(accounts);
  if (accountNames.length === 0) fail('accounts must not be empty');
  for (const name of accountNames) {
    const balance = accounts[name];
    if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) {
      fail(`invalid balance for account ${name}`);
    }
  }

  const actorsObj = plan.actors;
  if (!isObject(actorsObj)) fail('actors must be an object');
  const actors = Object.keys(actorsObj).sort().map((name) => {
    const steps = actorsObj[name];
    if (!Array.isArray(steps)) fail(`actor ${name} steps must be an array`);
    return { name, steps };
  });

  const initialFrozen = [];
  if (plan.freeze !== undefined) {
    if (!Array.isArray(plan.freeze)) fail('freeze must be an array of account ids');
    for (const account of plan.freeze) {
      if (!accountNames.includes(account)) fail(`unknown frozen account ${account}`);
      if (!initialFrozen.includes(account)) initialFrozen.push(account);
    }
  }

  for (const actor of actors) {
    for (const step of actor.steps) {
      if (!isObject(step)) fail('step must be an object');
      if (typeof step.type !== 'string' || !STEP_TYPES.has(step.type)) {
        fail(`unknown step type ${step.type}`);
      }
    }
  }

  const reserves = new Map();
  for (const actor of actors) {
    for (const step of actor.steps) {
      if (step.type !== 'reserve') continue;
      if (typeof step.id !== 'string' || step.id === '') fail('reserve id must be a non-empty string');
      if (reserves.has(step.id)) fail(`duplicate transfer id ${step.id}`);
      if (!accountNames.includes(step.from)) fail(`unknown from account ${step.from}`);
      if (!accountNames.includes(step.to)) fail(`unknown to account ${step.to}`);
      if (typeof step.amount !== 'number' || !Number.isFinite(step.amount) || step.amount < 0) {
        fail(`invalid amount for transfer ${step.id}`);
      }
      reserves.set(step.id, { from: step.from, to: step.to, amount: step.amount });
    }
  }

  const commits = new Map();
  const cancels = new Map();
  for (const actor of actors) {
    actor.steps.forEach((step, index) => {
      if (step.type === 'commit' || step.type === 'cancel') {
        if (typeof step.id !== 'string' || !reserves.has(step.id)) {
          fail(`unknown transfer id ${step.id}`);
        }
        const registry = step.type === 'commit' ? commits : cancels;
        if (registry.has(step.id)) fail(`duplicate ${step.type} for transfer ${step.id}`);
        registry.set(step.id, { actor: actor.name, index });
      } else if (step.type === 'freeze') {
        if (!accountNames.includes(step.account)) fail(`unknown account ${step.account}`);
      }
    });
  }

  for (const [id, cancel] of cancels) {
    const commit = commits.get(id);
    if (commit && commit.actor === cancel.actor && cancel.index < commit.index) {
      fail(`transfer ${id} cancelled before committed in program order`);
    }
  }

  return {
    accounts: accountNames,
    initialBalances: accounts,
    initialFrozen,
    actors,
    transfers: reserves,
  };
}

module.exports = { validatePlan, PlanError };
