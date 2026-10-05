import { test } from "node:test";
import * as assert from "node:assert/strict";
import { normalizeDomain, isIPv4Address } from "../src/domain.js";

function expectError(raw: string, error: string): void {
  const r = normalizeDomain(raw);
  assert.ok(!r.ok, `expected "${raw}" to be rejected`);
  if (!r.ok) assert.equal(r.error, error, `"${raw}": ${r.detail}`);
}

test("case folding", () => {
  const r = normalizeDomain("ExAmPle.COM");
  assert.deepEqual(r, { ok: true, domain: "example.com" });
});

test("trailing-dot normalization strips exactly one root dot", () => {
  assert.deepEqual(normalizeDomain("Example.Com."), { ok: true, domain: "example.com" });
  // A second trailing dot leaves an empty label -> rejected.
  expectError("example.com..", "EMPTY_LABEL");
});

test("empty input and empty labels are rejected", () => {
  expectError("", "EMPTY_INPUT");
  expectError(".", "EMPTY_LABEL");
  expectError("a..b", "EMPTY_LABEL");
  expectError(".example.com", "EMPTY_LABEL");
  expectError("example..com", "EMPTY_LABEL");
});

test("non-ASCII (illegal encoding) is rejected before anything else", () => {
  expectError("exämple.com", "NON_ASCII");
  expectError("例子.com", "NON_ASCII");
  expectError("example。com", "NON_ASCII"); // U+3002 ideographic full stop
  // Punycode is plain ASCII and syntactically valid, so it is accepted as-is.
  assert.ok(normalizeDomain("xn--nxasmq6b.example").ok);
});

test("label charset and hyphen rules", () => {
  expectError("exa_mple.com", "INVALID_CHAR");
  expectError("ex ample.com", "INVALID_CHAR");
  expectError("a+b.com", "INVALID_CHAR");
  expectError("-example.com", "BAD_HYPHEN");
  expectError("example-.com", "BAD_HYPHEN");
  assert.deepEqual(normalizeDomain("a-b.example-1.com"), { ok: true, domain: "a-b.example-1.com" });
});

test("length limits", () => {
  expectError(`${"a".repeat(64)}.com`, "LABEL_TOO_LONG");
  assert.ok(normalizeDomain(`${"a".repeat(63)}.com`).ok);
  const name253 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  assert.equal(name253.length, 253);
  assert.ok(normalizeDomain(name253).ok);
  expectError(`${name253}e`, "NAME_TOO_LONG");
});

test("IPv4 masquerades are rejected in all inet_aton forms", () => {
  expectError("1.2.3.4", "IP_MASQUERADE");
  expectError("1.2.3.4.", "IP_MASQUERADE"); // trailing dot normalized first
  expectError("127.1", "IP_MASQUERADE"); // two-part form
  expectError("10.0.257", "IP_MASQUERADE"); // 257 == 0x101 fits the 16-bit tail
  expectError("2130706433", "IP_MASQUERADE"); // single 32-bit number
  expectError("0x7f.0.0.1", "IP_MASQUERADE"); // hex part
  expectError("0177.0.0.1", "IP_MASQUERADE"); // octal part
  expectError("0xffffffff", "IP_MASQUERADE");
});

test("numeric-looking names that are NOT IPs are accepted", () => {
  assert.ok(normalizeDomain("1.2.3.4.5").ok); // five numeric labels
  assert.ok(normalizeDomain("256.1.1.1").ok); // 256 > 255
  assert.ok(normalizeDomain("1.2.3.256").ok);
  assert.ok(normalizeDomain("4294967296").ok); // 2^32, does not fit
  assert.ok(normalizeDomain("123.com").ok);
});

test("isIPv4Address unit checks", () => {
  assert.equal(isIPv4Address("127.0.0.1"), true);
  assert.equal(isIPv4Address("127.1"), true);
  assert.equal(isIPv4Address("0x7f.1"), true);
  assert.equal(isIPv4Address("example.com"), false);
  assert.equal(isIPv4Address("1.2.3.4.5"), false);
});
