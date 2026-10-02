import { AlarmError } from './errors.js';

const EVENT_FIELDS = new Set(['id', 'seq', 'type', 'value']);
const RULE_FIELDS = new Set(['id', 'alarm', 'when']);
const FACT_COND_FIELDS = new Set(['type', 'op', 'value']);
const ALARM_COND_FIELDS = new Set(['alarm']);
const COMPARATORS = new Set(['<', '<=', '>', '>=', '==', '!=']);

const OP_FIELDS = {
  append: ['event'],
  retract: ['id'],
  addRule: ['rule'],
  removeRule: ['id'],
  undo: [],
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(obj, allowed, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new AlarmError('UNKNOWN_FIELD', `${what} has unknown field "${key}"`, { field: key });
    }
  }
}

function requireNonEmptyString(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AlarmError('INVALID_VALUE', `${what} must be a non-empty string`, { value });
  }
}

function requireFiniteNumber(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AlarmError('INVALID_VALUE', `${what} must be a finite number`, { value });
  }
}

function requireFields(obj, fields, what) {
  for (const field of fields) {
    if (!(field in obj)) {
      throw new AlarmError('MISSING_FIELD', `${what} is missing required field "${field}"`, { field });
    }
  }
}

export function validateEvent(raw) {
  if (!isPlainObject(raw)) {
    throw new AlarmError('BAD_EVENT', 'event must be a plain object', { value: raw });
  }
  rejectUnknownFields(raw, EVENT_FIELDS, 'event');
  requireFields(raw, ['id', 'seq', 'type'], 'event');
  requireNonEmptyString(raw.id, 'event.id');
  requireNonEmptyString(raw.type, 'event.type');
  if (!Number.isInteger(raw.seq)) {
    throw new AlarmError('INVALID_VALUE', 'event.seq must be an integer', { value: raw.seq });
  }
  if ('value' in raw) requireFiniteNumber(raw.value, 'event.value');
  const event = { id: raw.id, seq: raw.seq, type: raw.type };
  if ('value' in raw) event.value = raw.value;
  return event;
}

export function validateCondition(raw) {
  if (!isPlainObject(raw)) {
    throw new AlarmError('BAD_CONDITION', 'condition must be a plain object', { value: raw });
  }
  const hasType = 'type' in raw;
  const hasAlarm = 'alarm' in raw;
  if (hasType === hasAlarm) {
    throw new AlarmError(
      'BAD_CONDITION',
      'condition must contain exactly one of "type" (fact condition) or "alarm" (alarm condition)',
      { value: raw },
    );
  }
  if (hasAlarm) {
    rejectUnknownFields(raw, ALARM_COND_FIELDS, 'alarm condition');
    requireNonEmptyString(raw.alarm, 'condition.alarm');
    return { alarm: raw.alarm };
  }
  rejectUnknownFields(raw, FACT_COND_FIELDS, 'fact condition');
  requireNonEmptyString(raw.type, 'condition.type');
  if ('op' in raw) {
    if (!COMPARATORS.has(raw.op)) {
      throw new AlarmError('INVALID_VALUE', `condition.op must be one of ${[...COMPARATORS].join(', ')}`, { value: raw.op });
    }
    if (!('value' in raw)) {
      throw new AlarmError('MISSING_FIELD', 'fact condition with "op" also requires "value"', { field: 'value' });
    }
    requireFiniteNumber(raw.value, 'condition.value');
    return { type: raw.type, op: raw.op, value: raw.value };
  }
  if ('value' in raw) {
    throw new AlarmError('BAD_CONDITION', 'fact condition with "value" also requires "op"', { value: raw });
  }
  return { type: raw.type };
}

export function validateRule(raw) {
  if (!isPlainObject(raw)) {
    throw new AlarmError('BAD_RULE', 'rule must be a plain object', { value: raw });
  }
  rejectUnknownFields(raw, RULE_FIELDS, 'rule');
  requireFields(raw, ['id', 'alarm', 'when'], 'rule');
  requireNonEmptyString(raw.id, 'rule.id');
  requireNonEmptyString(raw.alarm, 'rule.alarm');
  if (!Array.isArray(raw.when) || raw.when.length === 0) {
    throw new AlarmError('BAD_RULE', 'rule.when must be a non-empty array of conditions', { value: raw.when });
  }
  return { id: raw.id, alarm: raw.alarm, when: raw.when.map(validateCondition) };
}

export function validateOp(raw) {
  if (!isPlainObject(raw)) {
    throw new AlarmError('BAD_OP', 'command must be a plain object', { value: raw });
  }
  requireFields(raw, ['op'], 'command');
  const op = raw.op;
  if (typeof op !== 'string' || !(op in OP_FIELDS)) {
    throw new AlarmError('UNKNOWN_OP', `unknown command "${String(op)}"`, { op });
  }
  rejectUnknownFields(raw, new Set(['op', ...OP_FIELDS[op]]), `command "${op}"`);
  switch (op) {
    case 'append':
      requireFields(raw, ['event'], 'command "append"');
      return { op, event: validateEvent(raw.event) };
    case 'retract':
    case 'removeRule':
      requireFields(raw, ['id'], `command "${op}"`);
      requireNonEmptyString(raw.id, `command "${op}".id`);
      return { op, id: raw.id };
    case 'addRule':
      requireFields(raw, ['rule'], 'command "addRule"');
      return { op, rule: validateRule(raw.rule) };
    case 'undo':
      return { op };
    default:
      throw new AlarmError('UNKNOWN_OP', `unknown command "${String(op)}"`, { op });
  }
}
