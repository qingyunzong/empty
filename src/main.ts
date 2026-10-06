import { run } from "./cli";

const code = run(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});
process.exit(code);
