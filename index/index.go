// Package index builds and maintains line/byte-range indexes for
// variable-length UTF-8 log files, with digest-based staleness checks.
package index

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// ErrStale is returned when the indexed source bytes no longer match the
// recorded digest (original segments modified or file truncated).
var ErrStale = errors.New("index: source digest mismatch, index is stale")

const scanBufSize = 64 * 1024

// LineRef describes one line as a byte range in the source file.
type LineRef struct {
	Num    int    `json:"num"`    // 1-based line number
	Offset int64  `json:"offset"` // byte offset of the first line byte
	Length int    `json:"length"` // line length in bytes, excluding the newline
	Term   bool   `json:"term"`   // true if the line ends with '\n'
	Digest string `json:"digest"` // sha256 hex of the line bytes (no newline)
}

// Index maps line numbers to byte ranges and pins the indexed source
// prefix with a SHA-256 digest.
type Index struct {
	Path   string    `json:"path"`
	Size   int64     `json:"size"`   // indexed byte count
	Digest string    `json:"digest"` // sha256 hex of source bytes [0, Size)
	Lines  []LineRef `json:"lines"`
}

// base returns the offset at which scanning resumes on append: Size when
// the tail line is terminated, otherwise the start of the partial tail.
func (idx *Index) base() int64 {
	if n := len(idx.Lines); n > 0 && !idx.Lines[n-1].Term {
		return idx.Lines[n-1].Offset
	}
	return idx.Size
}

// Scanner incrementally splits a byte stream into line references.
// Chunks may be arbitrary sizes; results are identical to a full scan.
type Scanner struct {
	Lines []LineRef
	off   int64 // offset of buf[0] in the source
	buf   []byte
}

// NewScanner returns a Scanner whose next line starts at offset off.
func NewScanner(off int64) *Scanner {
	return &Scanner{off: off, Lines: make([]LineRef, 0, 64)}
}

// Resume returns a Scanner continuing after the given complete lines.
func Resume(lines []LineRef) *Scanner {
	s := &Scanner{Lines: lines}
	if n := len(lines); n > 0 {
		last := lines[n-1]
		s.off = last.Offset + int64(last.Length)
		if last.Term {
			s.off++
		}
	}
	return s
}

func (s *Scanner) emit(term bool) {
	sum := sha256.Sum256(s.buf)
	s.Lines = append(s.Lines, LineRef{
		Num:    len(s.Lines) + 1,
		Offset: s.off,
		Length: len(s.buf),
		Term:   term,
		Digest: hex.EncodeToString(sum[:]),
	})
	s.off += int64(len(s.buf))
	if term {
		s.off++
	}
	s.buf = s.buf[:0]
}

// Write consumes one chunk of the stream.
func (s *Scanner) Write(p []byte) {
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			s.buf = append(s.buf, p...)
			return
		}
		s.buf = append(s.buf, p[:i]...)
		s.emit(true)
		p = p[i+1:]
	}
}

// Finish flushes a trailing unterminated line, if any.
func (s *Scanner) Finish() {
	if len(s.buf) > 0 {
		s.emit(false)
	}
}

// Build scans the whole file and returns a fresh index.
func Build(path string) (*Index, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	h := sha256.New()
	s := NewScanner(0)
	buf := make([]byte, scanBufSize)
	var size int64
	for {
		n, err := f.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			h.Write(chunk)
			s.Write(chunk)
			size += int64(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	s.Finish()
	return &Index{
		Path:   path,
		Size:   size,
		Digest: hex.EncodeToString(h.Sum(nil)),
		Lines:  s.Lines,
	}, nil
}

// Update incrementally extends idx after a pure append to the source
// file. If any originally indexed byte changed (or the file shrank), it
// returns ErrStale and the caller must discard the old index and rebuild.
func Update(idx *Index) (*Index, error) {
	f, err := os.Open(idx.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := fi.Size()
	if size < idx.Size {
		return nil, fmt.Errorf("%w: file truncated from %d to %d bytes", ErrStale, idx.Size, size)
	}

	// Re-hash the previously indexed prefix [0, idx.Size) and refuse to
	// reuse the old index when any original segment was modified.
	h := sha256.New()
	if _, err := io.CopyN(h, io.NewSectionReader(f, 0, idx.Size), idx.Size); err != nil {
		return nil, err
	}
	if hex.EncodeToString(h.Sum(nil)) != idx.Digest {
		return nil, fmt.Errorf("%w: original segments modified", ErrStale)
	}
	if size == idx.Size {
		return idx, nil // unchanged
	}

	// Pure append: hash the new tail and scan only from the resume base.
	if _, err := io.Copy(h, io.NewSectionReader(f, idx.Size, size-idx.Size)); err != nil {
		return nil, err
	}

	lines := idx.Lines
	if n := len(lines); n > 0 && !lines[n-1].Term {
		lines = lines[:n-1] // re-split the partial tail line
	}
	s := Resume(lines)
	if _, err := f.Seek(s.off, io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, scanBufSize)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			s.Write(buf[:n])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	s.Finish()
	return &Index{
		Path:   idx.Path,
		Size:   size,
		Digest: hex.EncodeToString(h.Sum(nil)),
		Lines:  s.Lines,
	}, nil
}

// Save writes the index as JSON.
func Save(idx *Index, path string) error {
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// Load reads a JSON index.
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
