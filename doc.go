// Package dataeng resolves how a collected page body should be decoded.
//
// Resolution considers only evidence supplied by the caller: a transport
// charset, the leading body bytes, and whether those bytes form a complete
// sample. It recognizes UTF-8, UTF-16LE, and UTF-16BE BOMs, then a non-empty
// transport charset, then the earliest meta charset outside script and style
// elements, and finally UTF-8.
package dataeng
