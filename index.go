package dualindex

import (
	"sort"
	"strings"
	"unicode"
)

// contentIndex maps a term to the sorted set of document paths containing it.
type contentIndex struct {
	Gen   int
	Terms map[string][]string
}

// PathEntry is the per-document record kept in the path index.
type PathEntry struct {
	Size  int64
	Terms int
}

// pathIndex maps a document path to its metadata.
type pathIndex struct {
	Gen   int
	Paths map[string]PathEntry
}

// tokenize splits content into lowercased alphanumeric terms.
func tokenize(content []byte) []string {
	return strings.FieldsFunc(strings.ToLower(string(content)), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// buildIndexes builds both indexes for generation gen from docs. Both indexes
// are always built from the same in-memory document set, so they can never
// diverge before persistence.
func buildIndexes(gen int, docs map[string][]byte) (*contentIndex, *pathIndex) {
	ci := &contentIndex{Gen: gen, Terms: make(map[string][]string)}
	pi := &pathIndex{Gen: gen, Paths: make(map[string]PathEntry)}
	for path, content := range docs {
		tokens := tokenize(content)
		seen := make(map[string]bool, len(tokens))
		for _, tok := range tokens {
			if !seen[tok] {
				seen[tok] = true
				ci.Terms[tok] = append(ci.Terms[tok], path)
			}
		}
		pi.Paths[path] = PathEntry{Size: int64(len(content)), Terms: len(tokens)}
	}
	for term := range ci.Terms {
		sort.Strings(ci.Terms[term])
	}
	return ci, pi
}
