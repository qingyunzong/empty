import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalize, digest } from './canonical.js';
import { loadInputs } from './load.js';
import { applyAdjustments } from './calibrate.js';
import { computeBatchReport } from './segments.js';
import { buildCert, certFileName } from './certs.js';

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function certify({ inDir, outDir }) {
  const { readings, shipments, adjustments } = loadInputs(inDir);
  const adjusted = applyAdjustments(readings, adjustments);

  const readingsDigest = digest(readings.map((r) => [r.sensor_id, r.ts_ms, r.temp_c]));
  const adjustmentsDigest = digest(
    adjustments.map((a) => [a.sensor_id, a.start_ms, a.end_ms, a.offset_c]),
  );

  mkdirSync(outDir, { recursive: true });
  const indexPath = path.join(outDir, 'index.json');
  const oldIndex = readJsonIfExists(indexPath);
  const oldBatches = oldIndex?.batches ?? {};

  const batches = {};
  const results = [];

  for (const shipment of shipments) {
    const report = computeBatchReport(shipment, adjusted);
    const payload = {
      sensor_id: shipment.sensor_id,
      window: { in_time: shipment.in_time, out_time: shipment.out_time },
      thresholds: {
        min_temp_c: shipment.min_temp_c,
        max_temp_c: shipment.max_temp_c,
        max_gap_seconds: shipment.max_gap_seconds,
      },
      readings_digest: readingsDigest,
      adjustments_digest: adjustmentsDigest,
      stats: {
        readings_in_window: report.readings_in_window,
        excursion_seconds: report.excursion_seconds,
        unknown_seconds: report.unknown_seconds,
        evaluated_seconds: report.evaluated_seconds,
        total_seconds: report.total_seconds,
        status: report.status,
      },
      segments: report.segments,
    };

    const prev = oldBatches[shipment.batch_id];
    let cert;
    let history = (prev?.history ?? []).map((h) => ({ ...h }));
    let reused = false;

    if (prev) {
      const prevFile = path.join(outDir, prev.current.file);
      const prevCert = readJsonIfExists(prevFile);
      if (prevCert && canonicalize(prevCert.payload) === canonicalize(payload)) {
        // Inputs produce the exact same certificate: keep it untouched so
        // repeated runs are fully idempotent and the hash never changes.
        cert = prevCert;
        reused = true;
      } else {
        // Content changed (e.g. new adjustments arrived): revoke the old
        // certificate and extend the hash chain.
        const seq = prev.current.seq + 1;
        cert = buildCert({ batchId: shipment.batch_id, seq, prevHash: prev.current.hash, payload });
        if (prevCert && !prevCert.revoked) {
          prevCert.revoked = true;
          writeJson(prevFile, prevCert);
        }
        history.push({
          file: prev.current.file,
          hash: prev.current.hash,
          seq: prev.current.seq,
          status: prev.current.status,
          revoked: true,
        });
      }
    } else {
      cert = buildCert({ batchId: shipment.batch_id, seq: 1, prevHash: null, payload });
    }

    const file = certFileName(shipment.batch_id, cert.seq);
    if (!reused) {
      writeJson(path.join(outDir, file), cert);
    }

    batches[shipment.batch_id] = {
      current: { file, hash: cert.hash, seq: cert.seq, status: cert.payload.stats.status },
      history,
    };
    results.push({
      batch_id: shipment.batch_id,
      seq: cert.seq,
      hash: cert.hash,
      status: cert.payload.stats.status,
      reused,
      revoked_previous: !reused && history.length > 0,
    });
  }

  // Batches that disappeared from the input keep their last known state.
  for (const [batchId, entry] of Object.entries(oldBatches)) {
    if (!(batchId in batches)) batches[batchId] = entry;
  }

  const index = {
    version: 1,
    generated_from: {
      readings_digest: readingsDigest,
      adjustments_digest: adjustmentsDigest,
    },
    batches,
  };
  writeJson(indexPath, index);

  return { indexPath, certs: results, outDir };
}
