import { mulberry32 } from '../src/util.js';

export const INSTITUTIONS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const INSTRUCTION_IDS = Array.from({ length: 10 }, (_, i) => `ins${i}`);

export function generateEvents(seed, count) {
  const rng = mulberry32(seed);
  const model = new Map();
  const events = [];
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const freshParties = () => {
    let payer, payee;
    do {
      payer = pick(INSTITUTIONS);
      payee = pick(INSTITUTIONS);
    } while (payer === payee);
    return { payer, payee };
  };
  for (let step = 0; step < count; step++) {
    const roll = rng();
    let event = null;
    if (roll < 0.55) {
      const id = pick(INSTRUCTION_IDS);
      const rec = model.get(id);
      if (rec && rng() < 0.25) {
        event = {
          type: 'submit',
          id,
          version: rec.version,
          payer: rec.payer,
          payee: rec.payee,
          amountCents: rec.amountCents,
          dependsOn: [...rec.dependsOn],
        };
      } else {
        const { payer, payee } = freshParties();
        const idx = INSTRUCTION_IDS.indexOf(id);
        const deps = [];
        if (rng() < 0.3 && idx > 0) {
          const candidates = INSTRUCTION_IDS.slice(0, idx).filter((d) => model.has(d));
          if (candidates.length) deps.push(pick(candidates));
        }
        event = {
          type: 'submit',
          id,
          version: (rec?.version ?? 0) + 1,
          payer,
          payee,
          amountCents: 1 + Math.floor(rng() * 100000),
          dependsOn: deps,
        };
      }
    } else if (roll < 0.8) {
      const existing = [...model.keys()];
      if (!existing.length) continue;
      event = { type: 'revoke', id: pick(existing) };
    } else {
      const revoked = [...model.values()].filter((r) => r.revoked);
      if (!revoked.length) continue;
      const rec = pick(revoked);
      const { payer, payee } = freshParties();
      event = {
        type: 'submit',
        id: rec.id,
        version: rec.version + 1,
        payer,
        payee,
        amountCents: 1 + Math.floor(rng() * 100000),
        dependsOn: [],
      };
    }
    events.push(event);
    if (event.type === 'submit') {
      const rec = model.get(event.id);
      if (!rec) {
        model.set(event.id, {
          id: event.id,
          version: event.version,
          payer: event.payer,
          payee: event.payee,
          amountCents: event.amountCents,
          dependsOn: [...event.dependsOn],
          revoked: false,
        });
      } else if (event.version > rec.version) {
        Object.assign(rec, {
          version: event.version,
          payer: event.payer,
          payee: event.payee,
          amountCents: event.amountCents,
          dependsOn: [...event.dependsOn],
          revoked: false,
        });
      }
    } else {
      const rec = model.get(event.id);
      if (rec) rec.revoked = true;
    }
  }
  return { events, model };
}

export function bruteForceNets(model, everSeen) {
  const nets = {};
  for (const inst of everSeen) nets[inst] = 0;
  for (const rec of model.values()) {
    if (rec.revoked) continue;
    nets[rec.payer] -= rec.amountCents;
    nets[rec.payee] += rec.amountCents;
  }
  const sorted = {};
  for (const key of Object.keys(nets).sort()) sorted[key] = nets[key];
  return sorted;
}

export function trackEverSeen(events) {
  const everSeen = new Set();
  for (const event of events) {
    if (event.type === 'submit') {
      everSeen.add(event.payer);
      everSeen.add(event.payee);
    }
  }
  return everSeen;
}
