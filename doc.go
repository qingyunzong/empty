// Package dataeng builds block-partitioned inverted indexes and performs exact
// top-k retrieval from block metadata plus an injected read-only block store.
//
// All scores are exact math/big.Rat values.  Search does not use floating point
// arithmetic and orders equal scores by ascending uint64 document ID.
//
// BuildIndex validates a strictly increasing immutable directory and per-term
// posting lists, computes each block's real maximum contribution, and writes
// complete block payloads to a BlockWriter.  The returned IndexMetadata
// contains only the directory and block metadata.
//
// A Searcher holds that metadata and a BlockReader, never a copy of every
// posting.  It walks document-ID windows whose per-term block coverage is
// constant, compares the exact sum of block-maximum score bounds with the
// current kth score, and emits SkipRecord receipts.  VerifySkipRecords checks
// each receipt independently against the block metadata.
package dataeng
