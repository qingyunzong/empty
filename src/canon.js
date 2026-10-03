"use strict";

const crypto = require("node:crypto");

// Marker used in snapshots and diff output for a cell whose column is absent
// (distinct from NULL, which is an explicit value).
const MISSING = Object.freeze({ $missing: true });

function isMissing(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.$missing === true;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonNumber(n) {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Object.is(n, -0)) return "0";
  return String(n);
}

function stableStringify(value) {
  if (value === null) return "null";
  if (typeof value === "number") return canonNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  throw new Error("cannot canonically stringify value of type " + typeof value);
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

module.exports = { MISSING, isMissing, isPlainObject, canonNumber, stableStringify, sha256 };
