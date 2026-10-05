package tidx

import (
	"fmt"
	"io"
	"os"
)

// Reason classifies the outcome of a verification.
type Reason string

const (
	// OK: the file matches the index exactly.
	OK Reason = "ok"
	// Appended: the indexed prefix is intact, new bytes follow.
	Appended Reason = "appended"
	// Truncated: the file ends before the indexed size.
	Truncated Reason = "truncated"
	// Modified: a chain digest mismatch was found inside the indexed range.
	Modified Reason = "modified"
)

// Result describes a verification run.
//
// FirstUntrusted is the byte offset (in original-file coordinates) where
// trust ends: [0, FirstUntrusted) is verified intact and
// [FirstUntrusted, ...) is the first untrusted interval. For OK it equals
// the indexed file size.
type Result struct {
	Reason         Reason
	TrustedLines   uint64 // lines verified against the chain
	FirstUntrusted uint64 // start of the first untrusted interval
	Mismatches     uint64 // digest mismatches seen (Verify stops at 1)
}

// Verify incrementally checks r against idx and stops at the first
// untrusted line: it never reads past the first problem (a single peek
// byte aside) or past the end of the indexed range.
func Verify(r io.Reader, idx *Index) (Result, error) {
	return verify(r, idx, true)
}

// FullScan checks r against idx without early exit: it consumes the whole
// stream and counts every digest mismatch while reporting the same first
// untrusted offset. It is the reference used to cross-check Verify.
func FullScan(r io.Reader, idx *Index) (Result, error) {
	return verify(r, idx, false)
}

func verify(r io.Reader, idx *Index, earlyExit bool) (Result, error) {
	lr := getLineReader(r)
	var prev [DigestSize]byte
	res := Result{Reason: OK}
	for i, rec := range idx.Lines {
		n, _, digest, err := chainDigest(lr, prev)
		if err == io.EOF {
			// File ended exactly on a line boundary before line i. If an
			// earlier mismatch was already seen, the short read is a
			// consequence of newline drift from that modification, so the
			// original verdict stands.
			if res.Reason == OK {
				res.Reason = Truncated
				res.FirstUntrusted = rec.Offset
			}
			return res, nil
		}
		if err != nil {
			return res, err
		}
		if digest != rec.Digest {
			res.Mismatches++
			if res.Reason == OK {
				res.Reason = Modified
				res.FirstUntrusted = rec.Offset
				// If the stream ends right here, the file was cut short
				// rather than altered -- unless its size still matches
				// the index, in which case the content really changed.
				if eof, terr := atEOF(lr); terr != nil {
					return res, terr
				} else if eof && rec.Offset+uint64(n) < idx.FileSize {
					res.Reason = Truncated
					return res, nil
				}
			}
			if earlyExit {
				return res, nil
			}
			// Keep the stored chain as the reference so one corrupted
			// region does not mask later, independent mismatches.
		} else if res.Reason == OK {
			res.TrustedLines = uint64(i) + 1
		}
		prev = rec.Digest
	}
	// Indexed range fully consumed; anything left is an unindexed tail.
	if res.Reason == OK {
		res.FirstUntrusted = idx.FileSize
		more, err := atEOF(lr)
		if err != nil {
			return res, err
		}
		if !more {
			res.Reason = Appended
		}
	}
	return res, nil
}

// atEOF reports whether the stream has no more bytes. The lookahead byte,
// if any, is pushed back so the stream position is unchanged.
func atEOF(lr *lineReader) (bool, error) {
	_, err := lr.br.ReadByte()
	if err == io.EOF {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return false, lr.br.UnreadByte()
}

// VerifyFile verifies the file at path against idx.
func VerifyFile(path string, idx *Index) (Result, error) {
	f, err := os.Open(path)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()
	return Verify(f, idx)
}

// FullScanFile full-scans the file at path against idx.
func FullScanFile(path string, idx *Index) (Result, error) {
	f, err := os.Open(path)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()
	return FullScan(f, idx)
}

// EqualTrust reports whether two results agree on the trusted prefix, the
// property the incremental/full-scan cross-check asserts.
func EqualTrust(a, b Result) bool {
	return a.Reason == b.Reason &&
		a.TrustedLines == b.TrustedLines &&
		a.FirstUntrusted == b.FirstUntrusted
}

// LineAt returns the raw bytes of line i (0-based) by seeking in f using
// the recorded offset and length. Callers should verify the index first.
func LineAt(f io.ReadSeeker, idx *Index, i uint64) ([]byte, error) {
	if i >= uint64(len(idx.Lines)) {
		return nil, fmt.Errorf("tidx: line %d out of range (%d lines)", i, len(idx.Lines))
	}
	rec := idx.Lines[i]
	if _, err := f.Seek(int64(rec.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, rec.Length)
	if _, err := io.ReadFull(f, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// FormatResult renders a human-readable verification summary. curSize is
// the current file size, or a negative value when unknown.
func FormatResult(res Result, idx *Index, curSize int64) string {
	s := fmt.Sprintf("%s: %s\ntrusted lines: %d\nfirst untrusted offset: %d\n",
		reasonHeadline(res.Reason), reasonDetail(res.Reason), res.TrustedLines, res.FirstUntrusted)
	if res.Reason != OK && curSize >= 0 {
		s += fmt.Sprintf("untrusted interval: [%d, %d)\n", res.FirstUntrusted, untrustedEnd(res, idx, curSize))
	}
	if res.Mismatches > 0 {
		s += fmt.Sprintf("digest mismatches: %d\n", res.Mismatches)
	}
	return s
}

func untrustedEnd(res Result, idx *Index, curSize int64) uint64 {
	if res.Reason == Appended {
		return uint64(curSize)
	}
	return idx.FileSize
}

func reasonHeadline(r Reason) string {
	switch r {
	case OK:
		return "OK"
	case Appended:
		return "APPENDED"
	case Truncated:
		return "TRUNCATED"
	case Modified:
		return "MODIFIED"
	}
	return string(r)
}

func reasonDetail(r Reason) string {
	switch r {
	case OK:
		return "file matches index exactly"
	case Appended:
		return "indexed prefix intact, untrusted tail follows"
	case Truncated:
		return "file ends before the indexed size"
	case Modified:
		return "chain digest mismatch inside the indexed range"
	}
	return ""
}
