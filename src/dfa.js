export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseDfa(raw, name = "dfa") {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${name}: document must be a JSON object`);
  }
  const { states, alphabet, start, risk, transitions, costs } = raw;

  if (!isStringArray(states) || states.length === 0 || new Set(states).size !== states.length) {
    throw new ValidationError(`${name}: "states" must be a non-empty array of unique strings`);
  }
  if (!isStringArray(alphabet) || alphabet.length === 0 || new Set(alphabet).size !== alphabet.length) {
    throw new ValidationError(`${name}: "alphabet" must be a non-empty array of unique strings`);
  }
  const stateSet = new Set(states);

  if (typeof start !== "string" || !stateSet.has(start)) {
    throw new ValidationError(`${name}: start state ${JSON.stringify(start)} is missing from "states"`);
  }

  if (risk === null || typeof risk !== "object" || Array.isArray(risk)) {
    throw new ValidationError(`${name}: "risk" must be an object mapping every state to a risk level`);
  }
  for (const state of states) {
    if (!(state in risk)) {
      throw new ValidationError(`${name}: risk level missing for state ${JSON.stringify(state)}`);
    }
  }

  if (transitions === null || typeof transitions !== "object" || Array.isArray(transitions)) {
    throw new ValidationError(`${name}: "transitions" must be an object`);
  }
  for (const state of states) {
    const row = transitions[state];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new ValidationError(`${name}: transitions missing for state ${JSON.stringify(state)}`);
    }
    for (const symbol of alphabet) {
      const target = row[symbol];
      if (typeof target !== "string" || !stateSet.has(target)) {
        throw new ValidationError(
          `${name}: transition target missing for (${state}, ${symbol}) or state ${JSON.stringify(target)} is not declared`
        );
      }
    }
  }

  const normalizedCosts = {};
  if (costs !== undefined) {
    if (costs === null || typeof costs !== "object" || Array.isArray(costs)) {
      throw new ValidationError(`${name}: "costs" must be an object mapping states to non-negative integers`);
    }
    for (const [state, cost] of Object.entries(costs)) {
      if (!stateSet.has(state)) {
        throw new ValidationError(`${name}: cost declared for unknown state ${JSON.stringify(state)}`);
      }
      if (!Number.isInteger(cost) || cost < 0) {
        throw new ValidationError(`${name}: cost for state ${JSON.stringify(state)} must be a non-negative integer`);
      }
      normalizedCosts[state] = cost;
    }
  }

  return {
    states: [...states],
    alphabet: [...alphabet],
    start,
    risk: { ...risk },
    transitions: states.map((s) => [s, { ...transitions[s] }]).reduce((acc, [s, row]) => {
      acc[s] = row;
      return acc;
    }, {}),
    costs: normalizedCosts,
  };
}

export function parseBudget(value) {
  const budget = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
    throw new ValidationError(`budget must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return budget;
}
