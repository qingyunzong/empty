export class InvalidHistory extends Error {
  constructor(details) {
    super(`INVALID_HISTORY: ${details.map((d) => d.message).join('; ')}`);
    this.name = 'InvalidHistory';
    this.details = details;
  }
}

export const OP_TYPES = new Set(['set_count', 'morph_species', 'move_plot', 'sync', 'undo_op']);
export const DATA_OPS = new Set(['set_count', 'morph_species', 'move_plot']);

function validatePayload(obj, where, config, errors) {
  const fail = (message) => errors.push({ ...where, message });
  switch (obj.op) {
    case 'set_count': {
      if (typeof obj.plot !== 'string' || !obj.plot) fail('set_count requires a plot string');
      if (typeof obj.species !== 'string' || !obj.species) fail('set_count requires a species string');
      if (!Number.isInteger(obj.tier)) fail('set_count requires an integer tier');
      if (config && typeof obj.plot === 'string' && typeof obj.species === 'string') {
        const sp = config.species?.[obj.species];
        const pl = config.plots?.[obj.plot];
        if (!sp) fail(`unknown species ${obj.species}`);
        if (!pl) fail(`unknown plot ${obj.plot}`);
        if (sp && pl && Array.isArray(pl.morphs) && !pl.morphs.includes(sp.morph))
          fail(`species ${obj.species} (morph ${sp.morph}) incompatible with plot ${obj.plot}`);
        if (Number.isInteger(obj.tier) && Array.isArray(config.tiers) && !config.tiers.includes(obj.tier))
          fail(`tier ${obj.tier} outside finite domain`);
      }
      break;
    }
    case 'morph_species': {
      if (typeof obj.from !== 'string' || typeof obj.to !== 'string') fail('morph_species requires from/to');
      else {
        if (obj.from === obj.to) fail('morph_species from must differ from to');
        if (config) {
          if (!config.species?.[obj.from]) fail(`unknown species ${obj.from}`);
          if (!config.species?.[obj.to]) fail(`unknown species ${obj.to}`);
        }
      }
      break;
    }
    case 'move_plot': {
      if (typeof obj.from !== 'string' || typeof obj.to !== 'string') fail('move_plot requires from/to');
      else {
        if (obj.from === obj.to) fail('move_plot from must differ from to');
        if (config) {
          if (!config.plots?.[obj.from]) fail(`unknown plot ${obj.from}`);
          if (!config.plots?.[obj.to]) fail(`unknown plot ${obj.to}`);
        }
      }
      break;
    }
    case 'sync': {
      if (typeof obj.session !== 'string' || !obj.session) fail('sync requires a session string');
      break;
    }
    case 'undo_op': {
      if (typeof obj.target !== 'string' || !obj.target) fail('undo_op requires a target op id');
      break;
    }
  }
}

export function parseHistory(text, { source = '<input>', config = null } = {}) {
  const errors = [];
  const ops = [];
  let device = null;
  let lastTime = -Infinity;
  const ids = new Set();
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const where = { source, line: idx + 1 };
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      errors.push({ ...where, message: `invalid JSON: ${err.message}` });
      return;
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      errors.push({ ...where, message: 'line is not a JSON object' });
      return;
    }
    if (!OP_TYPES.has(obj.op)) {
      errors.push({ ...where, message: `unknown op type ${obj.op}` });
      return;
    }
    if (typeof obj.device !== 'string' || !obj.device) {
      errors.push({ ...where, message: 'missing device' });
      return;
    }
    if (device === null) device = obj.device;
    else if (obj.device !== device) {
      errors.push({ ...where, message: `mixed devices in one history (${device} vs ${obj.device})` });
      return;
    }
    if (!Number.isInteger(obj.time)) {
      errors.push({ ...where, message: 'time must be an integer' });
      return;
    }
    if (obj.time <= lastTime) {
      errors.push({ ...where, message: `non-monotonic time ${obj.time} after ${lastTime}` });
      return;
    }
    lastTime = obj.time;
    const id = obj.id ?? `${obj.device}#${idx + 1}`;
    if (ids.has(id)) {
      errors.push({ ...where, message: `duplicate op id ${id}` });
      return;
    }
    ids.add(id);
    validatePayload(obj, where, config, errors);
    ops.push({ ...obj, id });
  });
  if (errors.length) throw new InvalidHistory(errors);
  if (device === null) throw new InvalidHistory([{ source, message: 'empty history' }]);
  return { device, ops, source };
}
