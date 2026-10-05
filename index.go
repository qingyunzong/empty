// Package logindex builds and maintains a line/byte-range index over
// variable-length UTF-8 log files. The index covers the longest prefix of
// the file that consists of complete lines (each terminated by '\n') and is
// protected by the SHA-256 digest of that prefix: pure appends can be
// indexed incrementally, while any modification or truncation of the
// already-indexed region causes the old index to be rejected.
package logindex

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// ErrSourceChanged is returned (wrapped) when the indexed prefix of the
// source no longer matches the digest stored in the index, i.e. the
// original segment was modified or truncated and the old index is rejected.
var ErrSourceChanged = errors.New("logindex: source changed, old index rejected")

// Line describes one complete line as a byte range in the source file.
type Line struct {
	Offset int64 `json:"offset"` // byte offset of the first byte of the line
	Length int   `json:"length"` // bytes of the line, including the trailing '\n'
}

// Index maps line numbers to byte ranges for the indexed prefix of a log.
type Index struct {
	Digest     [sha256.Size]byte `json:"digest"`     // SHA-256 of source[0:IndexedLen]
	IndexedLen int64             `json:"indexedLen"` // bytes covered by Lines (complete lines only)
	Lines      []Line            `json:"lines"`
}

// Hit is one search result, verified against the current source bytes.
type Hit struct {
	Line   int    // 1-based line number
	Offset int64  // byte offset of the line in the source
	Length int    // byte length of the line (including '\n' if present)
	Text   string // line content without the trailing newline
}

// scanCompleteLines consumes r and appends every complete ('\n'-terminated)
// line to dst, numbering byte offsets from base. It returns the extended
// slice and the number of bytes occupied by complete lines; a trailing
// partial line (no '\n' before EOF) is left unindexed and unconsumed.
func scanCompleteLines(r io.Reader, base int64, dst []Line) ([]Line, int64, error) {
	br := bufio.NewReaderSize(r, 64*1024)
	offset := base
	for {
		chunk, err := br.ReadBytes('\n')
		if len(chunk) > 0 && chunk[len(chunk)-1] == '\n' {
			dst = append(dst, Line{Offset: offset, Length: len(chunk)})
			offset += int64(len(chunk))
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return dst, offset - base, nil
			}
			return dst, offset - base, err
		}
	}
}

// digestPrefix returns the SHA-256 of the first n bytes of f.
func digestPrefix(f *os.File, n int64) ([sha256.Size]byte, error) {
	var sum [sha256.Size]byte
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return sum, err
	}
	h := sha256.New()
	if _, err := io.CopyN(h, f, n); err != nil {
		return sum, err
	}
	copy(sum[:], h.Sum(nil))
	return sum, nil
}

// Build scans path from scratch and returns a fresh index.
func Build(path string) (*Index, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	lines, consumed, err := scanCompleteLines(f, 0, nil)
	if err != nil {
		return nil, err
	}
	sum, err := digestPrefix(f, consumed)
	if err != nil {
		return nil, err
	}
	return &Index{Digest: sum, IndexedLen: consumed, Lines: lines}, nil
}

// Update incrementally extends idx for path. It verifies that the previously
// indexed prefix is byte-identical (via the stored digest); if the original
// segment was modified or the file was truncated, the old index is rejected
// with ErrSourceChanged. Pure appends are scanned incrementally. It reports
// whether the index grew.
func Update(path string, idx *Index) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false, err
	}
	size := st.Size()
	if size < idx.IndexedLen {
		return false, fmt.Errorf("%w: truncated to %d bytes, indexed prefix is %d bytes",
			ErrSourceChanged, size, idx.IndexedLen)
	}
	sum, err := digestPrefix(f, idx.IndexedLen)
	if err != nil {
		return false, err
	}
	if sum != idx.Digest {
		return false, fmt.Errorf("%w: digest mismatch over %d indexed bytes",
			ErrSourceChanged, idx.IndexedLen)
	}
	if size == idx.IndexedLen {
		return false, nil // up to date
	}
	if _, err := f.Seek(idx.IndexedLen, io.SeekStart); err != nil {
		return false, err
	}
	lines, consumed, err := scanCompleteLines(f, idx.IndexedLen, idx.Lines)
	if err != nil {
		return false, err
	}
	if consumed == 0 {
		return false, nil // only a partial tail line was appended
	}
	idx.Lines = lines
	idx.IndexedLen += consumed
	sum, err = digestPrefix(f, idx.IndexedLen)
	if err != nil {
		return false, err
	}
	idx.Digest = sum
	return true, nil
}

// Verify checks that the current source still matches the indexed prefix
// digest. Search results are only meaningful after Verify succeeds.
func (idx *Index) Verify(f *os.File) error {
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() < idx.IndexedLen {
		return fmt.Errorf("%w: truncated to %d bytes, indexed prefix is %d bytes",
			ErrSourceChanged, st.Size(), idx.IndexedLen)
	}
	sum, err := digestPrefix(f, idx.IndexedLen)
	if err != nil {
		return err
	}
	if sum != idx.Digest {
		return fmt.Errorf("%w: digest mismatch over %d indexed bytes",
			ErrSourceChanged, idx.IndexedLen)
	}
	return nil
}

// Search returns every line containing query, with positions taken from the
// index and confirmed against the live source. The indexed prefix digest is
// verified against the current source first (核源摘要); a mismatch rejects
// the stale index with ErrSourceChanged. Bytes appended after the last
// update (including a partial tail line) are scanned directly from the
// source so results stay complete.
func Search(f *os.File, idx *Index, query []byte) ([]Hit, error) {
	if len(query) == 0 {
		return nil, errors.New("logindex: empty query")
	}
	if err := idx.Verify(f); err != nil {
		return nil, err
	}
	var hits []Hit
	var buf []byte
	for i, ln := range idx.Lines {
		if cap(buf) < ln.Length {
			buf = make([]byte, ln.Length)
		}
		b := buf[:ln.Length]
		if _, err := f.ReadAt(b, ln.Offset); err != nil {
			return nil, err
		}
		if bytes.Contains(b, query) {
			hits = append(hits, Hit{
				Line:   i + 1,
				Offset: ln.Offset,
				Length: ln.Length,
				Text:   string(bytes.TrimSuffix(b, []byte{'\n'})),
			})
		}
	}
	// Scan the not-yet-indexed tail (appended complete lines and/or one
	// partial line) straight from the source.
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() > idx.IndexedLen {
		tail := make([]byte, st.Size()-idx.IndexedLen)
		if _, err := f.ReadAt(tail, idx.IndexedLen); err != nil {
			return nil, err
		}
		lineNo := len(idx.Lines)
		offset := idx.IndexedLen
		for len(tail) > 0 {
			lineNo++
			n := bytes.IndexByte(tail, '\n') + 1
			if n <= 0 {
				n = len(tail)
			}
			seg := tail[:n]
			if bytes.Contains(seg, query) {
				hits = append(hits, Hit{
					Line:   lineNo,
					Offset: offset,
					Length: n,
					Text:   string(bytes.TrimSuffix(seg, []byte{'\n'})),
				})
			}
			tail = tail[n:]
			offset += int64(n)
		}
	}
	return hits, nil
}

// Save writes idx as JSON to path.
func Save(idx *Index, path string) error {
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// Load reads a JSON index from path.
func Load(path string) (*Index, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var idx Index
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, err
	}
	return &idx, nil
}
