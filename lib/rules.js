import { FeeError, ERR_INVALID_INPUT, ERR_OVERLAP_NO_PRIORITY } from './errors.js';
import { parseTime } from './util.js';

// A rule version: { ruleId, validFrom, validTo|null, revokedAt|null, rateBps, priority|null }.
// Revoking closes the rule going forward but never deletes history: fees for
// timestamps before revokedAt still resolve to the rule.
export class RuleStore {
  #rules = new Map();

  get size() {
    return this.#rules.size;
  }

  get(ruleId) {
    return this.#rules.get(ruleId) ?? null;
  }

  // Applies one ndjson op. Returns the op's event time (for monotonicity checks).
  apply(op, lineNo) {
    const where = `rules line ${lineNo}`;
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw new FeeError(ERR_INVALID_INPUT, `${where}: expected an object`);
    }
    if (op.op === 'add') {
      for (const field of ['ruleId', 'validFrom', 'rateBps']) {
        if (op[field] === undefined || op[field] === null) {
          throw new FeeError(ERR_INVALID_INPUT, `${where}: missing "${field}"`);
        }
      }
      if (typeof op.ruleId !== 'string' || op.ruleId.length === 0) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: ruleId must be a non-empty string`);
      }
      if (this.#rules.has(op.ruleId)) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: duplicate ruleId "${op.ruleId}" (use a new ruleId for a new version)`);
      }
      if (!Number.isInteger(op.rateBps) || op.rateBps < 0) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: rateBps must be a non-negative integer (basis points)`);
      }
      if (op.priority !== undefined && op.priority !== null && !Number.isInteger(op.priority)) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: priority must be an integer when declared`);
      }
      const validFrom = parseTime(op.validFrom, `${where} validFrom`);
      const validTo = op.validTo === undefined || op.validTo === null ? null : parseTime(op.validTo, `${where} validTo`);
      if (validTo !== null && validTo <= validFrom) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: validTo must be after validFrom`);
      }
      this.#rules.set(op.ruleId, {
        ruleId: op.ruleId,
        validFrom,
        validTo,
        revokedAt: null,
        rateBps: op.rateBps,
        priority: op.priority ?? null,
      });
      return validFrom;
    }
    if (op.op === 'revoke') {
      if (typeof op.ruleId !== 'string' || !this.#rules.has(op.ruleId)) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: revoke of unknown ruleId ${JSON.stringify(op.ruleId)}`);
      }
      if (op.at === undefined || op.at === null) {
        throw new FeeError(ERR_INVALID_INPUT, `${where}: missing "at"`);
      }
      const at = parseTime(op.at, `${where} at`);
      this.#rules.get(op.ruleId).revokedAt = at;
      return at;
    }
    throw new FeeError(ERR_INVALID_INPUT, `${where}: unknown op ${JSON.stringify(op.op)}`);
  }

  static effectiveValidTo(rule) {
    const ends = [rule.validTo, rule.revokedAt].filter((v) => v !== null);
    return ends.length === 0 ? null : Math.min(...ends);
  }

  isActiveAt(rule, t) {
    if (t < rule.validFrom) return false;
    const end = RuleStore.effectiveValidTo(rule);
    return end === null || t < end;
  }

  activeAt(t) {
    const out = [];
    for (const rule of this.#rules.values()) {
      if (this.isActiveAt(rule, t)) out.push(rule);
    }
    return out;
  }

  // Deterministic selection: lowest rateBps wins; ties among the best rate are
  // all reported, then resolved by priority desc, then ruleId asc.
  resolve(t) {
    const candidates = this.activeAt(t)
      .map((r) => ({ ruleId: r.ruleId, rateBps: r.rateBps, priority: r.priority }))
      .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
    if (candidates.length === 0) {
      return {
        time: t,
        candidates: [],
        bestRateBps: 0,
        tied: [],
        selected: null,
        reason: 'no active rule at this time; fee rate defaults to 0',
      };
    }
    const bestRateBps = Math.min(...candidates.map((c) => c.rateBps));
    const tied = candidates
      .filter((c) => c.rateBps === bestRateBps)
      .sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity) || (a.ruleId < b.ruleId ? -1 : 1));
    if (tied.length > 1 && tied.some((c) => c.priority === null)) {
      const ids = tied.map((c) => c.ruleId).join(', ');
      throw new FeeError(
        ERR_OVERLAP_NO_PRIORITY,
        `overlapping rules tie for best rate ${bestRateBps}bps at t=${t} without declared priority: ${ids}`,
      );
    }
    const top = tied[0];
    const reason =
      tied.length === 1
        ? `single best rule at ${bestRateBps}bps`
        : `${tied.length} rules tie for best rate ${bestRateBps}bps; selected by fixed order (priority desc, ruleId asc)`;
    return {
      time: t,
      candidates,
      bestRateBps,
      tied: tied.map((c) => ({ ruleId: c.ruleId, priority: c.priority })),
      selected: { ruleId: top.ruleId, priority: top.priority },
      reason,
    };
  }
}

export function computeFee(amount, rateBps) {
  return Math.floor((amount * rateBps) / 10000);
}
