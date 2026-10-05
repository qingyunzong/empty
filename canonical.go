// Package merklefs builds content-addressed manifests of directory trees and
// Merkle proofs over them.
//
// Path canonical encoding: every path stored in a Manifest is a relative,
// slash-separated, clean path containing only valid UTF-8. Valid UTF-8 as
// defined by unicode/utf8 rejects overlong encodings, surrogates and out of
// range code points, so the stored form is the canonical (shortest) UTF-8
// encoding of each code point. Entries are ordered by byte-wise comparison of
// these canonical paths, which for UTF-8 coincides with code-point order.
package merklefs

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Canonicalize validates p and returns its canonical form: a clean,
// slash-separated relative path in canonical UTF-8.
func Canonicalize(p string) (string, error) {
	if p == "" {
		return "", errors.New("merklefs: empty path")
	}
	if !utf8.ValidString(p) {
		return "", fmt.Errorf("merklefs: path %q is not canonical UTF-8", p)
	}
	if strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("merklefs: path %q is not relative", p)
	}
	parts := strings.Split(p, "/")
	for _, seg := range parts {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("merklefs: path %q is not clean", p)
		}
		if strings.ContainsRune(seg, '\\') {
			return "", fmt.Errorf("merklefs: path %q contains a backslash", p)
		}
	}
	return p, nil
}

// pathLess reports whether canonical path a sorts before b in UTF-8 byte
// order. Byte-wise comparison of UTF-8 yields code-point order.
func pathLess(a, b string) bool { return a < b }

// sortEntries sorts entries by canonical path in UTF-8 byte order.
func sortEntries(entries []Entry) {
	sortSlice(entries, func(i, j int) bool {
		return pathLess(entries[i].Path, entries[j].Path)
	})
}

// entryIndex returns the position of path in the sorted entries, and whether
// it was found.
func entryIndex(entries []Entry, path string) (int, bool) {
	lo, hi := 0, len(entries)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if pathLess(entries[mid].Path, path) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(entries) && entries[lo].Path == path {
		return lo, true
	}
	return lo, false
}

// equalPaths reports whether two canonical paths are identical.
func equalPaths(a, b string) bool { return bytes.Equal([]byte(a), []byte(b)) }
