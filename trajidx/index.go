// Package trajidx builds and maintains sidecar line indexes for log files.
// The original file is never modified; offsets and digests live in a
// separate index that can be serialized to JSON.
package trajidx

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"os"
)

// Checkpoint anchors a line boundary so incremental updates can verify the
// indexed prefix and locate the first untrusted region without a full rescan.
type Checkpoint struct {
	Offset int64  `json:"offset"` // byte offset at the start of Line
	Line   int64  `json:"line"`   // 0-based line number
	Digest string `json:"digest"` // hex sha256 of file bytes in [0, Offset)
}

// LineEntry records where one line lives in the file.
type LineEntry struct {
	Offset int64 `json:"offset"`
	Length int64 `json:"length"` // includes the trailing '\n' when present
}

// Index is the sidecar description of a file at a moment in time.
type Index struct {
	Path            string       `json:"path"`
	Size            int64        `json:"size"`
	LineCount       int64        `json:"line_count"`
	EndsWithNewline bool         `json:"ends_with_newline"`
	Digest          string       `json:"digest"` // hex sha256 of file bytes in [0, Size)
	CheckpointEvery int64        `json:"checkpoint_every"`
	Checkpoints     []Checkpoint `json:"checkpoints"`
	Lines           []LineEntry  `json:"lines"`
}

// Region is a half-open byte range [Start, End) of the file.
type Region struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

func (r Region) String() string { return fmt.Sprintf("[%d, %d)", r.Start, r.End) }

func newHash() hash.Hash { return sha256.New() }

func digestHex(h hash.Hash) string { return hex.EncodeToString(h.Sum(nil)) }

// scan reads lines from r starting at byte offset start and line number
// startLine, feeding every byte into h and appending entries to idx.
// It streams with bufio so arbitrarily long lines and multi-byte content
// are handled without loading the file into memory, and a final line
// without a trailing newline is still indexed.
func scan(r io.Reader, start, startLine int64, h hash.Hash, idx *Index) error {
	br := bufio.NewReaderSize(r, 64*1024)
	offset := start
	line := startLine
	for {
		chunk, err := br.ReadBytes('\n')
		if len(chunk) > 0 {
			if line%idx.CheckpointEvery == 0 {
				idx.Checkpoints = append(idx.Checkpoints, Checkpoint{
					Offset: offset,
					Line:   line,
					Digest: digestHex(h),
				})
			}
			h.Write(chunk)
			idx.Lines = append(idx.Lines, LineEntry{Offset: offset, Length: int64(len(chunk))})
			offset += int64(len(chunk))
			line++
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	idx.Size = offset
	idx.LineCount = line
	idx.Digest = digestHex(h)
	return nil
}

// hashPrefix returns a hash that has consumed exactly the first n bytes of f.
func hashPrefix(f io.Reader, n int64) (hash.Hash, error) {
	h := newHash()
	if _, err := io.CopyN(h, f, n); err != nil {
		return nil, err
	}
	return h, nil
}

// Build full-scans path and returns a fresh index. The file is only read.
func Build(path string, checkpointEvery int64) (*Index, error) {
	if checkpointEvery < 1 {
		checkpointEvery = 1
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	idx := &Index{Path: path, CheckpointEvery: checkpointEvery}
	if err := scan(f, 0, 0, newHash(), idx); err != nil {
		return nil, err
	}
	finalizeNewlineFlag(path, idx)
	return idx, nil
}

// finalizeNewlineFlag reads the last byte to set EndsWithNewline correctly.
func finalizeNewlineFlag(path string, idx *Index) {
	idx.EndsWithNewline = false
	if idx.Size == 0 {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	buf := make([]byte, 1)
	if _, err := f.ReadAt(buf, idx.Size-1); err == nil {
		idx.EndsWithNewline = buf[0] == '\n'
	}
}

// locateFirstUntrusted hashes the current file prefix of limit bytes in one
// streaming pass, comparing against old checkpoints. It returns the index of
// the last checkpoint whose digest still matches (-1 if none) and the
// half-open region that can no longer be trusted.
func locateFirstUntrusted(f *os.File, old *Index, limit int64) (lastTrusted int, region Region, err error) {
	lastTrusted = -1
	h := newHash()
	cps := old.Checkpoints
	next := 0
	pos := int64(0)
	br := bufio.NewReaderSize(f, 64*1024)
	region = Region{Start: 0, End: limit}
	for next < len(cps) && cps[next].Offset <= limit {
		cp := cps[next]
		if cp.Offset > pos {
			m, cerr := io.CopyN(h, br, cp.Offset-pos)
			pos += m
			if cerr != nil {
				return lastTrusted, region, cerr
			}
		}
		if digestHex(h) != cp.Digest {
			// First mismatch: region starts at the previous trusted
			// checkpoint (or 0) and extends to this checkpoint.
			start := int64(0)
			if lastTrusted >= 0 {
				start = cps[lastTrusted].Offset
			}
			end := cp.Offset
			if end > limit {
				end = limit
			}
			return lastTrusted, Region{Start: start, End: end}, nil
		}
		lastTrusted = next
		next++
	}
	// All checkpoints within limit matched. If the file was truncated, the
	// tail beyond the last trusted checkpoint cannot be verified.
	if limit < old.Size {
		start := int64(0)
		if lastTrusted >= 0 {
			start = cps[lastTrusted].Offset
		}
		return lastTrusted, Region{Start: start, End: limit}, nil
	}
	// Consume the rest of the prefix so the caller can compare the full
	// digest of [0, old.Size).
	if _, cerr := io.CopyN(h, br, limit-pos); cerr != nil {
		return lastTrusted, region, cerr
	}
	if digestHex(h) != old.Digest {
		start := int64(0)
		if lastTrusted >= 0 {
			start = cps[lastTrusted].Offset
		}
		return lastTrusted, Region{Start: start, End: limit}, nil
	}
	return lastTrusted, Region{}, nil
}

// Update incrementally re-indexes path against old. If the indexed prefix is
// intact it only scans the appended tail; otherwise it locates the first
// untrusted region, reports it, and rebuilds from the last trusted
// checkpoint. The returned region is nil when the prefix was fully trusted.
func Update(path string, old *Index) (*Index, *Region, error) {
	k := old.CheckpointEvery
	if k < 1 {
		k = 1
	}
	fi, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	size := fi.Size()
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	limit := size
	if old.Size < limit {
		limit = old.Size
	}
	lastTrusted, region, lerr := locateFirstUntrusted(f, old, limit)
	if lerr != nil {
		return nil, nil, lerr
	}

	prefixIntact := region == (Region{}) && size >= old.Size
	if prefixIntact && size == old.Size {
		return old, nil, nil // unchanged
	}

	if prefixIntact {
		// Pure append: keep everything, hash the verified prefix, scan
		// the tail. If the old file did not end with a newline its last
		// line continues into the appended bytes, so back up to the
		// start of that partial line and rescan it.
		resume := old.Size
		resumeLine := old.LineCount
		lines := old.Lines
		cps := old.Checkpoints
		if !old.EndsWithNewline && len(old.Lines) > 0 {
			last := old.Lines[len(old.Lines)-1]
			resume = last.Offset
			resumeLine = old.LineCount - 1
			lines = old.Lines[:len(old.Lines)-1]
			cut := len(cps)
			for cut > 0 && cps[cut-1].Offset >= resume {
				cut--
			}
			cps = cps[:cut]
		}
		idx := &Index{
			Path:            path,
			CheckpointEvery: k,
			Checkpoints:     append([]Checkpoint(nil), cps...),
			Lines:           append([]LineEntry(nil), lines...),
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return nil, nil, err
		}
		h, err := hashPrefix(f, resume)
		if err != nil {
			return nil, nil, err
		}
		// hashPrefix leaves the file positioned at resume.
		if err := scan(f, resume, resumeLine, h, idx); err != nil {
			return nil, nil, err
		}
		finalizeNewlineFlag(path, idx)
		return idx, nil, nil
	}

	// Rebuild from the last trusted checkpoint.
	idx := &Index{Path: path, CheckpointEvery: k}
	resume := int64(0)
	resumeLine := int64(0)
	if lastTrusted >= 0 {
		cp := old.Checkpoints[lastTrusted]
		resume = cp.Offset
		resumeLine = cp.Line
		idx.Checkpoints = append(idx.Checkpoints, old.Checkpoints[:lastTrusted]...)
		idx.Lines = append(idx.Lines, old.Lines[:cp.Line]...)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, nil, err
	}
	h, err := hashPrefix(f, resume)
	if err != nil {
		return nil, nil, err
	}
	// hashPrefix leaves the file positioned at resume.
	if err := scan(f, resume, resumeLine, h, idx); err != nil {
		return nil, nil, err
	}
	finalizeNewlineFlag(path, idx)
	return idx, &region, nil
}

// Verify re-hashes the whole file and compares it against the index.
func Verify(path string, idx *Index) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := newHash()
	n, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if n != idx.Size {
		return fmt.Errorf("size mismatch: file=%d index=%d", n, idx.Size)
	}
	if got := digestHex(h); got != idx.Digest {
		return fmt.Errorf("digest mismatch: file=%s index=%s", got, idx.Digest)
	}
	return nil
}

// Save writes the index as JSON; Load reads it back.
func Save(idx *Index, w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(idx)
}

func Load(r io.Reader) (*Index, error) {
	var idx Index
	if err := json.NewDecoder(r).Decode(&idx); err != nil {
		return nil, err
	}
	return &idx, nil
}
