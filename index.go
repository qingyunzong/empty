// Package dualidx maintains a content index and a path index over a
// directory of files. Batch updates are built and published as immutable
// generations: readers always see both indexes from the same generation,
// failed builds keep the previous generation, and a retired generation's
// files are removed only after its last reader releases it.
package dualidx

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// ContentIndex is an inverted index from term to the sorted set of
// document IDs containing that term.
type ContentIndex struct {
	Postings map[string][]uint64
}

// PathIndex maps between document IDs and their source-relative paths.
type PathIndex struct {
	PathToID map[string]uint64
	IDToPath map[uint64]string
}

// tokenize splits content into lowercased alphanumeric terms.
func tokenize(content string) []string {
	return strings.FieldsFunc(strings.ToLower(content), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
}

// buildIndexes scans srcDir and builds both indexes from the same snapshot
// of file contents, so they always describe the same corpus generation.
func buildIndexes(srcDir string) (*ContentIndex, *PathIndex, error) {
	var paths []string
	err := filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, err := filepath.Rel(srcDir, p)
			if err != nil {
				return err
			}
			paths = append(paths, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(paths)

	content := &ContentIndex{Postings: make(map[string][]uint64)}
	pathIdx := &PathIndex{
		PathToID: make(map[string]uint64, len(paths)),
		IDToPath: make(map[uint64]string, len(paths)),
	}
	for id, rel := range paths {
		docID := uint64(id)
		pathIdx.PathToID[rel] = docID
		pathIdx.IDToPath[docID] = rel

		data, err := os.ReadFile(filepath.Join(srcDir, filepath.FromSlash(rel)))
		if err != nil {
			return nil, nil, err
		}
		seen := make(map[string]struct{})
		for _, term := range tokenize(string(data)) {
			if _, dup := seen[term]; dup {
				continue
			}
			seen[term] = struct{}{}
			content.Postings[term] = append(content.Postings[term], docID)
		}
	}
	return content, pathIdx, nil
}
