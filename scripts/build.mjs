// Strips TypeScript types from src/ and test/ into dist/ using the
// system-provided @babel/core + @babel/preset-typescript (no npm install
// needed; only erasable TS syntax is used, so this is equivalent to tsc
// transpilation for this project).
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const babel = require("@babel/core");
const presetTypeScript = require.resolve("@babel/preset-typescript");

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collect(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

const outDir = join(root, "dist");
rmSync(outDir, { recursive: true, force: true });

let count = 0;
for (const dir of ["src", "test"]) {
  for (const file of collect(join(root, dir))) {
    const result = babel.transformFileSync(file, {
      babelrc: false,
      configFile: false,
      presets: [presetTypeScript],
      filename: file,
    });
    const rel = relative(root, file);
    const dest = join(outDir, rel.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, result.code + "\n");
    count++;
  }
}
console.log(`stripped types from ${count} file(s) into dist/`);
