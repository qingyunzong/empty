// Independent brute-force reference evaluator. Deliberately written as plain
// loops straight from the spec, used to cross-check src/evaluate.js.

const BIG_DEPTH = 1 << 20;

function chainDepths(graph, starts) {
  const depths = new Map();
  const queue = [];
  for (const s of starts) {
    if (!depths.has(s)) {
      depths.set(s, 0);
      queue.push(s);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const parent of graph[cur]?.inherits ?? []) {
      if (!depths.has(parent)) {
        depths.set(parent, depths.get(cur) + 1);
        queue.push(parent);
      }
    }
  }
  return depths;
}

function windowOk(window, time) {
  const t = new Date(time);
  if (String(window.start).includes('T') || String(window.end).includes('T')) {
    return t.getTime() >= Date.parse(window.start) && t.getTime() < Date.parse(window.end);
  }
  const [sh, sm] = window.start.split(':').map(Number);
  const [eh, em] = window.end.split(':').map(Number);
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

export function referenceDecision(policies, req) {
  const subject = policies.subjects[req.subject];
  const device = policies.devices[req.device];
  if (!subject) throw new Error(`unknown subject: ${req.subject}`);
  if (!device) throw new Error(`unknown device: ${req.device}`);

  const roleDepths = chainDepths(policies.roles, subject.roles ?? []);
  const zoneDepths = chainDepths(policies.zones, [device.zone]);
  const t = Date.parse(req.time);

  let best = null;
  for (const rule of policies.rules) {
    const emergency = rule.emergency === true || rule.action === 'emergencyStop';
    if (rule.revokeAt && emergency) continue; // retroactive: gone for all times
    if (rule.revokeAt && t >= Date.parse(rule.revokeAt)) continue;
    if (rule.action !== req.action && rule.action !== '*') continue;

    let roleDepth = BIG_DEPTH;
    if (rule.role !== undefined) {
      if (!roleDepths.has(rule.role)) continue;
      roleDepth = roleDepths.get(rule.role);
    }
    let zoneDepth = BIG_DEPTH;
    if (rule.zone !== undefined) {
      if (!zoneDepths.has(rule.zone)) continue;
      zoneDepth = zoneDepths.get(rule.zone);
    }
    if (rule.window && !windowOk(rule.window, req.time)) continue;

    const distance = (roleDepth + zoneDepth) * 2 + (rule.action === '*' ? 1 : 0);
    if (!best || distance < best.distance) {
      best = { distance, allows: 0, denies: 0 };
    }
    if (distance === best.distance) {
      if (rule.effect === 'allow') best.allows += 1;
      else best.denies += 1;
    }
  }

  if (!best) return 'deny';
  if (best.denies > 0) return 'deny'; // explicit deny and conflict both default to deny
  return 'allow';
}
