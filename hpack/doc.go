// Package hpack implements an HPACK (RFC 7541) header block decoder for an
// HTTP/2 collection host.
//
// The decoder is deliberately table-agnostic: the caller supplies both the
// static table and the byte-wise Huffman code table. This package never
// embeds either table, so the same code works against caller-owned fixtures
// or alternative profiles.
//
// A Decoder keeps the connection dynamic table and the failure state. Once a
// compression error is observed on a connection, the Decoder is permanently
// unusable, matching the RFC 7541 requirement that the compression context be
// destroyed. Header blocks are streamed: representations may span any number
// of Write calls, and decoded fields are only handed back when the whole
// header block terminates without error.
package hpack
