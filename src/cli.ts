// policy-cli: intersection and chain-equivalence engine for URL policies.
//
//   policy-cli intersect <ruleA.json> <ruleB.json>
//       Prints the canonical intersection rule, a witness URL, and the
//       small-domain enumeration cross-checks (URL-level and chain-level).
//       Exits 2 when the intersection is empty (explicitly forbidden).
//
//   policy-cli equiv <ruleA.json> <ruleB.json>
//       Prints a finite-state equivalence proof, or the shortest redirect
//       chain accepted differently by the two policies, or "unknown" when
//       a redirect budget is unclosed.
//
//   policy-cli match <rule.json> <url>
//       Prints whether the rule matches the URL.
//
// The command dispatcher is a pure function (runCli) so it can be tested
// in-process; src/main.ts is the thin process entry point.

import { readFileSync } from "node:fs";
import { Rule, RuleError, formatUrl, matchUrl, parseRule, parseUrl } from "./model";
import { EmptyIntersectionError, intersectRules, verifyWitness, witnessUrl } from "./intersect";
import { buildUniverse, crossCheckIntersection } from "./enumerate";
import { checkEquivalence, crossCheckChainIntersection } from "./chains";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Io {
  print(value: unknown): void;
  error(text: string): void;
}

function loadRule(path: string): Rule {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new RuleError(`cannot read rule file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RuleError(`invalid JSON in rule file: ${path}`);
  }
  return parseRule(raw, path);
}

const USAGE = [
  "usage:",
  "  policy-cli intersect <ruleA.json> <ruleB.json>",
  "  policy-cli equiv <ruleA.json> <ruleB.json>",
  "  policy-cli match <rule.json> <url>",
  "",
].join("\n");

function cmdIntersect(args: string[], io: Io): number {
  const [pathA, pathB] = args;
  if (pathA === undefined || pathB === undefined) {
    io.error(USAGE);
    return 1;
  }
  const a = loadRule(pathA);
  const b = loadRule(pathB);

  let intersection: Rule;
  try {
    intersection = intersectRules(a, b);
  } catch (err) {
    if (err instanceof EmptyIntersectionError) {
      io.print({ status: "empty-intersection", forbidden: true, reasons: err.reasons });
      io.error(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const witness = witnessUrl(intersection);
  const urlUniverse = buildUniverse([a, b], { maxHosts: 12, maxPorts: 3 });
  const urlCrossCheck = crossCheckIntersection(a, b, intersection, urlUniverse);
  const chainUniverse = buildUniverse([a, b], { maxHosts: 6, maxPorts: 2 });
  const budgets = [a.maxRedirects, b.maxRedirects].filter((v): v is number => v !== null);
  const depth = budgets.length === 0 ? 3 : Math.min(Math.min(...budgets), 3);
  const chainCrossCheck = crossCheckChainIntersection(a, b, intersection, chainUniverse, depth);

  io.print({
    status: "ok",
    intersection,
    witness: formatUrl(witness),
    witnessAcceptedByAll: verifyWitness(witness, a, b, intersection),
    urlCrossCheck,
    chainCrossCheck,
  });
  return urlCrossCheck.ok && chainCrossCheck.ok ? 0 : 3;
}

function cmdEquiv(args: string[], io: Io): number {
  const [pathA, pathB] = args;
  if (pathA === undefined || pathB === undefined) {
    io.error(USAGE);
    return 1;
  }
  const a = loadRule(pathA);
  const b = loadRule(pathB);
  const result = checkEquivalence(a, b);
  if (result.kind === "equivalent") {
    io.print({ status: "equivalent", proof: result.proof });
  } else if (result.kind === "not-equivalent") {
    io.print({
      status: "not-equivalent",
      distinguishingChain: result.distinguishingChain.map(formatUrl),
      redirects: result.redirects,
      acceptedBy: result.acceptedBy,
      explanation: result.explanation,
      chainCrossCheck: result.chainCrossCheck,
    });
  } else {
    io.print({ status: "unknown", reason: result.reason });
  }
  return 0;
}

function cmdMatch(args: string[], io: Io): number {
  const [path, url] = args;
  if (path === undefined || url === undefined) {
    io.error(USAGE);
    return 1;
  }
  const rule = loadRule(path);
  const parts = parseUrl(url);
  io.print({ url: formatUrl(parts), match: matchUrl(rule, parts) });
  return 0;
}

export function runCli(argv: string[]): CliResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    print: (value) => stdout.push(JSON.stringify(value, null, 2) + "\n"),
    error: (text) => stderr.push(text),
  };
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "intersect":
        return { code: cmdIntersect(rest, io), stdout: stdout.join(""), stderr: stderr.join("") };
      case "equiv":
        return { code: cmdEquiv(rest, io), stdout: stdout.join(""), stderr: stderr.join("") };
      case "match":
        return { code: cmdMatch(rest, io), stdout: stdout.join(""), stderr: stderr.join("") };
      default:
        io.error(USAGE);
        return { code: 1, stdout: stdout.join(""), stderr: stderr.join("") };
    }
  } catch (err) {
    if (err instanceof RuleError) {
      io.error(`error: ${err.message}\n`);
      return { code: 1, stdout: stdout.join(""), stderr: stderr.join("") };
    }
    throw err;
  }
}
