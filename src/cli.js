import { Store, PLCError, FaultError } from "./store.js";

const USAGE = `plc - PLC event segment store

usage: plc --dir <dataDir> <command> [options]

commands:
  ingest  --seq N --ts T --code CODE     append one event (idempotent per seq)
  freeze                               seal the active segment
  compact                              merge frozen segments, purge tombstones
  delete  --code CODE                  tombstone an event code
  query cooccur --device D --timeout T [--window 5]
  query phrase  --seq ALARM,ACK,RESET
  recover                              restore to last consistent manifest

errors: E_IO (io/corruption)  E_SEQ (sequence gap)  E_RANGE (bad argument)
fault injection (testing): PLC_FAULT=afterAppend|midManifest|beforeMergeSwap
`;

function parseArgs(argv) {
  const opts = { dir: "./plc-data", _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else { opts[key] = next; i++; }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function num(v, name) {
  const n = Number(v);
  if (v === undefined || v === true || !Number.isSafeInteger(n)) {
    throw new PLCError("E_RANGE", `--${name} must be an integer`);
  }
  return n;
}

function str(v, name) {
  if (typeof v !== "string" || v.length === 0) throw new PLCError("E_RANGE", `--${name} is required`);
  return v;
}

// io is injectable so tests can run the CLI in-process:
//   run(argv, { out, err, exit })
export function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const exit = io.exit ?? ((code) => process.exit(code));
  const opts = parseArgs(argv);
  const [cmd, sub] = opts._;
  const store = new Store(opts.dir);
  try {
    let result;
    switch (cmd) {
      case "ingest":
        result = store.ingest({ seq: num(opts.seq, "seq"), ts: num(opts.ts, "ts"), code: str(opts.code, "code") });
        break;
      case "freeze":
        result = store.freeze();
        break;
      case "compact":
        result = store.compact();
        break;
      case "delete":
        result = store.deleteCode(str(opts.code, "code"));
        break;
      case "recover":
        result = store.recover();
        break;
      case "query":
        if (sub === "cooccur") {
          result = store.queryCooccur({
            device: str(opts.device, "device"),
            timeout: str(opts.timeout, "timeout"),
            window: opts.window === undefined ? 5 : num(opts.window, "window"),
          });
        } else if (sub === "phrase") {
          result = store.queryPhrase(str(opts.seq, "seq").split(","));
        } else {
          throw new PLCError("E_RANGE", `unknown query type: ${sub ?? "(none)"}`);
        }
        break;
      case undefined:
      case "help":
        out(USAGE);
        return;
      default:
        throw new PLCError("E_RANGE", `unknown command: ${cmd}`);
    }
    out(JSON.stringify(result) + "\n");
  } catch (e) {
    if (e instanceof FaultError) {
      err(JSON.stringify({ error: e.code, point: e.point, message: e.message }) + "\n");
      exit(2); // simulated crash
      return;
    }
    if (e instanceof PLCError) {
      err(JSON.stringify({ error: e.code, message: e.message }) + "\n");
      exit(1);
      return;
    }
    err(JSON.stringify({ error: "E_IO", message: String((e && e.message) || e) }) + "\n");
    exit(1);
  }
}
