// Package dataeng provides immutable symbol-dictionary snapshots and
// all-or-nothing symbol relocation between snapshots.
//
// A Context assigns SIDs sequentially from 1 over three regions:
//
//   - a fixed system string dictionary;
//   - shared dictionary imports in caller-specified order;
//   - local known slots appended by the caller.
//
// SID 0 is the singleton local-unknown identity. Resolve returns tokens for
// system, imported and local slots. Known tokens carry complete text.
// Shared-unknown tokens carry a table name and a one-based position in that
// table, deliberately ignoring dictionary version. Local-unknown and
// shared-unknown identities are distinct.
//
// Contexts are immutable snapshots. AppendLocal and Reset return new
// snapshots and never modify an existing one, so previously resolved tokens
// remain valid after dictionary replacement, appending, or reset.
//
// Directory values describe shared tables either as materialized slot arrays
// or as unknown-length interval metadata. Import lengths come from an explicit
// maxID or the exact table length. Padding beyond a directory array is
// represented as interval metadata, not as an allocated slot array, so imports
// with very large visible lengths remain O(1) in memory.
//
// Relocate converts a token sequence into SIDs of a target snapshot
// atomically. Known text that has no target SID is appended to target local
// slots in first-occurrence order. A SharedUnknown token is accepted only when
// the target currently has an import slot with the same unknown identity. On
// failure Relocate returns the first failing token index and leaves the target
// unchanged.
package dataeng
