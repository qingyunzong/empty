import { BadLineError, sortJsonLines } from "./sorter";

const USAGE = `Usage: sortjson [options]

External merge sort for JSON Lines, ordered by a bigint key (stable).

Options:
  -i, --input <path>     Input JSONL file ("-" for stdin, default "-")
  -o, --output <path>    Output file ("-" for stdout, default "-")
  -k, --key <field>      JSON field holding the integer key (required)
  -b, --budget <n>       Max resident records (integer >= 2, required)
  -t, --temp-dir <dir>   Directory for recoverable run segments
                         (default: "<output>.runs" or ".sortjson-runs")
  -h, --help             Show this help

Bad input lines abort the sort: nothing is published to the output file.
If a previous run crashed, segments in the temp dir are merged directly.
`;

class UsageError extends Error {}

function parseArgs(argv: string[]): any {
  const opts: any = { input: "-", output: "-", key: undefined, budget: undefined, tempDir: undefined, help: false };
  const take = (arg: string, i: number): [string, number] => {
    const eq = arg.indexOf("=");
    if (eq !== -1) return [arg.slice(eq + 1), i];
    if (i + 1 >= argv.length) throw new UsageError(`missing value for ${arg}`);
    return [argv[i + 1], i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split("=")[0];
    let value: string;
    switch (name) {
      case "-i":
      case "--input":
        [value, i] = take(arg, i);
        opts.input = value;
        break;
      case "-o":
      case "--output":
        [value, i] = take(arg, i);
        opts.output = value;
        break;
      case "-k":
      case "--key":
        [value, i] = take(arg, i);
        opts.key = value;
        break;
      case "-b":
      case "--budget":
        [value, i] = take(arg, i);
        opts.budget = Number(value);
        break;
      case "-t":
      case "--temp-dir":
        [value, i] = take(arg, i);
        opts.tempDir = value;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return opts;
}

// Returns the process exit code: 0 ok, 1 runtime error, 2 usage error.
export async function runCli(argv: string[]): Promise<number> {
  let opts: any;
  try {
    opts = parseArgs(argv);
  } catch (err: any) {
    console.error(`sortjson: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!opts.key) {
    console.error("sortjson: --key is required");
    return 2;
  }
  if (!Number.isInteger(opts.budget) || opts.budget < 2) {
    console.error("sortjson: --budget must be an integer >= 2");
    return 2;
  }
  const tempDir = opts.tempDir ?? (opts.output === "-" ? ".sortjson-runs" : `${opts.output}.runs`);
  try {
    await sortJsonLines({
      inputPath: opts.input,
      outputPath: opts.output,
      keyField: opts.key,
      budget: opts.budget,
      tempDir,
    });
    return 0;
  } catch (err: any) {
    if (err instanceof BadLineError) {
      console.error(`sortjson: bad input, aborted without publishing output (${err.message})`);
    } else {
      console.error(`sortjson: ${err && err.message ? err.message : err}`);
    }
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
