package fileadapter

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestWriteReadRoundtrip(t *testing.T) {
	a, err := Open(filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	page := bytes.Repeat([]byte{0x5A}, PageSize)
	if err := a.WritePage(3, page); err != nil {
		t.Fatal(err)
	}
	if err := a.Sync(); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, PageSize)
	if err := a.ReadPage(3, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, page) {
		t.Fatal("page mismatch")
	}
}

func TestUnwrittenPageReadsZeros(t *testing.T) {
	a, err := Open(filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	got := make([]byte, PageSize)
	if err := a.ReadPage(17, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, make([]byte, PageSize)) {
		t.Fatal("expected zero page")
	}
}
