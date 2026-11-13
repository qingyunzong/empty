package appendlog

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMemLogAtomicBatchAndDefensiveCopy(t *testing.T) {
	log := NewMemLog()

	if err := log.Append([]Entry{{Data: []byte("a")}, {Data: []byte("b")}}); err != nil {
		t.Fatal(err)
	}
	records, err := log.Read()
	if err != nil || len(records) != 2 {
		t.Fatalf("Read = (%v, %v)", records, err)
	}

	// Mutating the input after Append must not corrupt stored data.
	payload := []byte("original")
	if err := log.Append([]Entry{{Data: payload}}); err != nil {
		t.Fatal(err)
	}
	payload[0] = 'X'
	records, _ = log.Read()
	if got := string(records[2]); got != "original" {
		t.Fatalf("stored record = %q, want original", got)
	}

	// An invalid entry rejects the whole batch.
	before := len(records)
	if err := log.Append([]Entry{{Data: []byte("ok")}, {Data: nil}}); err == nil {
		t.Fatal("expected error for empty entry")
	}
	records, _ = log.Read()
	if len(records) != before {
		t.Fatalf("rejected batch changed log: %d -> %d", before, len(records))
	}

	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if err := log.Append([]Entry{{Data: []byte("z")}}); err == nil {
		t.Fatal("append after closed log must fail")
	}
}

func TestFileLogRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.bin")
	log, err := NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Append([]Entry{{Data: []byte("hello")}, {Data: []byte("world")}}); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	records, err := reopened.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || string(records[0]) != "hello" || string(records[1]) != "world" {
		t.Fatalf("records = %v", records)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNewFileLogCreatesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.bin")
	log, err := NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	records, err := log.Read()
	if err != nil || len(records) != 0 {
		t.Fatalf("fresh log Read = (%v, %v)", records, err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not created: %v", err)
	}
}
