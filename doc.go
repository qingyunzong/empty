// Package q218 implements an archive-format-independent ingestion component
// for the upload service.
//
// Callers provide an Iterator whose entries carry a name, a type (regular
// file or directory), a declared size and a content stream. Ingest
// normalizes every path, rejects duplicates, file/directory conflicts and
// out-of-root targets, enforces per-entry and whole-archive read budgets on
// the bytes actually consumed, and rolls the entire archive back when a
// file's real length differs from its declared size.
//
// Landing is transactional through the Stager/StageTx interfaces: any read
// failure, validation error or context cancellation aborts and reclaims the
// staging area; success publishes the whole tree in a single atomic commit.
// No concrete archive format (tar, zip, ...) is referenced anywhere.
package q218
