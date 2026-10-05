import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  SecretScanner,
  formatReport,
  maskPreview,
  scan,
  type BytePattern,
  type Finding,
  type RawMatch,
} from "../src/scanner.js";

const AWS: BytePattern = {
  name: "aws-key",
  regex: /AKIA[0-9A-Z]{16}/,
  maxLength: 20,
};
const GHP: BytePattern = {
  name: "gh-token",
  regex: /ghp_[A-Za-z0-9]{36}/,
  maxLength: 40,
};
const HEX32: BytePattern = {
  name: "hex32",
  regex: /[0-9a-f]{32}/,
  maxLength: 32,
};
const PASS: BytePattern = {
  name: "password",
  regex: /password=[^&\s]{4,32}/i,
  maxLength: 41,
};
const EXAMPLE_BOX: BytePattern = {
  name: "example-box",
  regex: /EXAMPLE\[[^\]\n]{1,64}\]/,
  maxLength: 73,
};
const SAFE_PREFIX: BytePattern = {
  name: "safe-prefix",
  regex: /safe:[0-9a-f]{16}/,
  maxLength: 21,
};

const SECRETS = [AWS, GHP, HEX32, PASS];
const WHITELIST = [EXAMPLE_BOX, SAFE_PREFIX];

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // 20 bytes
const GH_TOKEN = "ghp_" + "Ab3".repeat(12); // 40 bytes
const HEX32_VALUE = "0123456789abcdef".repeat(2); // 32 bytes
const SAFE_HEX = "ab".repeat(16); // 32 hex bytes behind a partial whitelist prefix

const corpus = [
  "2026-10-06T00:00:00Z INFO service boot\n",
  `aws_access_key_id = ${AWS_KEY}\n`,
  `github token=${GH_TOKEN};\n`,
  `artifact id: ${HEX32_VALUE}\n`,
  `safe:${SAFE_HEX}\n`,
  `docs: EXAMPLE[${AWS_KEY}] is a placeholder\n`,
  `sample hash EXAMPLE[${HEX32_VALUE}]\n`,
  "db url password=Sup3rSecret&timeout=10\n",
  `tail key ${AWS_KEY}`, // no trailing newline: exercises the flush path
].join("");

function expectedCorpusFindings(): Finding[] {
  const aws1 = corpus.indexOf(AWS_KEY);
  const gh = corpus.indexOf(GH_TOKEN);
  const hex = corpus.indexOf(HEX32_VALUE);
  const safe = corpus.indexOf(SAFE_HEX);
  const awsWl = corpus.indexOf(AWS_KEY, aws1 + 1);
  const hexWl = corpus.indexOf(HEX32_VALUE, hex + 1);
  const pass = corpus.indexOf("password=Sup3rSecret");
  const awsTail = corpus.lastIndexOf(AWS_KEY);
  return [
    { start: aws1, end: aws1 + 20, patterns: ["aws-key"], suppressed: false },
    { start: gh, end: gh + 40, patterns: ["gh-token"], suppressed: false },
    { start: hex, end: hex + 32, patterns: ["hex32"], suppressed: false },
    { start: safe, end: safe + 32, patterns: ["hex32"], suppressed: false },
    { start: awsWl, end: awsWl + 20, patterns: ["aws-key"], suppressed: true },
    { start: hexWl, end: hexWl + 32, patterns: ["hex32"], suppressed: true },
    { start: pass, end: pass + 20, patterns: ["password"], suppressed: false },
    { start: awsTail, end: awsTail + 20, patterns: ["aws-key"], suppressed: false },
  ];
}

function scanWhole(input: string): {
  findings: Finding[];
  raw: readonly RawMatch[];
} {
  const scanner = new SecretScanner(SECRETS, WHITELIST);
  scanner.push(input);
  const findings = scanner.finish();
  return { findings, raw: [...scanner.rawMatches] };
}

function scanChunked(
  input: string,
  sizes: number[],
  asBuffer: (index: number) => boolean,
): { findings: Finding[]; raw: readonly RawMatch[]; pushed: RawMatch[] } {
  const scanner = new SecretScanner(SECRETS, WHITELIST);
  const pushed: RawMatch[] = [];
  let offset = 0;
  sizes.forEach((n, i) => {
    const piece = input.slice(offset, offset + n);
    offset += n;
    pushed.push(...scanner.push(asBuffer(i) ? Buffer.from(piece) : piece));
  });
  const findings = scanner.finish();
  return { findings, raw: [...scanner.rawMatches], pushed };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomChunkSizes(total: number, rand: () => number): number[] {
  const sizes: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const n = Math.min(1 + Math.floor(rand() * 97), remaining);
    sizes.push(n);
    remaining -= n;
  }
  return sizes;
}

test("whole-input scan reports original byte offsets", () => {
  const { findings } = scanWhole(corpus);
  assert.deepEqual(findings, expectedCorpusFindings());
});

test("chunked scan equals whole-input scan for fixed chunk sizes", () => {
  const whole = scanWhole(corpus);
  for (const size of [1, 2, 3, 5, 7, 13, 64, 4096]) {
    const sizes: number[] = [];
    for (let i = 0; i < corpus.length; i += size) {
      sizes.push(Math.min(size, corpus.length - i));
    }
    const chunked = scanChunked(corpus, sizes, (i) => i % 2 === 0);
    assert.deepEqual(chunked.findings, whole.findings, `chunk size ${size}`);
    assert.deepEqual(chunked.raw, whole.raw, `chunk size ${size} raw matches`);
  }
});

test("chunked scan equals whole-input scan for 200 random chunkings", () => {
  const whole = scanWhole(corpus);
  const wholePreview = maskPreview(corpus, whole.findings);
  for (let seed = 1; seed <= 200; seed++) {
    const rand = lcg(seed);
    const sizes = randomChunkSizes(corpus.length, rand);
    const chunked = scanChunked(corpus, sizes, () => rand() < 0.5);
    assert.deepEqual(chunked.findings, whole.findings, `seed ${seed}`);
    assert.deepEqual(chunked.raw, whole.raw, `seed ${seed} raw matches`);
    assert.equal(
      maskPreview(corpus, chunked.findings),
      wholePreview,
      `seed ${seed} preview`,
    );
  }
});

test("match spanning a chunk boundary is not missed", () => {
  const scanner = new SecretScanner([AWS]);
  assert.deepEqual(scanner.push("prefix " + AWS_KEY.slice(0, 10)), []);
  const pushed = scanner.push(AWS_KEY.slice(10) + " suffix");
  const findings = scanner.finish();
  assert.deepEqual(findings, [
    { start: 7, end: 27, patterns: ["aws-key"], suppressed: false },
  ]);
  assert.deepEqual(pushed, [
    { start: 7, end: 27, pattern: "aws-key", suppressed: false },
  ]);
});

test("whitelist suppresses only fully contained ranges", () => {
  // Partial overlap: whitelist covers "safe:" + 16 of the 32 hex bytes.
  const partial = scan("safe:" + SAFE_HEX, [HEX32], [SAFE_PREFIX]);
  assert.deepEqual(partial, [
    { start: 5, end: 37, patterns: ["hex32"], suppressed: false },
  ]);

  // Full containment: the whole secret sits inside EXAMPLE[...].
  const boxed = `EXAMPLE[${SAFE_HEX}]`;
  const contained = scan(boxed, [HEX32], [EXAMPLE_BOX]);
  assert.deepEqual(contained, [
    { start: 8, end: 40, patterns: ["hex32"], suppressed: true },
  ]);
});

test("whitelist span crossing chunks still suppresses a boundary match", () => {
  const boxed = `head EXAMPLE[${AWS_KEY}] tail`;
  const start = boxed.indexOf(AWS_KEY);
  for (let cut = 1; cut < boxed.length; cut++) {
    const scanner = new SecretScanner([AWS], [EXAMPLE_BOX]);
    scanner.push(boxed.slice(0, cut));
    scanner.push(boxed.slice(cut));
    assert.deepEqual(
      scanner.finish(),
      [{ start, end: start + 20, patterns: ["aws-key"], suppressed: true }],
      `cut at ${cut}`,
    );
  }
});

test("overlapping pattern matches are merged into one finding", () => {
  const patterns: BytePattern[] = [
    { name: "alpha4num4", regex: /[a-z]{4}[0-9]{4}/, maxLength: 8 },
    { name: "num4alpha4", regex: /[0-9]{4}[a-z]{4}/, maxLength: 8 },
    { name: "pin4", regex: /[0-9]{4}/, maxLength: 4 },
  ];
  const findings = scan("xx abcd1234wxyz yy", patterns);
  assert.deepEqual(findings, [
    {
      start: 3,
      end: 15,
      patterns: ["alpha4num4", "pin4", "num4alpha4"],
      suppressed: false,
    },
  ]);
});

test("adjacent but non-overlapping matches are not merged", () => {
  const patterns: BytePattern[] = [
    { name: "alpha4num4", regex: /[a-z]{4}[0-9]{4}/, maxLength: 8 },
    { name: "num4alpha4", regex: /[0-9]{4}[a-z]{4}/, maxLength: 8 },
  ];
  const findings = scan("abcd1234 zz 0000wxyz", patterns);
  assert.deepEqual(findings, [
    { start: 0, end: 8, patterns: ["alpha4num4"], suppressed: false },
    { start: 12, end: 20, patterns: ["num4alpha4"], suppressed: false },
  ]);
});

test("masked preview hides active findings and keeps whitelisted ones", () => {
  const { findings } = scanWhole(corpus);
  const preview = maskPreview(corpus, findings);
  assert.equal(preview.length, corpus.length);

  const aws1 = corpus.indexOf(AWS_KEY);
  assert.equal(preview.slice(aws1, aws1 + 20), "*".repeat(20));

  const safe = corpus.indexOf(SAFE_HEX);
  assert.equal(preview.slice(safe, safe + 32), "*".repeat(32));

  const boxStart = corpus.indexOf("EXAMPLE[");
  assert.equal(preview.slice(boxStart, boxStart + 29), `EXAMPLE[${AWS_KEY}]`);

  const hexBox = corpus.indexOf("EXAMPLE[", boxStart + 1);
  assert.equal(preview.slice(hexBox, hexBox + 41), `EXAMPLE[${HEX32_VALUE}]`);

  // Text outside findings is untouched.
  assert.equal(preview.slice(0, aws1), corpus.slice(0, aws1));
});

test("report lists original offsets and suppression status", () => {
  const scanner = new SecretScanner([AWS]);
  scanner.push("prefix " + AWS_KEY.slice(0, 10));
  scanner.push(AWS_KEY.slice(10) + " suffix");
  const report = formatReport(scanner.finish());
  assert.match(report, /\[7\.\.27\) aws-key ACTIVE/);
  assert.equal(formatReport([]), "no secrets found");
});

test("match longer than the declared maxLength throws", () => {
  assert.throws(
    () => scan("aaaa", [{ name: "bad", regex: /a+/, maxLength: 2 }]),
    /exceeding its declared maxLength/,
  );
});

test("empty input yields no findings", () => {
  assert.deepEqual(scan("", SECRETS, WHITELIST), []);
  const scanner = new SecretScanner(SECRETS, WHITELIST);
  assert.deepEqual(scanner.finish(), []);
});

test("push after finish throws", () => {
  const scanner = new SecretScanner([AWS]);
  scanner.finish();
  assert.throws(() => scanner.push("x"), /after finish/);
});
