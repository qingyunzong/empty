package auditlog

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLogAppendVerifyAndSecretNotPersisted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	secret := "s3cr3t-token-9f8e7d"
	payloads := [][]byte{
		[]byte("op=login token=" + secret + " ok"),
		[]byte("op=logout user=alice"),
	}
	if _, err := l.Append(payloads[0], []Range{{15, 15 + len(secret)}}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, err := l.Append(payloads[1], nil); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := l.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// The original secret must never appear in the on-disk output.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if bytes.Contains(raw, []byte(secret)) {
		t.Fatal("log file contains the original secret")
	}

	// Reopen and replay the chain from disk.
	l2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer l2.Close()
	if err := l2.Verify(); err != nil {
		t.Fatalf("Verify after reopen: %v", err)
	}
	recs := l2.Records()
	if len(recs) != 2 {
		t.Fatalf("expected 2 records, got %d", len(recs))
	}
	if err := VerifyRecordAgainstOriginal(&recs[0], payloads[0]); err != nil {
		t.Fatalf("record 0 vs original: %v", err)
	}
	if err := VerifyRecordAgainstOriginal(&recs[1], payloads[1]); err != nil {
		t.Fatalf("record 1 vs original: %v", err)
	}
}

func TestPowerLossRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := l.Append([]byte("committed record"), nil); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Simulate a crash mid-write: a torn frame appended without sync.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	if _, err := f.Write([]byte{0, 0, 0, 40, 1, 2, 3}); err != nil { // partial frame
		t.Fatalf("Write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	l2, err := Open(path)
	if err != nil {
		t.Fatalf("Open after crash: %v", err)
	}
	defer l2.Close()
	recs := l2.Records()
	if len(recs) != 1 {
		t.Fatalf("expected 1 committed record after recovery, got %d", len(recs))
	}
	if err := l2.Verify(); err != nil {
		t.Fatalf("Verify after recovery: %v", err)
	}
	// The torn tail must be truncated: file size matches exactly one frame.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if want := int64(len(encodeRecord(&recs[0])) + lenPrefixSize + checksumSize); info.Size() != want {
		t.Fatalf("file size %d, want %d (torn tail not truncated)", info.Size(), want)
	}
	// The log must accept new records after recovery and keep the chain intact.
	if _, err := l2.Append([]byte("post-crash record"), nil); err != nil {
		t.Fatalf("Append after recovery: %v", err)
	}
	if err := l2.Verify(); err != nil {
		t.Fatalf("Verify after post-crash append: %v", err)
	}
	if got := len(l2.Records()); got != 2 {
		t.Fatalf("expected 2 records, got %d", got)
	}
}

func TestCorruptChecksumRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := l.Append([]byte("good record"), nil); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Append a full-length frame with a bad checksum (torn body write).
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	body := encodeRecord(NewRecord(1, [32]byte{}, Digest([]byte("x")), []byte("x"), nil))
	if _, err := f.Write(body[:len(body)-1]); err != nil { // corrupt the frame
		t.Fatalf("Write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	l2, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer l2.Close()
	if got := len(l2.Records()); got != 1 {
		t.Fatalf("expected 1 record after discarding corrupt frame, got %d", got)
	}
	if err := l2.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestAppendRejectsInvalidRange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer l.Close()
	if _, err := l.Append([]byte("short"), []Range{{0, 100}}); err == nil {
		t.Fatal("Append accepted an out-of-bounds range")
	}
	if _, err := l.Append([]byte("short"), []Range{{4, 2}}); err == nil {
		t.Fatal("Append accepted an inverted range")
	}
	if got := len(l.Records()); got != 0 {
		t.Fatalf("rejected appends must not commit records, got %d", got)
	}
}
