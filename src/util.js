"use strict";

const crypto = require("node:crypto");

const GENESIS = "0".repeat(64);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function chainHash(prev, op) {
  return crypto.createHash("sha256").update(prev + "\n" + canonical(op)).digest("hex");
}

module.exports = { canonical, chainHash, GENESIS };
