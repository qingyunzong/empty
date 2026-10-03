#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { appendBatch, computeState, loadChain, rangeState } from "./lib/store.js";
import { BusinessError } from "./lib/errors.js";

function usage() {
  throw new BusinessError(
    "USAGE",
    "用法: cli.js put <file> [--json '<json>' | <batch.json>] | cancel <file> <tradeId> | " +
      "replay <file> | range <file> --from N --to M | verify <file>",
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BusinessError("INVALID_JSON", `JSON 解析失败: ${err.message}`);
  }
}

function main(argv, out) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "put": {
      const [file, ...args] = rest;
      if (!file) usage();
      let text;
      const ji = args.indexOf("--json");
      if (ji >= 0) {
        if (!args[ji + 1]) usage();
        text = args[ji + 1];
      } else if (args[0]) {
        text = readFileSync(args[0], "utf8");
      } else {
        text = readFileSync(0, "utf8");
      }
      const parsed = parseJson(text);
      const records = Array.isArray(parsed) ? parsed : parsed.records;
      const { seq, hash } = appendBatch(file, records);
      out({ ok: true, seq, hash: hash.toString("hex") });
      return;
    }
    case "cancel": {
      const [file, tradeId] = rest;
      if (!file || !tradeId) usage();
      const { seq, hash } = appendBatch(file, [{ type: "cancel", trade: tradeId }]);
      out({ ok: true, seq, hash: hash.toString("hex") });
      return;
    }
    case "replay": {
      const [file] = rest;
      if (!file) usage();
      const chain = loadChain(file);
      const state = computeState(chain.blocks);
      out({ ok: true, blocks: chain.blocks.length, truncated: chain.truncated, state });
      return;
    }
    case "range": {
      const [file, ...args] = rest;
      if (!file) usage();
      const from = Number(args[args.indexOf("--from") + 1]);
      const to = Number(args[args.indexOf("--to") + 1]);
      const { state, meta } = rangeState(file, from, to);
      out({ ok: true, ...meta, state });
      return;
    }
    case "verify": {
      const [file] = rest;
      if (!file) usage();
      const chain = loadChain(file);
      out({
        ok: true,
        blocks: chain.blocks.length,
        truncated: chain.truncated,
        tip: chain.tipHash.toString("hex"),
      });
      return;
    }
    default:
      usage();
  }
}

export function run(argv, io = {}) {
  const writeOut = io.stdout ?? ((s) => process.stdout.write(s));
  const writeErr = io.stderr ?? ((s) => process.stderr.write(s));
  try {
    main(argv, (obj) => writeOut(JSON.stringify(obj, null, 2) + "\n"));
    return 0;
  } catch (err) {
    const code = err.code ?? "INTERNAL";
    writeErr(JSON.stringify({ error: { code, message: err.message } }) + "\n");
    return err.exitCode ?? 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
