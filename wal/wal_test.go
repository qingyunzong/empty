package wal

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func openLog(t *testing.T) (*Log, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "wal.log")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return l, path
}

func TestAppendFlushScanRoundtrip(t *testing.T) {
	l, _ := openLog(t)
	defer l.Close()

	lsn1 := l.Append(&Record{Type: RecUpdate, TxnID: 7, PrevLSN: NullLSN, PageID: 2, Offset: 9,
		Before: []byte("old"), After: []byte("new")})
	lsn2 := l.Append(&Record{Type: RecCLR, TxnID: 7, PrevLSN: lsn1, PageID: 2, Offset: 9,
		After: []byte("old"), UndoNextLSN: NullLSN})
	l.Append(&Record{Type: RecCommit, TxnID: 7, PrevLSN: lsn2})
	if err := l.Flush(); err != nil {
		t.Fatal(err)
	}

	recs, err := l.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 3 {
		t.Fatalf("want 3 records, got %d", len(recs))
	}
	r := recs[0]
	if r.Type != RecUpdate || r.TxnID != 7 || r.PageID != 2 || r.Offset != 9 ||
		!bytes.Equal(r.Before, []byte("old")) || !bytes.Equal(r.After, []byte("new")) ||
		r.PrevLSN != NullLSN || r.LSN != lsn1 {
		t.Fatalf("update record corrupted: %+v", r)
	}
	if recs[1].UndoNextLSN != NullLSN || recs[1].PrevLSN != lsn1 {
		t.Fatalf("clr chain corrupted: %+v", recs[1])
	}
	if recs[2].Type != RecCommit {
		t.Fatalf("commit record corrupted: %+v", recs[2])
	}
}

func TestUnflushedRecordsLostOnCrash(t *testing.T) {
	l, _ := openLog(t)
	defer l.Close()

	l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("a")})
	if err := l.Flush(); err != nil {
		t.Fatal(err)
	}
	l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("b")})
	if err := l.DiscardPending(); err != nil { // simulate crash
		t.Fatal(err)
	}
	recs, err := l.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 || !bytes.Equal(recs[0].After, []byte("a")) {
		t.Fatalf("durable prefix wrong: %+v", recs)
	}
}

func TestTornTailIgnored(t *testing.T) {
	l, path := openLog(t)
	l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("x")})
	l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("y")})
	if err := l.Flush(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Append half a record's worth of garbage, as a crashed write would.
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{1, 2, 3, 4, 5}, info.Size()); err != nil {
		t.Fatal(err)
	}
	f.Close()

	recs, err := l.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 {
		t.Fatalf("torn tail not ignored: %d records", len(recs))
	}
	l.Close()
}

func TestCorruptRecordStopsScan(t *testing.T) {
	l, path := openLog(t)
	l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("x")})
	second := l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("y")})
	l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("z")})
	if err := l.Flush(); err != nil {
		t.Fatal(err)
	}
	l.Close()

	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xFF}, second+10); err != nil { // flip a byte in record 2
		t.Fatal(err)
	}
	f.Close()

	l2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	recs, err := l2.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("scan should stop at corrupt record, got %d", len(recs))
	}
}

func TestReopenContinuesLSN(t *testing.T) {
	l, path := openLog(t)
	last := l.Append(&Record{Type: RecUpdate, TxnID: 1, PageID: 0, After: []byte("x")})
	if err := l.Flush(); err != nil {
		t.Fatal(err)
	}
	l.Close()

	l2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	if got := l2.Append(&Record{Type: RecUpdate, TxnID: 2, PageID: 0, After: []byte("y")}); got <= last {
		t.Fatalf("LSN did not advance after reopen: %d <= %d", got, last)
	}
}
