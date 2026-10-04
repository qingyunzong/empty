package materialpub

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

// File names that make up a material package.
const (
	TestLogFile  = "test.log"
	SummaryFile  = "summary.json"
	ExitCodeFile = "exitcode.txt"

	claimFile    = "claim.json"
	manifestFile = "manifest.json"
	tmpSuffix    = ".tmp"
)

// FileEntry pins one package file by name, size and content digest.
type FileEntry struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is the immutable index of a published package. It is the last
// object to appear in a run directory and its atomic rename is the commit
// point of a publish.
type Manifest struct {
	RunID  string      `json:"run_id"`
	Digest string      `json:"digest"`
	Files  []FileEntry `json:"files"`
}

// digestFiles computes the package digest over the canonical file list.
func digestFiles(files []FileEntry) string {
	sorted := make([]FileEntry, len(files))
	copy(sorted, files)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	h := sha256.New()
	for _, f := range sorted {
		fmt.Fprintf(h, "%s\x00%d\x00%s\n", f.Name, f.Size, f.SHA256)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// sha256Bytes returns the hex SHA-256 of b.
func sha256Bytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
