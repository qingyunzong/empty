'use strict';

const { solve, candidateAmounts } = require('./solver');

const SHARED_LAYER = 'shared';
const cardLayer = (card) => `card:${card}`;
const categoryLayer = (category) => `category:${category}`;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INPUT_ERROR';
  }
}

const STATUS_RANK = { OK: 0, PENDING: 1, UNSAT: 2 };

class Engine {
  constructor(config) {
    if (!config || typeof config !== 'object') throw new InputError('input must be a JSON object');
    if (!Number.isInteger(config.sharedLimit) || config.sharedLimit < 0) {
      throw new InputError('sharedLimit must be a non-negative integer');
    }
    const cards = config.cards;
    if (!cards || typeof cards !== 'object' || Object.keys(cards).length === 0) {
      throw new InputError('cards must be a non-empty object');
    }

    this.limits = new Map([[SHARED_LAYER, config.sharedLimit]]);
    this.cards = new Set();
    for (const [id, card] of Object.entries(cards)) {
      if (!card || !Number.isInteger(card.limit) || card.limit < 0) {
        throw new InputError(`card ${id}: limit must be a non-negative integer`);
      }
      this.cards.add(id);
      this.limits.set(cardLayer(id), card.limit);
    }
    this.categoryNames = new Set();
    for (const [name, limit] of Object.entries(config.categoryLimits ?? {})) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new InputError(`category ${name}: limit must be a non-negative integer`);
      }
      this.categoryNames.add(name);
      this.limits.set(categoryLayer(name), limit);
    }

    this.tiers = config.tiers ?? [1, 0.5, 0.25];
    if (!Array.isArray(this.tiers) || this.tiers.some((t) => typeof t !== 'number' || t <= 0 || t > 1)) {
      throw new InputError('tiers must be an array of numbers in (0, 1]');
    }
    this.budget = config.budget ?? 10000;
    if (!Number.isInteger(this.budget) || this.budget < 0) {
      throw new InputError('budget must be a non-negative integer');
    }

    this.used = new Map([...this.limits.keys()].map((key) => [key, 0]));
    this.auths = new Map(); // id -> { id, card, category, requested, approved, reversed, layers }
    this.waitlist = []; // declined requests awaiting released capacity
    this.decisions = [];
    this.reversals = [];
    this.conflictCards = [];
    this.status = 'OK';
    this.operations = Array.isArray(config.operations) ? config.operations : [];
  }

  run() {
    for (const op of this.operations) {
      if (!op || typeof op !== 'object') throw new InputError('operation must be an object');
      if (op.type === 'auth') this.processAuth(op);
      else if (op.type === 'reverse') this.processReverse(op);
      else throw new InputError(`unknown operation type: ${op.type}`);
    }
    return this.toOutput();
  }

  layersFor(request) {
    const layers = [SHARED_LAYER, cardLayer(request.card)];
    if (request.category != null && this.limits.has(categoryLayer(request.category))) {
      layers.push(categoryLayer(request.category));
    }
    return layers;
  }

  normalizeRequests(op) {
    const raw = Array.isArray(op.requests) ? op.requests : [op];
    if (raw.length === 0) throw new InputError('auth operation has no requests');
    return raw.map((r) => {
      if (typeof r.id !== 'string' || r.id.length === 0) throw new InputError('auth request needs a string id');
      if (this.auths.has(r.id)) throw new InputError(`duplicate authorization id: ${r.id}`);
      if (this.waitlist.some((w) => w.id === r.id)) throw new InputError(`duplicate authorization id: ${r.id}`);
      if (typeof r.card !== 'string' || !this.cards.has(r.card)) {
        throw new InputError(`unknown card: ${r.card}`);
      }
      if (!Number.isInteger(r.amount) || r.amount <= 0) {
        throw new InputError(`auth ${r.id}: amount must be a positive integer`);
      }
      const request = {
        id: r.id,
        card: r.card,
        category: r.category ?? null,
        amount: r.amount,
        required: r.required === true,
      };
      request.layers = this.layersFor(request);
      return request;
    });
  }

  setStatus(status) {
    if (STATUS_RANK[status] > STATUS_RANK[this.status]) this.status = status;
  }

  processAuth(op) {
    const requests = this.normalizeRequests(op);
    const result = solve(requests, this.limits, this.used, this.tiers, this.budget);

    if (result.status === 'PENDING') {
      this.setStatus('PENDING');
      for (const request of requests) {
        this.decisions.push(this.decision(request, 0, 'PENDING', { nodes: result.nodes }));
        this.waitlist.push(request);
      }
      return;
    }

    if (result.status === 'UNSAT') {
      this.setStatus('UNSAT');
      this.conflictCards = this.explain(requests, result.conflictLayers);
      for (const request of requests) {
        this.decisions.push(this.decision(request, 0, 'DECLINED', { reason: 'UNSAT' }));
      }
      return;
    }

    requests.forEach((request, i) => {
      const approved = result.assignment[i];
      this.applyApproval(request, approved, {});
      if (approved === 0) this.waitlist.push(request);
    });
  }

  processReverse(op) {
    if (typeof op.authId !== 'string' || !this.auths.has(op.authId)) {
      throw new InputError(`unknown authorization: ${op.authId}`);
    }
    const auth = this.auths.get(op.authId);
    const remainingApproved = auth.approved - auth.reversed;
    const amount = op.amount === undefined ? remainingApproved : op.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InputError(`reversal for ${op.authId}: amount must be a positive integer`);
    }
    if (amount > remainingApproved) {
      throw new InputError(
        `reversal for ${op.authId}: amount ${amount} exceeds remaining approved ${remainingApproved}`,
      );
    }

    auth.reversed += amount;
    for (const layer of auth.layers) this.used.set(layer, this.used.get(layer) - amount);
    const record = {
      authId: auth.id,
      restored: amount,
      remainingApproved: auth.approved - auth.reversed,
      releasedApprovals: [],
    };
    this.reversals.push(record);
    this.retryWaitlist(record);
  }

  retryWaitlist(reversalRecord) {
    if (this.waitlist.length === 0) return;
    const result = solve(this.waitlist, this.limits, this.used, this.tiers, this.budget);
    if (result.status !== 'OK') return; // keep waiting; capacity may free up later
    const stillWaiting = [];
    this.waitlist.forEach((request, i) => {
      const approved = result.assignment[i];
      if (approved > 0) {
        this.applyApproval(request, approved, {
          fromWaitlist: true,
          releasedBy: reversalRecord.authId,
        });
        reversalRecord.releasedApprovals.push(request.id);
      } else {
        stillWaiting.push(request);
      }
    });
    this.waitlist = stillWaiting;
  }

  applyApproval(request, approved, extra) {
    if (approved > 0) {
      this.auths.set(request.id, {
        id: request.id,
        card: request.card,
        category: request.category,
        requested: request.amount,
        approved,
        reversed: 0,
        layers: request.layers,
      });
      for (const layer of request.layers) this.used.set(layer, this.used.get(layer) + approved);
    }
    this.decisions.push(this.decision(request, approved, null, extra));
  }

  decision(request, approved, forcedStatus, extra) {
    const status =
      forcedStatus ??
      (approved === request.amount ? 'APPROVED' : approved > 0 ? 'PARTIAL' : 'DECLINED');
    return {
      seq: this.decisions.length + 1,
      id: request.id,
      card: request.card,
      category: request.category,
      requested: request.amount,
      approved,
      pendingDiff: request.amount - approved,
      status,
      ...extra,
    };
  }

  // Conflict explanation: cards whose requests cannot meet their minimum tier,
  // plus cards holding active freezes in the blocking layers.
  explain(requests, conflictLayers) {
    const layers = new Set(conflictLayers);
    const cards = new Set();
    const remainingOf = (layer) => this.limits.get(layer) - (this.used.get(layer) ?? 0);

    for (const request of requests.filter((r) => r.required)) {
      const cands = candidateAmounts(request.amount, this.tiers, true);
      const minimum = cands[cands.length - 1];
      const blocking = request.layers.filter((layer) => remainingOf(layer) < minimum);
      if (blocking.length > 0) {
        blocking.forEach((layer) => layers.add(layer));
        cards.add(request.card);
      }
    }
    if (cards.size === 0) {
      for (const request of requests.filter((r) => r.required)) {
        cards.add(request.card);
        request.layers.forEach((layer) => layers.add(layer));
      }
    }
    for (const auth of this.auths.values()) {
      if (auth.approved - auth.reversed > 0 && auth.layers.some((layer) => layers.has(layer))) {
        cards.add(auth.card);
      }
    }
    return [...cards].sort();
  }

  layerReport(key) {
    const limit = this.limits.get(key);
    const used = this.used.get(key) ?? 0;
    return { used, limit, remaining: limit - used };
  }

  toOutput() {
    const cards = {};
    for (const id of [...this.cards].sort()) cards[id] = this.layerReport(cardLayer(id));
    const categories = {};
    for (const name of [...this.categoryNames].sort()) {
      categories[name] = this.layerReport(categoryLayer(name));
    }
    return {
      status: this.status,
      decisions: this.decisions,
      freezes: {
        shared: this.layerReport(SHARED_LAYER),
        cards,
        categories,
      },
      reversals: this.reversals,
      conflictCards: this.conflictCards,
      waiting: this.waitlist.map((r) => r.id),
    };
  }
}

module.exports = { Engine, InputError };
