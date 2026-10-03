import { SafeZone, analysisToJSON, pointToJSON } from './safezone.js';
import { SafeZoneError } from './errors.js';

function serializeOpResult(r) {
  if (!r.ok) return { ok: false, error: r.error };
  const out = { ok: true };
  if (r.version !== undefined) out.version = r.version;
  return out;
}

/**
 * Handle one CLI request object and return the response object.
 * See README.md for the protocol.
 */
export function handleRequest(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: { code: 'E_PARSE', message: 'request must be a JSON object' } };
  }

  let zone;
  try {
    zone = new SafeZone(input.vertices ?? []);
  } catch (e) {
    if (e instanceof SafeZoneError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    throw e;
  }

  const output = { ok: true };

  if (Array.isArray(input.ops)) {
    output.ops = input.ops.map((op) => {
      let r;
      switch (op?.op) {
        case 'addVertex':
          r = zone.addVertex(op.point, op.index);
          break;
        case 'updateVertex':
          r = zone.updateVertex(op.index, op.point);
          break;
        case 'removeVertex':
          r = zone.removeVertex(op.index);
          break;
        case 'transact':
          r = zone.transact(op.ops);
          break;
        case 'undo':
          r = zone.undo();
          break;
        case 'redo':
          r = zone.redo();
          break;
        default:
          r = { ok: false, error: { code: 'E_PARSE', message: `unknown op: ${op?.op}` } };
      }
      return serializeOpResult(r);
    });
  }

  output.vertices = zone.vertices.map(pointToJSON);
  output.version = zone.version;
  output.canUndo = zone.canUndo;
  output.canRedo = zone.canRedo;

  if (input.segment !== undefined) {
    const seg = input.segment;
    if (!Array.isArray(seg) || seg.length !== 2) {
      output.analysis = {
        ok: false,
        error: { code: 'E_PARSE', message: 'segment must be [[x1,y1],[x2,y2]]' },
      };
    } else {
      const r = zone.analyzeSegment(seg[0], seg[1]);
      output.analysis = r.ok ? { ok: true, ...analysisToJSON(r) } : { ok: false, error: r.error };
    }
  }

  return output;
}
