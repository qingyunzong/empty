package cowpage

import (
	"bytes"
	"testing"
)

func mustRead(t *testing.T, s *Store, b BranchID, page int) []byte {
	t.Helper()
	data, err := s.Read(b, page)
	if err != nil {
		t.Fatalf("Read(%d, %d): %v", b, page, err)
	}
	return data
}

func TestForkIsolation(t *testing.T) {
	s := New(4, 16)
	a := s.Create()
	if err := s.Write(a, 1, 0, []byte("aaaaaaaaaaaaaaaa")); err != nil {
		t.Fatal(err)
	}
	b, err := s.Fork(a)
	if err != nil {
		t.Fatal(err)
	}
	// Both views see the same content right after the fork.
	if got := mustRead(t, s, b, 1); !bytes.Equal(got, []byte("aaaaaaaaaaaaaaaa")) {
		t.Fatalf("fork view = %q", got)
	}
	// Writing through one branch must not leak into the other.
	if err := s.Write(a, 1, 0, []byte("AAAA")); err != nil {
		t.Fatal(err)
	}
	if err := s.Write(b, 1, 4, []byte("BBBB")); err != nil {
		t.Fatal(err)
	}
	if got, want := mustRead(t, s, a, 1), []byte("AAAAaaaaaaaaaaaa"); !bytes.Equal(got, want) {
		t.Fatalf("branch a = %q, want %q", got, want)
	}
	if got, want := mustRead(t, s, b, 1), []byte("aaaaBBBBaaaaaaaa"); !bytes.Equal(got, want) {
		t.Fatalf("branch b = %q, want %q", got, want)
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestRefCountReturnedOnDelete(t *testing.T) {
	s := New(2, 8)
	a := s.Create()
	b, err := s.Fork(a)
	if err != nil {
		t.Fatal(err)
	}
	// a and b share only the zero page: 1 (store) + 4 table entries.
	if refs, _ := s.RefCount(s.zeroPage); refs != 5 {
		t.Fatalf("zero page refs = %d, want 5", refs)
	}
	if err := s.Delete(b); err != nil {
		t.Fatal(err)
	}
	if refs, _ := s.RefCount(s.zeroPage); refs != 3 {
		t.Fatalf("zero page refs after delete = %d, want 3", refs)
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestOldViewKeepsPagesAlive(t *testing.T) {
	s := New(2, 8)
	a := s.Create()
	if err := s.Write(a, 0, 0, []byte("payload!")); err != nil {
		t.Fatal(err)
	}
	b, err := s.Fork(a)
	if err != nil {
		t.Fatal(err)
	}
	pagesBefore := s.LivePages()
	// Delete the branch that wrote the data; the forked view must keep the
	// physical page alive and readable.
	if err := s.Delete(a); err != nil {
		t.Fatal(err)
	}
	if got := s.LivePages(); got != pagesBefore {
		t.Fatalf("LivePages = %d after deleting writer, want %d", got, pagesBefore)
	}
	if got := mustRead(t, s, b, 0); !bytes.Equal(got, []byte("payload!")) {
		t.Fatalf("surviving view = %q", got)
	}
	if err := s.Delete(b); err != nil {
		t.Fatal(err)
	}
	if got := s.LivePages(); got != 1 {
		t.Fatalf("LivePages = %d after deleting all branches, want 1 (zero page)", got)
	}
	s.Close()
	if got := s.LivePages(); got != 0 {
		t.Fatalf("LivePages = %d after Close, want 0", got)
	}
}

func TestWritePrivatePageInPlace(t *testing.T) {
	s := New(1, 8)
	a := s.Create()
	if err := s.Write(a, 0, 0, []byte("xy")); err != nil {
		t.Fatal(err)
	}
	before := s.LivePages()
	// Sole owner: second write must not allocate a new page.
	if err := s.Write(a, 0, 2, []byte("zz")); err != nil {
		t.Fatal(err)
	}
	if got := s.LivePages(); got != before {
		t.Fatalf("LivePages = %d, want %d (in-place write)", got, before)
	}
	if got := mustRead(t, s, a, 0); !bytes.Equal(got, []byte("xyzz\x00\x00\x00\x00")) {
		t.Fatalf("page = %q", got)
	}
}

func TestErrors(t *testing.T) {
	s := New(1, 4)
	a := s.Create()
	if _, err := s.Fork(999); err == nil {
		t.Fatal("Fork of unknown branch: want error")
	}
	if err := s.Delete(999); err == nil {
		t.Fatal("Delete of unknown branch: want error")
	}
	if err := s.Write(a, 5, 0, []byte("x")); err == nil {
		t.Fatal("Write out-of-range page: want error")
	}
	if err := s.Write(a, 0, 3, []byte("xx")); err == nil {
		t.Fatal("Write past page end: want error")
	}
	if _, err := s.Read(a, -1); err == nil {
		t.Fatal("Read negative page: want error")
	}
	if err := s.Delete(a); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(a); err == nil {
		t.Fatal("double Delete: want error")
	}
}
