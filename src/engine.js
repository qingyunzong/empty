import { CodedError, ERRORS } from './errors.js';
import { TimezoneTable } from './timezone.js';
import { parseLocalToMs } from './civil.js';
import { buildRuns, diffRuns, mergeDeviceEvents } from './merge.js';

const VALID_STATES = new Set(['ON', 'OFF']);

// Stateful command engine: zones, event records (with versions), corrections,
// replay and queries. One JSON command in -> one JSON-able result out.
export class Engine {
  constructor() {
    this.tz = new TimezoneTable();
    this.records = new Map(); // eventId -> [{version, kind, data}]
  }

  pushRecord(id, rec) {
    if (!this.records.has(id)) this.records.set(id, []);
    this.records.get(id).push(rec);
  }

  requireFields(cmd, fields) {
    for (const f of fields) {
      if (cmd[f] === undefined || cmd[f] === null) {
        throw new CodedError(ERRORS.BAD_COMMAND, `command ${cmd.type}: missing field ${f}`);
      }
    }
  }

  eventDataFrom(cmd) {
    this.requireFields(cmd, ['id', 'device', 'zone', 'state', 'local']);
    if (!VALID_STATES.has(cmd.state)) {
      throw new CodedError(ERRORS.BAD_COMMAND, `invalid state ${JSON.stringify(cmd.state)} (ON|OFF)`);
    }
    const utcMs = this.tz.localToUtc(cmd.zone, parseLocalToMs(cmd.local));
    return { id: cmd.id, device: cmd.device, state: cmd.state, utcMs, zone: cmd.zone, local: cmd.local };
  }

  // Effective event set for a device at a version ceiling (Infinity = latest).
  effectiveEvents(device, maxVersion = Infinity) {
    const out = [];
    for (const recs of this.records.values()) {
      let pick = null;
      for (const r of recs) {
        if (r.version <= maxVersion && (!pick || r.version >= pick.version)) pick = r;
      }
      if (!pick || pick.kind === 'void') continue;
      if (pick.data.device !== device) continue;
      out.push({ id: pick.data.id, utcMs: pick.data.utcMs, state: pick.data.state, version: pick.version });
    }
    return out;
  }

  observeFor(cmd) {
    const obs = cmd.observe ?? cmd;
    this.requireFields(obs, ['device', 'from', 'to']);
    if (!Number.isFinite(obs.from) || !Number.isFinite(obs.to)) {
      throw new CodedError(ERRORS.BAD_COMMAND, 'observe.from/to must be finite epoch ms numbers');
    }
    return {
      device: obs.device,
      from: obs.from,
      to: obs.to,
      period: obs.period ?? null,
      silence: obs.silence ?? [],
    };
  }

  mergedFor(obs, maxVersion = Infinity) {
    const events = this.effectiveEvents(obs.device, maxVersion);
    const { runs, intervals } = mergeDeviceEvents(events, obs);
    const fmt = (iv) => ({
      device: obs.device,
      state: iv.state,
      start: iv.start,
      end: iv.end,
      status: iv.unclosed ? 'UNCLOSED' : 'CLOSED',
      ids: iv.ids,
      mergedIds: iv.mergedIds ?? [],
    });
    return { runs, intervals: intervals.map(fmt) };
  }

  handle(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      throw new CodedError(ERRORS.BAD_COMMAND, 'command must be an object with a string "type"');
    }
    switch (cmd.type) {
      case 'defineZone': {
        this.requireFields(cmd, ['zone', 'rules']);
        const r = this.tz.defineZone(cmd.zone, cmd.rules);
        return { ok: true, type: 'zoneDefined', ...r };
      }
      case 'event': {
        const data = this.eventDataFrom(cmd);
        const version = cmd.version ?? 0;
        this.pushRecord(data.id, { version, kind: 'event', data });
        return { ok: true, type: 'eventAccepted', id: data.id, device: data.device, utcMs: data.utcMs, version };
      }
      case 'correct': {
        this.requireFields(cmd, ['id', 'action', 'version']);
        if (!Number.isFinite(cmd.version)) {
          throw new CodedError(ERRORS.BAD_COMMAND, 'correct.version must be a finite number');
        }
        const obs = this.observeFor(cmd);
        const before = this.mergedFor(obs);
        let rec;
        if (cmd.action === 'void') {
          rec = { version: cmd.version, kind: 'void', data: { id: cmd.id, device: obs.device } };
        } else if (cmd.action === 'replace') {
          if (!cmd.event || typeof cmd.event !== 'object') {
            throw new CodedError(ERRORS.BAD_COMMAND, 'replace correction needs an "event" object');
          }
          const data = this.eventDataFrom({ ...cmd.event, id: cmd.id, device: cmd.event.device ?? obs.device });
          rec = { version: cmd.version, kind: 'replace', data };
        } else {
          throw new CodedError(ERRORS.BAD_COMMAND, `unknown correction action ${JSON.stringify(cmd.action)}`);
        }
        this.pushRecord(cmd.id, rec);
        const after = this.mergedFor(obs);
        const { affected, changes } = diffRuns(before.runs, after.runs);
        const mergedEventIds = [];
        for (const iv of after.intervals) {
          for (const id of [...iv.ids, ...iv.mergedIds]) {
            if (!mergedEventIds.includes(id)) mergedEventIds.push(id);
          }
        }
        return {
          ok: true,
          type: 'correctionResult',
          id: cmd.id,
          action: cmd.action,
          version: cmd.version,
          affected,
          certificate: {
            device: obs.device,
            window: { from: obs.from, to: obs.to },
            mergedEventIds,
            timeline: changes,
            before: before.intervals,
            after: after.intervals,
          },
        };
      }
      case 'replay': {
        this.requireFields(cmd, ['toVersion']);
        const obs = this.observeFor(cmd);
        const { intervals } = this.mergedFor(obs, cmd.toVersion);
        return { ok: true, type: 'replayResult', device: obs.device, toVersion: cmd.toVersion, intervals };
      }
      case 'query': {
        const obs = this.observeFor(cmd);
        const { intervals } = this.mergedFor(obs);
        return { ok: true, type: 'queryResult', device: obs.device, intervals };
      }
      default:
        throw new CodedError(ERRORS.BAD_COMMAND, `unknown command type ${JSON.stringify(cmd.type)}`);
    }
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch (e) {
      return { ok: false, type: 'error', code: ERRORS.BAD_COMMAND, message: `invalid JSON: ${e.message}` };
    }
    try {
      return this.handle(cmd);
    } catch (e) {
      if (e instanceof CodedError) {
        return { ok: false, type: 'error', code: e.code, message: e.message };
      }
      throw e;
    }
  }
}
