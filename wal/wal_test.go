package wal_test

import (
	"os"
	"path/filepath"
	"testing"

	"pagedb/wal"
)

func open(t *testing.T, dir string) *wal.Log {
	t.Helper()
	l, err := wal.Open(filepath.Join(dir, "wal.log"))
	if err != nil {
		t.Fatalf("open log: %v", err)
	}
	return l
}

func TestAppendSyncScanRoundtrip(t *testing.T) {
	dir := t.TempDir()
	l := open(t, dir)
	in := []*wal.Record{
		{TxID: 1, Type: wal.RecUpdate, PageID: 7, Before: []byte("before"), After: []byte("after")},
		{TxID: 1, Type: wal.RecCommit},
		{TxID: 1, Type: wal.RecCLR, PageID: 7, After: []byte("restored")},
	}
	var prev uint64
	for _, r := range in {
		r.PrevLSN = prev
		prev = l.Append(r)
	}
	if err := l.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	out, err := wal.Scan(filepath.Join(dir, "wal.log"))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(out) != len(in) {
		t.Fatalf("scanned %d records, want %d", len(out), len(in))
	}
	for i, r := range out {
		if r.LSN != uint64(i+1) {
			t.Errorf("record %d: LSN %d, want %d", i, r.LSN, i+1)
		}
		if r.Type != in[i].Type || r.TxID != in[i].TxID || r.PageID != in[i].PageID {
			t.Errorf("record %d: header mismatch: %+v", i, r)
		}
		if string(r.Before) != string(in[i].Before) || string(r.After) != string(in[i].After) {
			t.Errorf("record %d: images mismatch", i)
		}
	}
	if out[1].PrevLSN != out[0].LSN {
		t.Errorf("prevLSN chain broken: record %d prev=%d, want %d", out[1].LSN, out[1].PrevLSN, out[0].LSN)
	}
}

func TestUnsyncedRecordsAreLost(t *testing.T) {
	dir := t.TempDir()
	l := open(t, dir)
	l.Append(&wal.Record{TxID: 1, Type: wal.RecUpdate, PageID: 0, After: []byte("durable")})
	if err := l.Sync(); err != nil {
		t.Fatal(err)
	}
	l.Append(&wal.Record{TxID: 1, Type: wal.RecUpdate, PageID: 0, After: []byte("volatile")})
	l.Close() // crash: pending record was never synced
	recs, err := wal.Scan(filepath.Join(dir, "wal.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("got %d durable records, want 1 (unsynced tail must be lost)", len(recs))
	}
}

func TestTornTailIsIgnored(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wal.log")
	l := open(t, dir)
	l.Append(&wal.Record{TxID: 1, Type: wal.RecCommit})
	if err := l.Sync(); err != nil {
		t.Fatal(err)
	}
	l.Close()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Full frame header claims a 64-byte body but only 2 bytes follow.
	if _, err := f.Write([]byte{0, 0, 0, 64, 0, 0, 0, 0, 0xde, 0xad}); err != nil {
		t.Fatal(err)
	}
	f.Close()
	recs, err := wal.Scan(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1 (torn tail ignored)", len(recs))
	}
}

func TestLSNContinuesAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	l := open(t, dir)
	l.Append(&wal.Record{TxID: 1, Type: wal.RecUpdate, PageID: 0, After: []byte("x")})
	l.Append(&wal.Record{TxID: 1, Type: wal.RecCommit})
	if err := l.Sync(); err != nil {
		t.Fatal(err)
	}
	l.Close()
	l2 := open(t, dir)
	defer l2.Close()
	rec := &wal.Record{TxID: 2, Type: wal.RecUpdate, PageID: 0, After: []byte("y")}
	if lsn := l2.Append(rec); lsn != 3 {
		t.Fatalf("LSN after reopen = %d, want 3", lsn)
	}
}
