import {
  TEACH_SPEED_LIMIT,
  PRODUCTION_SPEED,
  DECEL_SPAN,
  InterpreterError,
  validateEvent,
  compareResolved,
} from "./events.js";

const initialState = () => ({
  mode: "maintenance",
  door: "open",
  curtain: "clear",
  production: false,
  speed: 0,
  decel: null,
  keys: [],
});

function snap(s) {
  return {
    mode: s.mode,
    door: s.door,
    curtain: s.curtain,
    production: s.production,
    speed: s.speed,
    decel: s.decel ? { start: s.decel.start, end: s.decel.end } : null,
    keys: s.keys.map((g) => g.key).sort(),
  };
}

function permitted(s, team, station, robot) {
  return s.keys.some(
    (g) =>
      g.perms.includes("auto") &&
      ((g.scope === "team" && g.scopeId === team) ||
        (g.scope === "station" && g.scopeId === station) ||
        (g.scope === "robot" && g.scopeId === robot)),
  );
}

export class ReferenceInterpreter {
  constructor() {
    this.s = initialState();
    this.transitions = [];
    this.violations = [];
  }

  clone() {
    const copy = new ReferenceInterpreter();
    copy.s = {
      ...this.s,
      decel: this.s.decel ? { ...this.s.decel } : null,
      keys: this.s.keys.map((g) => ({ ...g, perms: [...g.perms] })),
    };
    return copy;
  }

  applyGroup(items) {
    const s = this.s;
    const clock = items[0].clock;
    const doorEvents = items.filter((e) => e.type === "door");
    if (new Set(doorEvents.map((e) => e.state)).size > 1) {
      throw new InterpreterError(`clock ${clock}: contradictory door contact states`, 15);
    }
    const ordered = [...items].sort(compareResolved);

    if (s.decel && clock >= s.decel.end) {
      const window = s.decel;
      s.decel = null;
      s.speed = 0;
      this.transitions.push({
        seq: ordered[0].seq,
        clock,
        kind: "decel_complete",
        start: window.start,
        end: window.end,
        snapshot: snap(s),
      });
    }

    const seen = {
      modeRequest: 0,
      door: false,
      curtain: false,
      curtainState: null,
      autoStart: false,
      speed: 0,
      grants: new Set(),
      revokes: new Set(),
    };
    const emit = (kind, event, extra) =>
      this.transitions.push({ seq: event.seq, clock, kind, ...extra, snapshot: snap(s) });
    const flag = (type, event, extra) => this.violations.push({ seq: event.seq, clock, type, ...extra });
    const drop = (event, reason, extra = {}) =>
      flag("event_discarded", event, { event: event.type, reason, ...extra });
    const stopProduction = (event, trigger) => {
      s.production = false;
      s.speed = 0;
      emit("safety_stop", event, { trigger });
    };

    for (const event of ordered) {
      switch (event.type) {
        case "mode_request": {
          if (seen.modeRequest) {
            drop(event, "concurrent_mode_conflict", { winner: seen.modeRequest });
            break;
          }
          seen.modeRequest = event.seq;
          if (event.mode === s.mode) {
            drop(event, "already_in_mode", { mode: event.mode });
            break;
          }
          if (s.decel) {
            flag("mode_transition_denied", event, {
              reason: "decel_in_progress",
              from: s.mode,
              to: event.mode,
              decelEnd: s.decel.end,
            });
            break;
          }
          const from = s.mode;
          s.mode = event.mode;
          emit("mode", event, { from, to: event.mode });
          break;
        }
        case "door": {
          if (seen.door) {
            drop(event, "duplicate", { state: event.state });
            break;
          }
          seen.door = true;
          const changed = s.door !== event.state;
          s.door = event.state;
          emit("door", event, { state: event.state, changed });
          if (event.state === "open" && s.production) stopProduction(event, "door_open");
          break;
        }
        case "curtain": {
          if (seen.curtain) {
            drop(event, seen.curtainState === event.state ? "duplicate" : "concurrent_curtain_conflict", {
              state: event.state,
            });
            break;
          }
          seen.curtain = true;
          seen.curtainState = event.state;
          const changed = s.curtain !== event.state;
          s.curtain = event.state;
          emit("curtain", event, { state: event.state, changed });
          if (event.state === "blocked" && s.production) stopProduction(event, "curtain_blocked");
          break;
        }
        case "key_grant": {
          if (seen.grants.has(event.key)) {
            drop(event, "concurrent_grant_conflict", { key: event.key });
            break;
          }
          seen.grants.add(event.key);
          s.keys = s.keys.filter((g) => g.key !== event.key);
          s.keys.push({ key: event.key, scope: event.scope, scopeId: event.scopeId, perms: [...event.perms] });
          emit("key_grant", event, {
            key: event.key,
            scope: event.scope,
            scopeId: event.scopeId,
            perms: [...event.perms],
          });
          break;
        }
        case "key_revoke": {
          if (seen.revokes.has(event.key)) {
            drop(event, "duplicate", { key: event.key });
            break;
          }
          seen.revokes.add(event.key);
          if (!s.keys.some((g) => g.key === event.key)) {
            drop(event, "unknown_key", { key: event.key });
            break;
          }
          s.keys = s.keys.filter((g) => g.key !== event.key);
          emit("key_revoke", event, { key: event.key });
          if (s.production) {
            s.production = false;
            s.decel = { start: clock, end: clock + DECEL_SPAN };
            s.speed = TEACH_SPEED_LIMIT;
            emit("decel_start", event, { start: clock, end: clock + DECEL_SPAN });
          }
          break;
        }
        case "auto_start": {
          if (seen.autoStart) {
            drop(event, "duplicate");
            break;
          }
          seen.autoStart = true;
          const reasons = [];
          if (s.mode !== "auto") reasons.push("mode_not_auto");
          if (s.door !== "closed") reasons.push("door_open");
          if (s.curtain !== "clear") reasons.push("curtain_blocked");
          if (s.decel) reasons.push("decel_in_progress");
          if (!permitted(s, event.team, event.station, event.robot)) reasons.push("no_permission");
          if (reasons.length > 0) {
            flag("illegal_auto_start", event, {
              reasons,
              mode: s.mode,
              team: event.team,
              station: event.station,
              robot: event.robot,
            });
            break;
          }
          s.production = true;
          s.speed = PRODUCTION_SPEED;
          emit("production", event, {
            started: true,
            team: event.team,
            station: event.station,
            robot: event.robot,
          });
          break;
        }
        case "auto_stop": {
          if (!s.production) {
            drop(event, "not_running");
            break;
          }
          s.production = false;
          s.speed = 0;
          emit("production", event, { started: false });
          break;
        }
        case "speed_request": {
          if (seen.speed) {
            drop(event, "concurrent_speed_conflict", { winner: seen.speed });
            break;
          }
          seen.speed = event.seq;
          if (s.decel) {
            drop(event, "decel_in_progress");
            break;
          }
          if (s.mode === "maintenance") {
            drop(event, "maintenance_mode");
            break;
          }
          if (s.mode === "teach") {
            const commanded = Math.min(event.value, TEACH_SPEED_LIMIT);
            s.speed = commanded;
            emit("speed", event, { requested: event.value, commanded });
            if (event.value > TEACH_SPEED_LIMIT) {
              flag("rule_conflict", event, {
                winner: "safety_teach_speed_cap",
                loser: "throughput_min",
                requested: event.value,
                commanded,
              });
            }
            break;
          }
          if (!s.production) {
            drop(event, "not_running");
            break;
          }
          s.speed = event.value;
          emit("speed", event, { requested: event.value, commanded: event.value });
          break;
        }
        default:
          throw new InterpreterError(`unhandled event type ${event.type}`, 2);
      }
    }
  }
}

export function referenceRun(events) {
  events.forEach((event, index) => validateEvent(event, index));
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].clock < events[i - 1].clock) {
      throw new InterpreterError(`event[${i}]: clock regression`, 14);
    }
  }
  const stepper = new ReferenceInterpreter();
  let i = 0;
  while (i < events.length) {
    let j = i + 1;
    while (j < events.length && events[j].clock === events[i].clock) j += 1;
    stepper.applyGroup(events.slice(i, j));
    i = j;
  }
  return { transitions: stepper.transitions, violations: stepper.violations, state: stepper.s };
}
