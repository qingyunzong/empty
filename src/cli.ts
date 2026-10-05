import { parseArgs } from "node:util";
import { loadGraph } from "./graph";
import { verify } from "./chain";
import { VerifyRequest } from "./types";

const USAGE = `Usage: cert-chain-verify --graph <file> --leaf <id> --usage <eku>
                          [--at <ISO-time>] [--expect-ok | --expect-fail]
                          [--expect-chain id1,id2,...]

Offline certificate-chain verification over a local relationship graph.
Exit code 0 when verification matches the explicit expectation (or when no
expectation is given and verification succeeds); 1 otherwise.`;

export interface CliOutcome {
  code: number;
  report: Record<string, unknown> | null;
  error: string | null;
}

export function runCli(argv: string[]): CliOutcome {
  const { values } = parseArgs({
    args: argv,
    options: {
      graph: { type: "string" },
      leaf: { type: "string" },
      usage: { type: "string" },
      at: { type: "string", default: new Date().toISOString() },
      "expect-ok": { type: "boolean", default: false },
      "expect-fail": { type: "boolean", default: false },
      "expect-chain": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === "string" ? v : undefined;
  const graphPath = str(values.graph);
  const leaf = str(values.leaf);
  const usage = str(values.usage);
  const at = str(values.at) ?? new Date().toISOString();
  const expectChainArg = str(values["expect-chain"]);

  if (values.help || !graphPath || !leaf || !usage) {
    console.log(USAGE);
    return { code: values.help ? 0 : 2, report: null, error: null };
  }
  if (values["expect-ok"] && values["expect-fail"]) {
    return {
      code: 2,
      report: null,
      error: "--expect-ok and --expect-fail are mutually exclusive",
    };
  }
  if (Number.isNaN(Date.parse(at))) {
    return { code: 2, report: null, error: `--at is not a valid date: ${at}` };
  }

  let graph;
  try {
    graph = loadGraph(graphPath);
  } catch (err) {
    return {
      code: 2,
      report: null,
      error: `graph error: ${(err as Error).message}`,
    };
  }

  const req: VerifyRequest = { leaf, usage, at };
  const result = verify(graph, req);

  const expectChain = expectChainArg
    ? expectChainArg.split(",").map((s: string) => s.trim())
    : null;
  const expectOk = values["expect-ok"]
    ? true
    : values["expect-fail"]
      ? false
      : null;

  const mismatches: string[] = [];
  if (expectOk !== null && result.ok !== expectOk)
    mismatches.push(`expected ok=${expectOk}, got ok=${result.ok}`);
  if (expectChain !== null) {
    const actual = result.chain ? result.chain.join(",") : null;
    if (actual !== expectChain.join(","))
      mismatches.push(
        `expected chain [${expectChain.join(",")}], got [${actual ?? "none"}]`,
      );
  }

  const report = {
    request: req,
    ok: result.ok,
    chain: result.chain,
    failures: result.failures,
    crossCheck: result.crossCheck,
    expectation:
      expectOk === null && expectChain === null
        ? null
        : { expectOk, expectChain, match: mismatches.length === 0, mismatches },
  };
  let code = 0;
  if (!result.crossCheck.agree) code = 1;
  else if (mismatches.length > 0) code = 1;
  else if (expectOk === null && expectChain === null)
    code = result.ok ? 0 : 1;
  return { code, report, error: null };
}

if (require.main === module) {
  const { code, report, error } = runCli(process.argv.slice(2));
  if (error) console.error(error);
  if (report) console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}
