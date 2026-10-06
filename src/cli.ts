import { externalSort, BadLineError } from "./sorter.js";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: sort-jsonl --input <in.jsonl> --output <out.jsonl> [options]

Stable external merge sort of JSON lines by their bigint "key" field.

Options:
  -i, --input <path>    Input JSONL file (required)
  -o, --output <path>   Output JSONL file, published atomically (required)
  -b, --budget <n>      Max records held in memory at once (default: 10000)
  -t, --tmp-dir <path>  Temp segment directory (default: <output>.segments)
      --resume          Reuse temp segments from an interrupted run
  -h, --help            Show this help

Each input line must be a JSON object with an integer "key" (number or
string). A malformed line aborts the sort and no output is published.
`;

interface CliArgs {
  input?: string;
  output?: string;
  budget: number;
  tmpDir?: string;
  resume: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { budget: 10000, resume: false, help: false };
  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "-i":
      case "--input":
        args.input = takeValue(i, "--input");
        i++;
        break;
      case "-o":
      case "--output":
        args.output = takeValue(i, "--output");
        i++;
        break;
      case "-b":
      case "--budget":
        args.budget = Number(takeValue(i, "--budget"));
        i++;
        break;
      case "-t":
      case "--tmp-dir":
        args.tmpDir = takeValue(i, "--tmp-dir");
        i++;
        break;
      case "--resume":
        args.resume = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

interface Stream {
  write(s: string): void;
}

/** Programmatic entry point; returns the process exit code. */
export async function run(
  argv: string[],
  stdout: Stream = process.stdout,
  stderr: Stream = process.stderr
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err2) {
    stderr.write(`error: ${(err2 as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!args.input || !args.output) {
    stderr.write(`error: --input and --output are required\n\n${USAGE}`);
    return 2;
  }
  try {
    const stats = await externalSort({
      input: args.input,
      output: args.output,
      budget: args.budget,
      tmpDir: args.tmpDir ?? `${args.output}.segments`,
      resume: args.resume,
    });
    stdout.write(
      `sorted ${stats.records} record(s) ` +
        `(${stats.segments} segment(s), ${stats.mergePasses} merge pass(es)` +
        `${stats.resumed ? ", resumed" : ""}) -> ${args.output}\n`
    );
  } catch (err) {
    if (err instanceof BadLineError) {
      stderr.write(`error: ${err.message}\n`);
    } else {
      stderr.write(`error: ${(err as Error).message}\n`);
    }
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2));
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) void main();
