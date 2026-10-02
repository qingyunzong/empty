export const RATED_FORCE = 100;
export const WATERMARK_DELAY = 4;
export const EPSILON = 1e-9;

export class LifeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LifeError';
    this.code = code;
    this.details = details;
  }
}

export function wearOf(load, ratedForce = RATED_FORCE) {
  return load.seconds * (load.force / ratedForce) ** 2;
}

function keyOf(type, id) {
  return type + ' ' + id;
}

export function run(events, options = {}) {
  const ratedForce = options.ratedForce ?? RATED_FORCE;
  const watermarkDelay = options.watermarkDelay ?? WATERMARK_DELAY;

  const sequenced = events.map((event, index) => ({ ...event, _seq: index }));

  let maxEventTs = -Infinity;
  const late = [];
  for (const event of sequenced) {
    const watermark = maxEventTs - watermarkDelay;
    if (event.eventTs < watermark) {
      late.push({
        op: event.op ?? null,
        type: event.type,
        eventTs: event.eventTs,
        watermark,
      });
    }
    if (event.eventTs > maxEventTs) maxEventTs = event.eventTs;
  }
  if (maxEventTs === -Infinity) maxEventTs = null;

  const retractedKeys = new Set();
  for (const event of sequenced) {
    if (event.type === 'retract') retractedKeys.add(keyOf(event.kind, event.id));
  }
  const active = sequenced.filter(
    (event) => event.type !== 'retract' && !retractedKeys.has(keyOf(event.type, event.op)),
  );

  const errors = [];
  const valid = [];
  for (const event of active) {
    if (event.type === 'change' && !(typeof event.newLife === 'number' && event.newLife > 0)) {
      errors.push({
        code: 'LIFE_INVALID',
        op: event.op ?? null,
        tool: event.tool ?? null,
        newLife: typeof event.newLife === 'number' ? event.newLife : null,
      });
      continue;
    }
    valid.push(event);
  }

  const qcByPart = new Map();
  for (const event of valid) {
    if (event.type !== 'qc') continue;
    const current = qcByPart.get(event.part);
    if (
      !current ||
      event.eventTs > current.eventTs ||
      (event.eventTs === current.eventTs && String(event.op) > String(current.op))
    ) {
      qcByPart.set(event.part, event);
    }
  }

  const partTools = new Map();
  const perTool = new Map();
  const ensure = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };
  for (const event of valid) {
    if (event.type === 'load') {
      ensure(perTool, event.tool).push(event);
      const tools = ensure(partTools, event.part);
      if (!tools.includes(event.tool)) tools.push(event.tool);
    } else if (event.type === 'change') {
      ensure(perTool, event.tool).push(event);
    }
  }
  for (const [part, qc] of qcByPart) {
    for (const tool of partTools.get(part) ?? []) {
      ensure(perTool, tool).push(qc);
    }
  }

  const toolResults = new Map();
  const partRisk = new Map();
  const riskOf = (part) => {
    if (!partRisk.has(part)) partRisk.set(part, { exhausted: false, suspect: false });
    return partRisk.get(part);
  };

  for (const [tool, toolEvents] of perTool) {
    toolEvents.sort((a, b) => a.eventTs - b.eventTs || a._seq - b._seq);
    const segments = [];
    let segment = null;
    let chainRisk = false;
    for (const event of toolEvents) {
      if (event.type === 'change') {
        segment = {
          changeOp: event.op,
          startTs: event.eventTs,
          life: event.newLife,
          used: 0,
          remaining: event.newLife,
          status: 'OK',
          exhaustedAt: null,
          loads: [],
        };
        segments.push(segment);
      } else if (event.type === 'load') {
        if (!segment) {
          errors.push({ code: 'LOAD_WITHOUT_LIFE', op: event.op ?? null, tool });
          continue;
        }
        const wear = wearOf(event, ratedForce);
        segment.used += wear;
        segment.remaining = segment.life - segment.used;
        const exhausted = segment.remaining < -EPSILON;
        if (exhausted && segment.status !== 'EXHAUST') {
          segment.status = 'EXHAUST';
          segment.exhaustedAt = event.eventTs;
        }
        segment.loads.push({
          op: event.op ?? null,
          part: event.part,
          eventTs: event.eventTs,
          wear,
          remaining: segment.remaining,
          exhausted,
        });
        const risk = riskOf(event.part);
        if (exhausted) risk.exhausted = true;
        else if (chainRisk) risk.suspect = true;
      } else if (event.type === 'qc') {
        chainRisk = event.ok === false;
      }
    }
    const last = segments[segments.length - 1] ?? null;
    toolResults.set(tool, {
      tool,
      status: last ? last.status : 'NO_LIFE',
      life: last ? last.life : null,
      used: last ? last.used : null,
      remaining: last ? last.remaining : null,
      exhaustedAt: last ? last.exhaustedAt : null,
      segments,
    });
  }

  const partNames = new Set([...partTools.keys(), ...qcByPart.keys()]);
  const partResults = [];
  for (const part of [...partNames].sort()) {
    const qc = qcByPart.get(part) ?? null;
    const risk = partRisk.get(part) ?? { exhausted: false, suspect: false };
    partResults.push({
      part,
      state: qc ? (qc.ok ? 'GOOD' : 'BAD') : 'UNKNOWN',
      risk: risk.exhausted ? 'EXHAUSTED' : risk.suspect ? 'SUSPECT' : 'OK',
      tools: [...(partTools.get(part) ?? [])].sort(),
      qc: qc ? { op: qc.op ?? null, eventTs: qc.eventTs, ok: qc.ok } : null,
    });
  }

  const tools = [...toolResults.values()].sort((a, b) => (a.tool < b.tool ? -1 : 1));
  const exhaustedTools = tools.filter((t) => t.status === 'EXHAUST').map((t) => t.tool);
  const partsAtRisk = partResults.filter((p) => p.risk !== 'OK').map((p) => p.part);

  return {
    tools,
    parts: partResults,
    late,
    errors,
    summary: {
      maxEventTs,
      watermark: maxEventTs === null ? null : maxEventTs - watermarkDelay,
      ratedForce,
      watermarkDelay,
      exhaustedTools,
      partsAtRisk,
      counts: {
        tools: tools.length,
        parts: partResults.length,
        good: partResults.filter((p) => p.state === 'GOOD').length,
        bad: partResults.filter((p) => p.state === 'BAD').length,
        unknown: partResults.filter((p) => p.state === 'UNKNOWN').length,
        suspect: partResults.filter((p) => p.risk === 'SUSPECT').length,
        exhausted: partResults.filter((p) => p.risk === 'EXHAUSTED').length,
        lateEvents: late.length,
        errors: errors.length,
      },
      errors,
    },
  };
}
