import {
  TEACH_SPEED_LIMIT,
  PRODUCTION_SPEED,
  DECEL_SPAN,
  InterpreterError,
  validateEvent,
  compareResolved,
} from "./events.js";

export function createInitialState() {
  return {
    mode: "maintenance",
    door: "open",
    curtain: "clear",
    production: false,
    speed: 0,
    decel: null,
    keys: new Map(),
  };
}

function snapshotOf(state) {
  return {
    mode: state.mode,
    door: state.door,
    curtain: state.curtain,
    production: state.production,
    speed: state.speed,
    decel: state.decel ? { start: state.decel.start, end: state.decel.end } : null,
    keys: [...state.keys.keys()].sort(),
  };
}

function hasPermission(keys, team, station, robot, perm) {
  for (const grant of keys.values()) {
    if (!grant.perms.includes(perm)) continue;
    if (grant.scope === "team" && grant.scopeId === team) return true;
    if (grant.scope === "station" && grant.scopeId === station) return true;
    if (grant.scope === "robot" && grant.scopeId === robot) return true;
  }
  return false;
}

export class Interpreter {
  constructor() {
    this.state = createInitialState();
    this.transitions = [];
    this.violations = [];
  }

  clone() {
    const copy = new Interpreter();
    copy.state = {
      ...this.state,
      decel: this.state.decel ? { ...this.state.decel } : null,
      keys: new Map(
        [...this.state.keys].map(([key, grant]) => [key, { ...grant, perms: [...grant.perms] }]),
      ),
    };
    return copy;
  }

  run(events) {
    events.forEach((event, index) => validateEvent(event, index));
    for (let i = 1; i < events.length; i += 1) {
      if (events[i].clock < events[i - 1].clock) {
        throw new InterpreterError(
          `event[${i}]: clock ${events[i].clock} regresses below ${events[i - 1].clock} (non-monotonic)`,
          14,
        );
      }
    }
    let i = 0;
    while (i < events.length) {
      let j = i + 1;
      while (j < events.length && events[j].clock === events[i].clock) j += 1;
      this.applyGroup(events.slice(i, j));
      i = j;
    }
    return { transitions: this.transitions, violations: this.violations, state: this.state };
  }

  applyGroup(group) {
    const clock = group[0].clock;
    const doorStates = new Set(group.filter((e) => e.type === "door").map((e) => e.state));
    if (doorStates.size > 1) {
      throw new InterpreterError(`clock ${clock}: contradictory door contact states`, 15);
    }
    const ordered = group.slice().sort(compareResolved);
    if (this.state.decel && clock >= this.state.decel.end) {
      const window = this.state.decel;
      this.state.decel = null;
      this.state.speed = 0;
      this.record(ordered[0], clock, "decel_complete", { start: window.start, end: window.end });
    }
    const ctx = {
      modeRequest: 0,
      door: false,
      curtain: false,
      curtainState: null,
      autoStart: false,
      speed: 0,
      grants: new Set(),
      revokes: new Set(),
    };
    for (const event of ordered) this.applyEvent(event, clock, ctx);
  }

  record(event, clock, kind, extra) {
    this.transitions.push({ seq: event.seq, clock, kind, ...extra, snapshot: snapshotOf(this.state) });
  }

  violate(event, clock, type, extra) {
    this.violations.push({ seq: event.seq, clock, type, ...extra });
  }

  discard(event, clock, reason, extra = {}) {
    this.violate(event, clock, "event_discarded", { event: event.type, reason, ...extra });
  }

  safetyStop(event, clock, trigger) {
    this.state.production = false;
    this.state.speed = 0;
    this.record(event, clock, "safety_stop", { trigger });
  }

  applyEvent(event, clock, ctx) {
    const state = this.state;
    switch (event.type) {
      case "mode_request": {
        if (ctx.modeRequest) {
          this.discard(event, clock, "concurrent_mode_conflict", { winner: ctx.modeRequest });
          return;
        }
        ctx.modeRequest = event.seq;
        if (event.mode === state.mode) {
          this.discard(event, clock, "already_in_mode", { mode: event.mode });
          return;
        }
        if (state.decel) {
          this.violate(event, clock, "mode_transition_denied", {
            reason: "decel_in_progress",
            from: state.mode,
            to: event.mode,
            decelEnd: state.decel.end,
          });
          return;
        }
        const from = state.mode;
        state.mode = event.mode;
        this.record(event, clock, "mode", { from, to: event.mode });
        return;
      }
      case "door": {
        if (ctx.door) {
          this.discard(event, clock, "duplicate", { state: event.state });
          return;
        }
        ctx.door = true;
        const changed = state.door !== event.state;
        state.door = event.state;
        this.record(event, clock, "door", { state: event.state, changed });
        if (event.state === "open" && state.production) this.safetyStop(event, clock, "door_open");
        return;
      }
      case "curtain": {
        if (ctx.curtain) {
          const reason = ctx.curtainState === event.state ? "duplicate" : "concurrent_curtain_conflict";
          this.discard(event, clock, reason, { state: event.state });
          return;
        }
        ctx.curtain = true;
        ctx.curtainState = event.state;
        const changed = state.curtain !== event.state;
        state.curtain = event.state;
        this.record(event, clock, "curtain", { state: event.state, changed });
        if (event.state === "blocked" && state.production) this.safetyStop(event, clock, "curtain_blocked");
        return;
      }
      case "key_grant": {
        if (ctx.grants.has(event.key)) {
          this.discard(event, clock, "concurrent_grant_conflict", { key: event.key });
          return;
        }
        ctx.grants.add(event.key);
        state.keys.set(event.key, { scope: event.scope, scopeId: event.scopeId, perms: event.perms.slice() });
        this.record(event, clock, "key_grant", {
          key: event.key,
          scope: event.scope,
          scopeId: event.scopeId,
          perms: event.perms.slice(),
        });
        return;
      }
      case "key_revoke": {
        if (ctx.revokes.has(event.key)) {
          this.discard(event, clock, "duplicate", { key: event.key });
          return;
        }
        ctx.revokes.add(event.key);
        if (!state.keys.has(event.key)) {
          this.discard(event, clock, "unknown_key", { key: event.key });
          return;
        }
        state.keys.delete(event.key);
        this.record(event, clock, "key_revoke", { key: event.key });
        if (state.production) {
          state.production = false;
          state.decel = { start: clock, end: clock + DECEL_SPAN };
          state.speed = TEACH_SPEED_LIMIT;
          this.record(event, clock, "decel_start", { start: clock, end: clock + DECEL_SPAN });
        }
        return;
      }
      case "auto_start": {
        if (ctx.autoStart) {
          this.discard(event, clock, "duplicate");
          return;
        }
        ctx.autoStart = true;
        const reasons = [];
        if (state.mode !== "auto") reasons.push("mode_not_auto");
        if (state.door !== "closed") reasons.push("door_open");
        if (state.curtain !== "clear") reasons.push("curtain_blocked");
        if (state.decel) reasons.push("decel_in_progress");
        if (!hasPermission(state.keys, event.team, event.station, event.robot, "auto")) {
          reasons.push("no_permission");
        }
        if (reasons.length > 0) {
          this.violate(event, clock, "illegal_auto_start", {
            reasons,
            mode: state.mode,
            team: event.team,
            station: event.station,
            robot: event.robot,
          });
          return;
        }
        state.production = true;
        state.speed = PRODUCTION_SPEED;
        this.record(event, clock, "production", {
          started: true,
          team: event.team,
          station: event.station,
          robot: event.robot,
        });
        return;
      }
      case "auto_stop": {
        if (!state.production) {
          this.discard(event, clock, "not_running");
          return;
        }
        state.production = false;
        state.speed = 0;
        this.record(event, clock, "production", { started: false });
        return;
      }
      case "speed_request": {
        if (ctx.speed) {
          this.discard(event, clock, "concurrent_speed_conflict", { winner: ctx.speed });
          return;
        }
        ctx.speed = event.seq;
        if (state.decel) {
          this.discard(event, clock, "decel_in_progress");
          return;
        }
        if (state.mode === "maintenance") {
          this.discard(event, clock, "maintenance_mode");
          return;
        }
        if (state.mode === "teach") {
          const commanded = Math.min(event.value, TEACH_SPEED_LIMIT);
          state.speed = commanded;
          this.record(event, clock, "speed", { requested: event.value, commanded });
          if (event.value > TEACH_SPEED_LIMIT) {
            this.violate(event, clock, "rule_conflict", {
              winner: "safety_teach_speed_cap",
              loser: "throughput_min",
              requested: event.value,
              commanded,
            });
          }
          return;
        }
        if (!state.production) {
          this.discard(event, clock, "not_running");
          return;
        }
        state.speed = event.value;
        this.record(event, clock, "speed", { requested: event.value, commanded: event.value });
        return;
      }
      default:
        throw new InterpreterError(`unhandled event type ${event.type}`, 2);
    }
  }
}

export function run(events) {
  return new Interpreter().run(events);
}
