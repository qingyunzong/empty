package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

var testPayloads = []string{"alpha", "", "gamma-3", "delta delta delta", "e"}

// buildLog returns the concatenation of encoded frames with seq 1..n.
func buildLog(payloads []string) []byte {
	var full []byte
	for i, p := range payloads {
		full = append(full, encodeFrame(uint64(i+1), []byte(p))...)
	}
	return full
}

func frameBoundaries(payloads []string) []int64 {
	bounds := []int64{0}
	off := int64(0)
	for _, p := range payloads {
		off += int64(headerSize + len(p) + trailerSize)
		bounds = append(bounds, off)
	}
	return bounds
}

func writeTempLog(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "audit.log")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFrameRoundTrip(t *testing.T) {
	full := buildLog(testPayloads)
	frames, goodEnd, err := scanFrames(bytes.NewReader(full))
	if err != nil {
		t.Fatal(err)
	}
	if goodEnd != int64(len(full)) {
		t.Fatalf("goodEnd=%d want %d", goodEnd, len(full))
	}
	if len(frames) != len(testPayloads) {
		t.Fatalf("frames=%d want %d", len(frames), len(testPayloads))
	}
	for i, fr := range frames {
		if fr.Seq != uint64(i+1) || string(fr.Payload) != testPayloads[i] {
			t.Fatalf("frame %d: seq=%d payload=%q", i, fr.Seq, fr.Payload)
		}
	}
}

// Acceptance: truncate the log at every possible byte offset; recovery must
// succeed and leave exactly the valid frame prefix.
func TestRecoverByteByByteTruncation(t *testing.T) {
	full := buildLog(testPayloads)
	bounds := frameBoundaries(testPayloads)
	for cut := 0; cut <= len(full); cut++ {
		path := writeTempLog(t, full[:cut])
		removed, err := recoverLog(path)
		if err != nil {
			t.Fatalf("cut=%d: recoverLog: %v", cut, err)
		}
		want := int64(0)
		for _, b := range bounds {
			if b <= int64(cut) {
				want = b
			}
		}
		if removed != int64(cut)-want {
			t.Fatalf("cut=%d: removed=%d want %d", cut, removed, int64(cut)-want)
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, full[:want]) {
			t.Fatalf("cut=%d: recovered file is not the valid frame prefix", cut)
		}
	}
}

// Acceptance: flip every single byte; recovery must report corruption and
// must not modify the original file.
func TestRecoverSingleByteCorruption(t *testing.T) {
	full := buildLog(testPayloads)
	for i := 0; i < len(full); i++ {
		corrupted := make([]byte, len(full))
		copy(corrupted, full)
		corrupted[i] ^= 0xFF
		path := writeTempLog(t, corrupted)
		if _, err := recoverLog(path); err == nil {
			t.Fatalf("byte %d: expected corruption error, got nil", i)
		}
		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(after, corrupted) {
			t.Fatalf("byte %d: original file was modified during recovery", i)
		}
	}
}

func TestRecoverCleanLogUnchanged(t *testing.T) {
	full := buildLog(testPayloads)
	path := writeTempLog(t, full)
	removed, err := recoverLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("removed=%d want 0", removed)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, full) {
		t.Fatal("clean log was modified")
	}
}

func TestReindexDetectsDuplicateSeq(t *testing.T) {
	diff := []Frame{
		{Offset: 0, Seq: 7, Payload: []byte("one")},
		{Offset: 19, Seq: 7, Payload: []byte("two")},
	}
	if _, err := buildIndex(diff); err == nil {
		t.Fatal("expected error for duplicate seq with different content")
	}
	same := []Frame{
		{Offset: 0, Seq: 7, Payload: []byte("one")},
		{Offset: 19, Seq: 7, Payload: []byte("one")},
	}
	idx, err := buildIndex(same)
	if err != nil {
		t.Fatalf("identical duplicate seq must be tolerated: %v", err)
	}
	if len(idx) != 1 || idx[7].Offset != 0 {
		t.Fatalf("idx=%v", idx)
	}
}

// The index may lag the log; rebuilding must pick up frames appended after
// the last index write.
func TestIndexLagAndRebuild(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit.log")
	idxPath := filepath.Join(dir, "audit.log.idx")

	for _, p := range []string{"a", "bb"} {
		if _, err := appendFrame(logPath, 0, true, []byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	rebuild := func() map[uint64]indexEntry {
		f, err := os.Open(logPath)
		if err != nil {
			t.Fatal(err)
		}
		frames, _, err := scanFrames(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		idx, err := buildIndex(frames)
		if err != nil {
			t.Fatal(err)
		}
		if err := writeIndex(idxPath, idx); err != nil {
			t.Fatal(err)
		}
		return idx
	}
	idx := rebuild()
	if len(idx) != 2 {
		t.Fatalf("entries=%d want 2", len(idx))
	}

	// Log advances while the index stays stale.
	for _, p := range []string{"ccc", "dddd"} {
		if _, err := appendFrame(logPath, 0, true, []byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	stale, err := readIndex(idxPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(stale) != 2 {
		t.Fatalf("stale index entries=%d want 2 (index may lag the log)", len(stale))
	}

	idx = rebuild()
	if len(idx) != 4 {
		t.Fatalf("rebuilt entries=%d want 4", len(idx))
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for seq, e := range idx {
		if seq < 1 || seq > 4 {
			t.Fatalf("unexpected seq %d", seq)
		}
		end := e.Offset + headerSize + int64(e.Length)
		want := map[uint64]string{1: "a", 2: "bb", 3: "ccc", 4: "dddd"}
		if got := string(logData[e.Offset+headerSize : end]); got != want[seq] {
			t.Fatalf("seq %d: payload=%q want %q", seq, got, want[seq])
		}
	}
}

func TestAppendAutoSeqAndDuplicateReject(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit.log")
	for want := uint64(1); want <= 3; want++ {
		got, err := appendFrame(logPath, 0, true, []byte("x"))
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("seq=%d want %d", got, want)
		}
	}
	if _, err := appendFrame(logPath, 2, false, []byte("dup")); err == nil {
		t.Fatal("expected duplicate seq rejection")
	}
	if _, err := appendFrame(logPath, 9, false, []byte("ok")); err != nil {
		t.Fatalf("explicit new seq: %v", err)
	}
	res, err := verifyLog(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if res.Frames != 4 || res.TailBytes != 0 {
		t.Fatalf("verify=%+v", res)
	}
}

func TestAppendRefusesCorruptLog(t *testing.T) {
	full := buildLog(testPayloads)
	full[len(full)-1] ^= 0xFF // corrupt last CRC byte
	path := writeTempLog(t, full)
	if _, err := appendFrame(path, 0, true, []byte("x")); err == nil {
		t.Fatal("expected refusal to append to corrupt log")
	}
}

func TestCLIEndToEnd(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit.log")
	idxPath := filepath.Join(dir, "audit.log.idx")

	for _, p := range []string{"first", "second"} {
		if err := run([]string{"append", "-log", logPath, p}); err != nil {
			t.Fatal(err)
		}
	}
	if err := run([]string{"verify", "-log", logPath}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"reindex", "-log", logPath, "-index", idxPath}); err != nil {
		t.Fatal(err)
	}
	idx, err := readIndex(idxPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(idx) != 2 {
		t.Fatalf("entries=%d want 2", len(idx))
	}
	if err := run([]string{"list", "-log", logPath}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"recover", "-log", logPath}); err != nil {
		t.Fatal(err)
	}

	// Torn tail: verify fails, recover fixes, verify passes.
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0, 0, 0, 5, 0}); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := run([]string{"verify", "-log", logPath}); err == nil {
		t.Fatal("verify should fail on incomplete tail")
	}
	if err := run([]string{"recover", "-log", logPath}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"verify", "-log", logPath}); err != nil {
		t.Fatal(err)
	}
}
