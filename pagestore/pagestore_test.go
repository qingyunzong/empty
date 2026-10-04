package pagestore_test

import (
	"bytes"
	"path/filepath"
	"testing"

	"pagedb/pagestore"
	"pagedb/wal"
)

func TestPageRoundtrip(t *testing.T) {
	dir := t.TempDir()
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Close()
	data := bytes.Repeat([]byte("ab"), pagestore.PageSize/2)
	if err := ad.WritePage(3, 42, data); err != nil {
		t.Fatal(err)
	}
	lsn, got, err := ad.ReadPage(3)
	if err != nil {
		t.Fatal(err)
	}
	if lsn != 42 || !bytes.Equal(got, data) {
		t.Fatalf("roundtrip mismatch: lsn=%d", lsn)
	}
}

func TestMissingPageReadsAsZero(t *testing.T) {
	dir := t.TempDir()
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Close()
	lsn, got, err := ad.ReadPage(9)
	if err != nil {
		t.Fatal(err)
	}
	if lsn != 0 || !bytes.Equal(got, make([]byte, pagestore.PageSize)) {
		t.Fatalf("missing page: lsn=%d, want zero page with lsn 0", lsn)
	}
}

// TestStealFlushWritesUncommittedPage verifies the two steal/no-force
// guarantees of the store: a dirty page is written back without any
// commit, and the WAL rule (log before page) is enforced while doing so.
func TestStealFlushWritesUncommittedPage(t *testing.T) {
	dir := t.TempDir()
	lg, err := wal.Open(filepath.Join(dir, "wal.log"))
	if err != nil {
		t.Fatal(err)
	}
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		t.Fatal(err)
	}
	st := pagestore.NewStore(ad, lg)
	rec := &wal.Record{TxID: 1, Type: wal.RecUpdate, PageID: 0, After: []byte("dirty")}
	lsn := lg.Append(rec) // appended but NOT synced
	p, err := st.Fetch(0)
	if err != nil {
		t.Fatal(err)
	}
	copy(p.Data, "dirty")
	p.LSN = lsn
	p.Dirty = true
	if err := st.Flush(0); err != nil { // steal: nothing ever committed
		t.Fatal(err)
	}
	// WAL rule: the log record must be durable before the page is.
	recs, err := wal.Scan(filepath.Join(dir, "wal.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("WAL rule violated: %d durable records, want 1", len(recs))
	}
	// The page is on disk even though its transaction never committed.
	diskLSN, disk, err := ad.ReadPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if diskLSN != lsn || string(disk[:5]) != "dirty" {
		t.Fatalf("stolen page mismatch: lsn=%d data=%q", diskLSN, disk[:5])
	}
	lg.Close()
	ad.Close()
}
