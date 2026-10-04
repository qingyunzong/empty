#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { makeSamples, withdraw, enumerateNaive, Sample } from "./core.js";
import { certify, confidenceSet, runWithCheckpoint } from "./certificate.js";

interface Job {
  samples: Array<{ id: string; diff: string }>;
  withdraw?: string[];
  candidates?: string[];
  alpha?: string;
  checkpoint?: string;
  chunkSize?: number;
  maxChunks?: number;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: signflip <job.json>");
    process.exit(2);
  }
  const job = JSON.parse(readFileSync(file, "utf8")) as Job;
  let samples: Sample[] = makeSamples(job.samples);
  const withdrawn = job.withdraw ?? [];
  if (withdrawn.length > 0) samples = withdraw(samples, withdrawn);

  const report: Record<string, unknown> = { n: samples.length, withdrawn };

  if (job.checkpoint) {
    const r = runWithCheckpoint(samples, job.checkpoint, {
      chunkSize: job.chunkSize,
      maxChunks: job.maxChunks,
    });
    report.complete = r.complete;
    report.resumed = r.resumed;
    if (!r.complete) {
      report.partial = { countGE: r.tail.countGE.toString(), nextMask: r.tail.total === 0n ? "0" : undefined };
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    report.certificate = certify(samples, r.tail);
  } else {
    report.certificate = certify(samples, enumerateNaive(samples).tail);
  }

  if (job.candidates && job.alpha !== undefined) {
    report.confidence = confidenceSet(samples, job.candidates, job.alpha);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
