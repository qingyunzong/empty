package db_test

import (
	"path/filepath"
	"testing"

	"pagedb/db"
	"pagedb/pagestore"
	"pagedb/wal"
)

type fixture struct {
	dir string
	lg  *wal.Log
	ad  *pagestore.FileAdapter
	st  *pagestore.Store
	m   *db.Manager
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
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
	return &fixture{dir: dir, lg: lg, ad: ad, st: st, m: db.NewManager(lg, st)}
}

func (f *fixture) shutdown(t *testing.T) {
	t.Helper()
	if err := f.lg.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.ad.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCommitThenReadBack(t *testing.T) {
	f := newFixture(t)
	defer f.shutdown(t)
	tx := f.m.Begin()
	if err := tx.Write(0, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := f.st.FlushAll(); err != nil {
		t.Fatal(err)
	}
	lsn, got, err := f.ad.ReadPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if lsn == 0 || string(got[:5]) != "hello" {
		t.Fatalf("got lsn=%d data=%q, want committed write", lsn, got[:5])
	}
}

func TestAbortRestoresBeforeImage(t *testing.T) {
	f := newFixture(t)
	defer f.shutdown(t)
	t1 := f.m.Begin()
	if err := t1.Write(0, []byte("committed")); err != nil {
		t.Fatal(err)
	}
	if err := t1.Commit(); err != nil {
		t.Fatal(err)
	}
	t2 := f.m.Begin()
	if err := t2.Write(0, []byte("doomed")); err != nil {
		t.Fatal(err)
	}
	if err := t2.Abort(); err != nil {
		t.Fatal(err)
	}
	p, err := f.st.Fetch(0)
	if err != nil {
		t.Fatal(err)
	}
	if string(p.Data[:9]) != "committed" {
		t.Fatalf("abort did not restore before-image: %q", p.Data[:9])
	}
	// The undo must be logged as a CLR so recovery can replay or skip it.
	recs, err := wal.Scan(filepath.Join(f.dir, "wal.log"))
	if err != nil {
		t.Fatal(err)
	}
	var clr *wal.Record
	for _, r := range recs {
		if r.Type == wal.RecCLR {
			clr = r
		}
	}
	if clr == nil {
		t.Fatal("abort wrote no CLR")
	}
	if string(clr.After[:9]) != "committed" {
		t.Fatalf("CLR after-image = %q, want before-image of the undone write", clr.After[:9])
	}
}
