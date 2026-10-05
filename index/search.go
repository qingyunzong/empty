package index

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
)

// Match is a verified search hit: the source bytes at [Offset,
// Offset+Length) were re-read and their digest matches the index.
type Match struct {
	LineRef
	Text string
}

// Search returns the lines containing pattern. Every candidate reference
// is verified against the source: the bytes are re-read from the file and
// their SHA-256 must equal the digest recorded in the index, otherwise
// ErrStale is returned and no unverified positions are reported.
func Search(idx *Index, pattern []byte) ([]Match, error) {
	f, err := os.Open(idx.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() < idx.Size {
		return nil, fmt.Errorf("%w: file truncated from %d to %d bytes", ErrStale, idx.Size, fi.Size())
	}

	var matches []Match
	for _, ref := range idx.Lines {
		buf := make([]byte, ref.Length)
		if _, err := f.ReadAt(buf, ref.Offset); err != nil {
			return nil, fmt.Errorf("line %d: %w", ref.Num, err)
		}
		sum := sha256.Sum256(buf)
		if hex.EncodeToString(sum[:]) != ref.Digest {
			return nil, fmt.Errorf("%w: line %d content changed at offset %d", ErrStale, ref.Num, ref.Offset)
		}
		if bytes.Contains(buf, pattern) {
			matches = append(matches, Match{LineRef: ref, Text: string(buf)})
		}
	}
	return matches, nil
}
