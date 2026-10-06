import { readFileSync } from "node:fs";
import process from "node:process";
import { MarketInput, buildMarket } from "./model";
import { solve, withdrawApplicants } from "./solver";
import { verifyCertificate } from "./certificate";

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node dist/src/cli.js <instance.json> [--withdraw=id1,id2]");
    process.exitCode = 1;
    return;
  }
  const input = JSON.parse(readFileSync(file, "utf8")) as MarketInput;
  let market = buildMarket(input);
  const withdrawArg = args.find((a) => a.startsWith("--withdraw="));
  if (withdrawArg) {
    const ids = withdrawArg.slice("--withdraw=".length).split(",").filter((s) => s.length > 0);
    market = withdrawApplicants(market, ids);
  }
  const result = solve(market);
  if (result.status === "stable") {
    const verification = verifyCertificate(market, result.certificate);
    console.log(
      JSON.stringify(
        { ...result, certificateVerified: verification.ok, certificateErrors: verification.errors },
        null,
        2,
      ),
    );
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main();
