// Package materialpub publishes immutable test-result material packages
// (test log, summary, exit code) in a crash-safe way.
//
// A package is assembled under <root>/runs/<runID>/ and becomes visible to
// readers only when its manifest is atomically renamed into place, which
// happens strictly after every data file is durably written, fsynced and
// re-verified against its digest. Readers therefore observe either a
// complete, digest-verified package or no package at all.
//
// A run ID is claimed by the first publisher that touches it; the claim
// durably records the package digest. Any retry of the same run ID with a
// different digest is rejected with ErrDigestConflict, whether or not the
// original attempt finished publishing.
package materialpub
