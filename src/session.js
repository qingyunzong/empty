import { SafeZone } from './zone.js';
import { ZoneError } from './errors.js';

export function runCommand(zone, cmd) {
  try {
    if (!cmd || typeof cmd !== 'object') throw new ZoneError('E_INPUT', 'command must be an object');
    switch (cmd.op) {
      case 'init': return { ok: true, state: zone.init(cmd.vertices) };
      case 'addVertex': return { ok: true, state: zone.addVertex(cmd.index, cmd.point) };
      case 'updateVertex': return { ok: true, state: zone.updateVertex(cmd.index, cmd.point) };
      case 'removeVertex': return { ok: true, state: zone.removeVertex(cmd.index) };
      case 'undo': return { ok: true, ...zone.undo() };
      case 'redo': return { ok: true, ...zone.redo() };
      case 'state': return { ok: true, state: zone.state() };
      case 'query': return { ok: true, result: zone.query(cmd.segment) };
      default: throw new ZoneError('E_INPUT', `unknown op: ${cmd.op}`);
    }
  } catch (e) {
    if (e instanceof ZoneError) return { ok: false, error: { code: e.code, message: e.message } };
    return { ok: false, error: { code: 'E_INTERNAL', message: String(e && e.message) } };
  }
}

/** Run a session: single command object, array of commands, or {commands:[...]}. */
export function runSession(input) {
  const commands = Array.isArray(input) ? input
    : Array.isArray(input?.commands) ? input.commands
    : [input];
  const zone = new SafeZone();
  return { results: commands.map((cmd) => runCommand(zone, cmd)) };
}
