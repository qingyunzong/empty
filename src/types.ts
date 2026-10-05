export interface CertNode {
  id: string;
  issuer: string | string[] | null;
  notBefore: string;
  notAfter: string;
  usages: string[];
}

export interface Graph {
  certs: CertNode[];
  trustedRoots: string[];
}

export interface VerifyRequest {
  leaf: string;
  usage: string;
  at: string;
}

export const MAX_CHAIN_LENGTH = 12;
