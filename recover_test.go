package auditlog

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// buildLog writes frames to a new temp file and returns its path and bytes.
func buildLog(t *testing.T, frames ...[]byte) (string, []byte) {
	t.Helper()
	var buf []byte
	for i, payload := range frames {
		if payload == nil {
			buf = append(buf, EncodeFrame(uint64(i+1), nil)...)
		} else {
			buf = append(buf, payload...)
		}
	}
	path := filepath.Join(t.TempDir(), "audit.log")
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatal(err)
	}
	return path, buf
}

// frameBoundaries returns the set of valid frame-end offsets in buf.
func frameBoundaries(t *testing.T, buf []byte) map[int64]bool {
	t.Helper()
	entries, validLen, err := Scan(bytes.NewReader(buf), int64(len(buf)))
	if err != nil || validLen != int64(len(buf)) {
		t.Fatalf("scanning original log: validLen=%d err=%v", validLen, err)
	}
	bounds := map[int64]bool{0: true}
	for _, e := range entries {
		bounds[e.Offset+int64(HeaderLen+len(e.Payload)+CRCLen)] = true
	}
	return bounds
}

// Acceptance: truncating the log at EVERY possible byte length must be
// recoverable, and recovery must only ever remove the incomplete tail.
func TestByteByByteTruncation(t *testing.T) {
	payloads := [][]byte{
		EncodeFrame(1, []byte("first entry")),
		EncodeFrame(2, []byte("")),
		EncodeFrame(3, bytes.Repeat([]byte("payload-"), 40)),
		EncodeFrame(4, []byte("last")),
	}
	_, orig := buildLog(t, payloads...)
	bounds := frameBoundaries(t, orig)

	origEntries, _, err := Scan(bytes.NewReader(orig), int64(len(orig)))
	if err != nil {
		t.Fatal(err)
	}

	for cut := 0; cut <= len(orig); cut++ {
		path := filepath.Join(t.TempDir(), "audit.log")
		if err := os.WriteFile(path, orig[:cut], 0o644); err != nil {
			t.Fatal(err)
		}
		truncated, newLen, err := Recover(path)
		if err != nil {
			t.Fatalf("cut=%d: Recover: %v", cut, err)
		}
		if !bounds[newLen] || newLen > int64(cut) {
			t.Fatalf("cut=%d: newLen=%d is not a frame boundary <= cut", cut, newLen)
		}
		if want := newLen != int64(cut); truncated != want {
			t.Fatalf("cut=%d: truncated=%v want %v", cut, truncated, want)
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, orig[:newLen]) {
			t.Fatalf("cut=%d: recovered file is not a prefix of the original", cut)
		}
		// The recovered log must scan cleanly and hold a prefix of entries.
		entries, validLen, err := Scan(bytes.NewReader(got), int64(len(got)))
		if err != nil || validLen != int64(len(got)) {
			t.Fatalf("cut=%d: rescan: validLen=%d err=%v", cut, validLen, err)
		}
		for i, e := range entries {
			if e.Seq != origEntries[i].Seq || !bytes.Equal(e.Payload, origEntries[i].Payload) {
				t.Fatalf("cut=%d: entry %d changed after recovery", cut, i)
			}
		}
	}
}

// Acceptance: flipping ANY single byte must be detected as corruption,
// and recovery must leave the original file byte-for-byte unmodified.
func TestSingleByteCorruption(t *testing.T) {
	payloads := [][]byte{
		EncodeFrame(1, []byte("first entry")),
		EncodeFrame(2, []byte("middle")),
		EncodeFrame(3, []byte("last entry")),
	}
	_, orig := buildLog(t, payloads...)

	for pos := 0; pos < len(orig); pos++ {
		for _, mask := range []byte{0x01, 0x80, 0xFF} {
			corrupt := append([]byte(nil), orig...)
			corrupt[pos] ^= mask
			if bytes.Equal(corrupt, orig) {
				continue
			}
			path := filepath.Join(t.TempDir(), "audit.log")
			if err := os.WriteFile(path, corrupt, 0o644); err != nil {
				t.Fatal(err)
			}
			_, _, err := Recover(path)
			if err == nil {
				t.Fatalf("pos=%d mask=%#02x: corruption not detected", pos, mask)
			}
			if !IsCorrupt(err) {
				t.Fatalf("pos=%d mask=%#02x: error %v is not a CorruptError", pos, mask, err)
			}
			got, rerr := os.ReadFile(path)
			if rerr != nil {
				t.Fatal(rerr)
			}
			if !bytes.Equal(got, corrupt) {
				t.Fatalf("pos=%d mask=%#02x: Recover modified a corrupt file", pos, mask)
			}
		}
	}
}

// Mid-log corruption specifically: verify fails, recover is a no-op.
func TestMidLogCorruptionNeverModified(t *testing.T) {
	payloads := [][]byte{
		EncodeFrame(1, []byte("aaa")),
		EncodeFrame(2, []byte("bbb")),
		EncodeFrame(3, []byte("ccc")),
	}
	path, orig := buildLog(t, payloads...)
	corrupt := append([]byte(nil), orig...)
	corrupt[HeaderLen+1] ^= 0x40 // payload byte of the first frame
	if err := os.WriteFile(path, corrupt, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Verify(path); !IsCorrupt(err) {
		t.Fatalf("Verify err=%v, want CorruptError", err)
	}
	truncated, _, err := Recover(path)
	if !IsCorrupt(err) || truncated {
		t.Fatalf("Recover = truncated=%v err=%v, want CorruptError and no truncation", truncated, err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, corrupt) {
		t.Fatal("file modified despite mid-log corruption")
	}
}

func TestRecoverCleanLogIsNoOp(t *testing.T) {
	path, orig := buildLog(t, EncodeFrame(7, []byte("x")), EncodeFrame(8, []byte("y")))
	truncated, newLen, err := Recover(path)
	if err != nil || truncated || newLen != int64(len(orig)) {
		t.Fatalf("Recover = %v, %d, %v", truncated, newLen, err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, orig) {
		t.Fatal("clean log modified")
	}
}

func TestRecoverMissingFile(t *testing.T) {
	truncated, newLen, err := Recover(filepath.Join(t.TempDir(), "nope.log"))
	if err != nil || truncated || newLen != 0 {
		t.Fatalf("Recover(missing) = %v, %d, %v", truncated, newLen, err)
	}
}
