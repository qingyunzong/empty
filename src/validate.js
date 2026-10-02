import { EngineError } from './errors.js';

export const OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in']);

const RULE_KEYS = new Set(['id', 'when', 'derive']);
const DERIVE_KEYS = new Set(['alarm']);
const COND_KEYS = new Set(['fact', 'alarm']);

const COMMAND_KEYS = {
  append: new Set(['cmd', 'fact']),
  retract: new Set(['cmd', 'id']),
  addRule: new Set(['cmd', 'rule']),
  removeRule: new Set(['cmd', 'id']),
  undo: new Set(['cmd']),
};

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new EngineError('UNKNOWN_FIELD', `unknown field "${key}" in ${where}`, {
        field: key,
        where,
      });
    }
  }
}

function requireNonEmptyString(value, code, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EngineError(code, `${what} must be a non-empty string`);
  }
}

export function validateMatcher(matcher, where) {
  if (isPlainObject(matcher)) {
    const entries = Object.entries(matcher);
    if (entries.length === 0) {
      throw new EngineError('INVALID_CONDITION', `empty matcher object in ${where}`);
    }
    for (const [op, operand] of entries) {
      if (!OPERATORS.has(op)) {
        throw new EngineError('UNKNOWN_OPERATOR', `unknown operator "${op}" in ${where}`, {
          operator: op,
          where,
        });
      }
      if (op === '$in') {
        if (!Array.isArray(operand) || !operand.every(isPrimitive)) {
          throw new EngineError('INVALID_CONDITION', `"$in" in ${where} requires an array of primitives`);
        }
      } else if (op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte') {
        if (typeof operand !== 'number' && typeof operand !== 'string') {
          throw new EngineError('INVALID_CONDITION', `"${op}" in ${where} requires a number or string operand`);
        }
      } else if (!isPrimitive(operand)) {
        throw new EngineError('INVALID_CONDITION', `"${op}" in ${where} requires a primitive operand`);
      }
    }
    return;
  }
  if (Array.isArray(matcher)) {
    throw new EngineError('INVALID_CONDITION', `array matcher is not allowed in ${where}`);
  }
  if (!isPrimitive(matcher)) {
    throw new EngineError('INVALID_CONDITION', `invalid matcher in ${where}`);
  }
}

export function validateFact(fact, where = 'fact') {
  if (!isPlainObject(fact)) {
    throw new EngineError('INVALID_FACT', `${where} must be an object`);
  }
  requireNonEmptyString(fact.id, 'INVALID_FACT', `${where}.id`);
  requireNonEmptyString(fact.type, 'INVALID_FACT', `${where}.type`);
}

export function validateCondition(cond, where) {
  if (!isPlainObject(cond)) {
    throw new EngineError('INVALID_CONDITION', `${where} must be an object`);
  }
  checkKeys(cond, COND_KEYS, where);
  const kinds = ['fact', 'alarm'].filter((k) => k in cond);
  if (kinds.length !== 1) {
    throw new EngineError(
      'INVALID_CONDITION',
      `${where} must contain exactly one of "fact" or "alarm"`,
    );
  }
  if (cond.fact !== undefined) {
    if (!isPlainObject(cond.fact)) {
      throw new EngineError('INVALID_CONDITION', `${where}.fact must be an object`);
    }
    for (const [key, matcher] of Object.entries(cond.fact)) {
      validateMatcher(matcher, `${where}.fact.${key}`);
    }
  } else {
    requireNonEmptyString(cond.alarm, 'INVALID_CONDITION', `${where}.alarm`);
  }
}

export function validateRule(rule, where = 'rule') {
  if (!isPlainObject(rule)) {
    throw new EngineError('INVALID_RULE', `${where} must be an object`);
  }
  checkKeys(rule, RULE_KEYS, where);
  requireNonEmptyString(rule.id, 'INVALID_RULE', `${where}.id`);
  if (!Array.isArray(rule.when) || rule.when.length === 0) {
    throw new EngineError('INVALID_RULE', `${where}.when must be a non-empty array of conditions`);
  }
  rule.when.forEach((cond, i) => validateCondition(cond, `${where}.when[${i}]`));
  if (!isPlainObject(rule.derive)) {
    throw new EngineError('INVALID_RULE', `${where}.derive must be an object`);
  }
  checkKeys(rule.derive, DERIVE_KEYS, `${where}.derive`);
  requireNonEmptyString(rule.derive.alarm, 'INVALID_RULE', `${where}.derive.alarm`);
}

export function validateCommand(command) {
  if (!isPlainObject(command)) {
    throw new EngineError('INVALID_COMMAND', 'command must be an object');
  }
  if (typeof command.cmd !== 'string' || !(command.cmd in COMMAND_KEYS)) {
    throw new EngineError('INVALID_COMMAND', `unknown command "${command.cmd}"`, {
      cmd: command.cmd,
    });
  }
  checkKeys(command, COMMAND_KEYS[command.cmd], `command "${command.cmd}"`);
  switch (command.cmd) {
    case 'append':
      validateFact(command.fact, 'append.fact');
      break;
    case 'retract':
    case 'removeRule':
      requireNonEmptyString(command.id, 'INVALID_COMMAND', `${command.cmd}.id`);
      break;
    case 'addRule':
      validateRule(command.rule, 'addRule.rule');
      break;
    case 'undo':
      break;
  }
}
