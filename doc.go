// Package q214 provides an embeddable, dependency-free verifier for compact
// HS256 tokens with three unpadded base64url segments.
//
// The verifier is constructed with a caller-supplied Clock, a fixed audience
// and an atomically rotatable, kid-addressed KeySet. Each verification pins
// one immutable key-set snapshot, enforces canonical encodings and strict
// JSON, rejects every algorithm other than HS256, consults the revocation
// list before signature checks, and only hands validated Claims to a
// business callback. The validity window is the half-open interval
// nbf <= now < exp.
package q214
