import { readFileSync } from 'node:fs';
import {
  applyEvent,
  appendEvents,
  certificate,
  loadEvents,
  replay,
  stateHash,
} from './reconcile.js';

export function runCli(argv) {
  try {
    const [eventsPath, workdir] = argv;
    if (!eventsPath || !workdir) {
      throw new Error('usage: node cli.js <events.json> <workdir>');
    }
    let events;
    try {
      events = JSON.parse(readFileSync(eventsPath, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read events JSON: ${err.message}`);
    }
    if (!Array.isArray(events)) throw new Error('events JSON must be an array of events');

    const state = replay(loadEvents(workdir));
    for (const event of events) applyEvent(state, event);
    appendEvents(workdir, events);

    const cert = certificate(state);
    const output = {
      ok: true,
      workdir,
      eventsApplied: events.length,
      candidates: state.candidates,
      matches: cert.matches,
      corrections: cert.corrections,
      stateHash: stateHash(state),
    };
    return { code: 0, stdout: `${JSON.stringify(output, null, 2)}\n`, stderr: '' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return {
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({ ok: false, error: { message } })}\n`,
    };
  }
}
