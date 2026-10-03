export const MODES = Object.freeze(["auto", "teach", "maintenance"]);
export const DOOR_STATES = Object.freeze(["open", "closed"]);
export const CURTAIN_STATES = Object.freeze(["clear", "blocked"]);
export const SCOPES = Object.freeze(["team", "station", "robot"]);
export const PERMS = Object.freeze(["auto", "teach", "maintenance"]);

export const TEACH_SPEED_LIMIT = 250;
export const PRODUCTION_SPEED = 800;
export const DECEL_SPAN = 3;

export const EVENT_TYPES = Object.freeze([
  "mode_request",
  "door",
  "curtain",
  "key_grant",
  "key_revoke",
  "auto_start",
  "auto_stop",
  "speed_request",
]);

export const SAFETY_LEVEL = Object.freeze({
  door: 3,
  curtain: 3,
  key_revoke: 3,
  key_grant: 2,
  mode_request: 2,
  auto_start: 1,
  auto_stop: 1,
  speed_request: 1,
});

export class InterpreterError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "InterpreterError";
    this.exitCode = exitCode;
  }
}

function fail(where, message, code) {
  throw new InterpreterError(`${where}: ${message}`, code);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function validateEvent(event, index) {
  const where = `event[${index}]`;
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    fail(where, "not an object", 2);
  }
  if (!Number.isInteger(event.seq)) fail(where, "seq must be an integer", 2);
  if (!Number.isInteger(event.clock) || event.clock < 0) {
    fail(where, "clock must be a non-negative integer", 2);
  }
  if (!isNonEmptyString(event.source)) {
    fail(where, "source must be a non-empty string", 2);
  }
  if (!EVENT_TYPES.includes(event.type)) {
    fail(where, `unknown event type ${JSON.stringify(event.type)}`, 2);
  }
  switch (event.type) {
    case "mode_request":
      if (!MODES.includes(event.mode)) {
        fail(where, `unknown mode ${JSON.stringify(event.mode)}`, 13);
      }
      break;
    case "door":
      if (!DOOR_STATES.includes(event.state)) {
        fail(where, `unknown door state ${JSON.stringify(event.state)}`, 2);
      }
      break;
    case "curtain":
      if (!CURTAIN_STATES.includes(event.state)) {
        fail(where, `unknown curtain state ${JSON.stringify(event.state)}`, 2);
      }
      break;
    case "key_grant":
      if (!isNonEmptyString(event.key)) fail(where, "key must be a non-empty string", 2);
      if (!SCOPES.includes(event.scope)) {
        fail(where, `unknown scope ${JSON.stringify(event.scope)}`, 2);
      }
      if (!isNonEmptyString(event.scopeId)) fail(where, "scopeId must be a non-empty string", 2);
      if (!Array.isArray(event.perms) || event.perms.some((p) => !PERMS.includes(p))) {
        fail(where, "perms must be an array of auto|teach|maintenance", 2);
      }
      break;
    case "key_revoke":
      if (!isNonEmptyString(event.key)) fail(where, "key must be a non-empty string", 2);
      break;
    case "auto_start":
      for (const field of ["team", "station", "robot"]) {
        if (!isNonEmptyString(event[field])) fail(where, `${field} must be a non-empty string`, 2);
      }
      break;
    case "auto_stop":
      break;
    case "speed_request":
      if (typeof event.value !== "number" || !Number.isFinite(event.value) || event.value < 0) {
        fail(where, "value must be a non-negative number", 2);
      }
      break;
  }
  return event;
}

export function compareResolved(a, b) {
  const byLevel = SAFETY_LEVEL[b.type] - SAFETY_LEVEL[a.type];
  if (byLevel !== 0) return byLevel;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.seq - b.seq;
}
