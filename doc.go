// Package dataeng computes structured body-text differences between two
// crawls of the same document.
//
// Snapshots contain content blocks with a DOM path, a document text range and
// publication-time evidence. Diff ignores advertisement, navigation and other
// page-chrome blocks, normalizes numeric DOM indices before matching, and keeps
// paragraph split/merge provenance.
//
// A Result contains add, delete, modify, split, merge and reorder events. Body
// changes and reading-order changes are always separate events. Use Ledger or
// Differ when several snapshot pairs belong to the same crawl generation: each
// logical event is then emitted only once for that generation.
package dataeng
