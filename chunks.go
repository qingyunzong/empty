package backupverify

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// ChunkStore resolves chunk references like "sha256:<hex>".
type ChunkStore interface {
	// Has reports whether the referenced chunk exists and matches its hash.
	Has(ref string) bool
}

// MapChunkStore is an in-memory chunk store, mainly for tests.
type MapChunkStore map[string][]byte

func (s MapChunkStore) Has(ref string) bool {
	hexDigest, ok := strings.CutPrefix(ref, "sha256:")
	if !ok {
		return false
	}
	data, ok := s[hexDigest]
	if !ok {
		return false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == hexDigest
}

// DirChunkStore serves chunks from a directory where each chunk is a file
// named by its lowercase hex sha256 digest.
type DirChunkStore string

func (d DirChunkStore) Has(ref string) bool {
	hexDigest, ok := strings.CutPrefix(ref, "sha256:")
	if !ok {
		return false
	}
	data, err := os.ReadFile(filepath.Join(string(d), hexDigest))
	if err != nil {
		return false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == hexDigest
}

// Put writes data to the store under its sha256 hex digest and returns the
// chunk reference.
func (d DirChunkStore) Put(data []byte) (string, error) {
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(string(d), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(string(d), name), data, 0o644); err != nil {
		return "", err
	}
	return "sha256:" + name, nil
}
