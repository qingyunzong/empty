import { readFileSync } from "node:fs";
import { CertNode, Graph } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseGraph(raw: unknown): Graph {
  if (!isRecord(raw)) throw new Error("graph must be a JSON object");
  if (!Array.isArray(raw.certs)) throw new Error("graph.certs must be an array");
  if (!Array.isArray(raw.trustedRoots))
    throw new Error("graph.trustedRoots must be an array");

  const certs: CertNode[] = raw.certs.map((c: unknown, i: number) => {
    if (!isRecord(c)) throw new Error(`certs[${i}] must be an object`);
    for (const key of ["id", "notBefore", "notAfter"] as const) {
      if (typeof c[key] !== "string" || c[key] === "")
        throw new Error(`certs[${i}].${key} must be a non-empty string`);
    }
    const issuerOk =
      c.issuer === null ||
      typeof c.issuer === "string" ||
      (Array.isArray(c.issuer) &&
        c.issuer.every((x: unknown) => typeof x === "string"));
    if (!issuerOk)
      throw new Error(
        `certs[${i}].issuer must be a string, string array, or null`,
      );
    if (
      !Array.isArray(c.usages) ||
      c.usages.some((u: unknown) => typeof u !== "string")
    )
      throw new Error(`certs[${i}].usages must be an array of strings`);
    if (Number.isNaN(Date.parse(c.notBefore as string)))
      throw new Error(`certs[${i}].notBefore is not a valid date`);
    if (Number.isNaN(Date.parse(c.notAfter as string)))
      throw new Error(`certs[${i}].notAfter is not a valid date`);
    return c as unknown as CertNode;
  });

  const ids = new Set<string>();
  for (const c of certs) {
    if (ids.has(c.id)) throw new Error(`duplicate cert id: ${c.id}`);
    ids.add(c.id);
  }
  for (const c of certs) {
    for (const iss of issuersOf(c)) {
      if (!ids.has(iss))
        throw new Error(`cert ${c.id} references unknown issuer ${iss}`);
    }
  }
  const trustedRoots = raw.trustedRoots.map((r: unknown) => {
    if (typeof r !== "string") throw new Error("trustedRoots must be strings");
    if (!ids.has(r)) throw new Error(`trusted root ${r} not in certs`);
    return r;
  });
  return { certs, trustedRoots };
}

export function issuersOf(c: CertNode): string[] {
  if (c.issuer === null) return [];
  return typeof c.issuer === "string" ? [c.issuer] : c.issuer;
}

export function loadGraph(path: string): Graph {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read graph file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`graph file is not valid JSON: ${path}`);
  }
  return parseGraph(raw);
}
