'use strict';

const { solvePlacement } = require('./solver');

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const DEFAULT_TIERS = [1, 0.75, 0.5, 0.25];
const DEFAULT_BUDGET = 100000;

function toCents(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InputError(`invalid amount for ${field}: ${JSON.stringify(value)}`);
  }
  return Math.round(value * 100);
}

function toUnits(cents) {
  return cents / 100;
}

function normalizeTiers(raw) {
  if (raw === undefined) return DEFAULT_TIERS;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InputError('tiers must be a non-empty array');
  }
  for (const t of raw) {
    if (typeof t !== 'number' || !(t > 0) || t > 1) {
      throw new InputError(`invalid tier: ${t}`);
    }
  }
  return [...new Set(raw)].sort((a, b) => b - a);
}

function normalizeBudget(raw) {
  if (raw === undefined) return DEFAULT_BUDGET;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new InputError('budget must be a positive integer');
  }
  return raw;
}

function run(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('input must be an object');
  }
  const sharedLimit = toCents(input.sharedLimit, 'sharedLimit');
  const budget = normalizeBudget(input.budget);
  const tiers = normalizeTiers(input.tiers);

  if (!Array.isArray(input.cards) || input.cards.length === 0) {
    throw new InputError('cards must be a non-empty array');
  }
  const cards = new Map();
  for (const c of input.cards) {
    if (!c || typeof c.id !== 'string') throw new InputError('each card requires a string id');
    if (cards.has(c.id)) throw new InputError(`duplicate card: ${c.id}`);
    cards.set(c.id, {
      limit: toCents(c.limit, `card ${c.id} limit`),
      categories: c.categories === undefined ? null : new Set(c.categories),
    });
  }
  if (!Array.isArray(input.events)) throw new InputError('events must be an array');

  const frozen = new Map([...cards.keys()].map((id) => [id, 0]));
  let sharedFrozen = 0;
  const auths = new Map();
  let waiting = [];
  const decisions = [];
  const restoredByAuth = {};
  let restoredTotal = 0;

  const cardRemaining = () =>
    new Map([...cards.entries()].map(([id, c]) => [id, c.limit - frozen.get(id)]));

  function applyAuth(id, cardId, cents, category) {
    auths.set(id, { card: cardId, approved: cents, remaining: cents, category });
    frozen.set(cardId, frozen.get(cardId) + cents);
    sharedFrozen += cents;
  }

  function explainConflict(auth) {
    const sharedRemaining = sharedLimit - sharedFrozen;
    const remaining = cardRemaining();
    const perTier = [];
    const conflictCards = new Set();
    for (const t of tiers) {
      const amt = Math.floor(auth.amount * t + 1e-9);
      const blockedBy = [];
      const cardRem = remaining.get(auth.card);
      if (amt > cardRem) {
        blockedBy.push({ layer: 'card', card: auth.card, remaining: toUnits(cardRem) });
        conflictCards.add(auth.card);
      }
      if (amt > sharedRemaining) {
        blockedBy.push({ layer: 'shared', remaining: toUnits(sharedRemaining) });
        for (const [cid, f] of frozen) if (f > 0) conflictCards.add(cid);
      }
      perTier.push({ tier: t, amount: toUnits(amt), blockedBy });
    }
    return { conflictCards: [...conflictCards].sort(), perTier };
  }

  function processAuth(event, index) {
    if (typeof event.id !== 'string') throw new InputError('auth event requires a string id');
    const card = cards.get(event.card);
    if (!card) throw new InputError(`unknown card: ${event.card}`);
    if (auths.has(event.id) || waiting.some((w) => w.id === event.id)) {
      throw new InputError(`duplicate authorization id: ${event.id}`);
    }
    const amount = toCents(event.amount, `auth ${event.id}`);
    const category = event.category === undefined ? null : event.category;
    const base = {
      event: index,
      type: 'auth',
      id: event.id,
      card: event.card,
      category,
      requested: toUnits(amount),
    };
    if (card.categories !== null && !card.categories.has(category)) {
      decisions.push({
        ...base,
        decision: 'DECLINED',
        reason: 'CATEGORY_NOT_ALLOWED',
        approved: 0,
        shortfall: toUnits(amount),
      });
      return;
    }
    const res = solvePlacement({
      variables: [{ id: event.id, card: event.card, amount }],
      tiers,
      sharedRemaining: sharedLimit - sharedFrozen,
      cardRemaining: cardRemaining(),
      budget,
    });
    if (res.status === 'SOLVED') {
      const approved = res.approved.get(event.id);
      applyAuth(event.id, event.card, approved, category);
      decisions.push({
        ...base,
        decision: approved === amount ? 'APPROVED_FULL' : 'APPROVED_PARTIAL',
        approved: toUnits(approved),
        shortfall: toUnits(amount - approved),
        tier: approved / amount,
        nodes: res.nodes,
      });
      return;
    }
    waiting.push({ id: event.id, card: event.card, amount, category });
    if (res.status === 'PENDING') {
      decisions.push({
        ...base,
        decision: 'PENDING',
        approved: 0,
        shortfall: toUnits(amount),
        nodes: res.nodes,
      });
      return;
    }
    const { conflictCards, perTier } = explainConflict({ card: event.card, amount });
    decisions.push({
      ...base,
      decision: 'UNSAT',
      approved: 0,
      shortfall: toUnits(amount),
      conflictCards,
      explanation: perTier,
      nodes: res.nodes,
    });
  }

  function processReversal(event, index) {
    const auth = auths.get(event.auth);
    if (!auth) throw new InputError(`unknown authorization: ${event.auth}`);
    const amount = toCents(event.amount, `reversal of ${event.auth}`);
    if (amount > auth.remaining) {
      throw new InputError(
        `reversal ${toUnits(amount)} exceeds remaining approved ${toUnits(auth.remaining)} for ${event.auth}`,
      );
    }
    auth.remaining -= amount;
    frozen.set(auth.card, frozen.get(auth.card) - amount);
    sharedFrozen -= amount;
    restoredTotal += amount;
    restoredByAuth[event.auth] = (restoredByAuth[event.auth] ?? 0) + amount;

    const record = {
      event: index,
      type: 'reversal',
      auth: event.auth,
      restored: toUnits(amount),
      remainingApproved: toUnits(auth.remaining),
    };
    if (waiting.length > 0) {
      const res = solvePlacement({
        variables: waiting.map((w) => ({ id: w.id, card: w.card, amount: w.amount })),
        tiers,
        sharedRemaining: sharedLimit - sharedFrozen,
        cardRemaining: cardRemaining(),
        budget,
      });
      const placements = [];
      if (res.status === 'SOLVED') {
        for (const [id, cents] of res.approved) {
          const w = waiting.find((x) => x.id === id);
          applyAuth(id, w.card, cents, w.category);
          placements.push({
            id,
            card: w.card,
            decision: cents === w.amount ? 'APPROVED_FULL' : 'APPROVED_PARTIAL',
            approved: toUnits(cents),
            shortfall: toUnits(w.amount - cents),
          });
        }
        waiting = waiting.filter((w) => !res.approved.has(w.id));
      }
      record.retry = { status: res.status, nodes: res.nodes, placements };
    }
    decisions.push(record);
  }

  input.events.forEach((event, index) => {
    if (!event || typeof event !== 'object') {
      throw new InputError(`invalid event at index ${index}`);
    }
    if (event.type === 'auth') processAuth(event, index);
    else if (event.type === 'reversal') processReversal(event, index);
    else throw new InputError(`unknown event type: ${event.type}`);
  });

  return {
    decisions,
    freezes: {
      shared: toUnits(sharedFrozen),
      cards: Object.fromEntries([...frozen.entries()].map(([id, f]) => [id, toUnits(f)])),
    },
    restored: {
      total: toUnits(restoredTotal),
      byAuth: Object.fromEntries(
        Object.entries(restoredByAuth).map(([id, c]) => [id, toUnits(c)]),
      ),
    },
    waiting: waiting.map((w) => ({ id: w.id, card: w.card, amount: toUnits(w.amount) })),
    tiers,
    budget,
  };
}

module.exports = { run, InputError };
