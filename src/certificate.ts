export interface CertificateVerificationContext {
  readonly serverName: string;
  readonly now: number;
}

export interface CertificateChainResult {
  readonly trusted: boolean;
  readonly reason?: string;
  readonly identity?: unknown;
}

export interface CertificateSignatureInput {
  readonly identity: unknown;
  readonly algorithm: string;
  readonly data: Uint8Array;
  readonly signature: Uint8Array;
}

export interface CertificateVerifier {
  verifyChain(
    entries: readonly Uint8Array[],
    context: CertificateVerificationContext,
  ): CertificateChainResult;
  verifySignature(input: CertificateSignatureInput): boolean;
}

/**
 * Fail-closed default. Embedders must supply an X.509 path validator and a
 * signature verifier appropriate for their runtime.
 */
export class RejectAllCertificateVerifier implements CertificateVerifier {
  verifyChain(
    _entries: readonly Uint8Array[],
    _context: CertificateVerificationContext,
  ): CertificateChainResult {
    return { trusted: false, reason: "no certificate verifier configured" };
  }

  verifySignature(_input: CertificateSignatureInput): boolean {
    return false;
  }
}
