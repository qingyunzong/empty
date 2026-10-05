package merklefs

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func paths(m *Manifest) []string {
	out := make([]string, len(m.Entries))
	for i, e := range m.Entries {
		out[i] = e.Path
	}
	return out
}

func TestWalkMapFS(t *testing.T) {
	fsys := fstest.MapFS{
		"b.txt":       &fstest.MapFile{Data: []byte("bravo")},
		"a.txt":       &fstest.MapFile{Data: []byte("alpha")},
		"sub/c.txt":   &fstest.MapFile{Data: []byte("charlie")},
		"link":        &fstest.MapFile{Mode: fs.ModeSymlink, Data: []byte("a.txt")},
		"dirlink":     &fstest.MapFile{Mode: fs.ModeSymlink, Data: []byte("sub")},
		"sub/inner/d": &fstest.MapFile{Data: []byte("delta")},
	}
	m, err := Walk(fsys, ".")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{"a.txt", "b.txt", "dirlink", "link", "sub", "sub/c.txt", "sub/inner", "sub/inner/d"}
	got := paths(m)
	if len(got) != len(want) {
		t.Fatalf("paths = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("paths = %v, want %v", got, want)
		}
	}
	// Symlink recorded, not followed.
	e, ok := m.Find("link")
	if !ok || e.Type != TypeSymlink || e.Target != "a.txt" {
		t.Fatalf("link entry = %+v, ok=%v", e, ok)
	}
	if _, ok := m.Find("dirlink/c.txt"); ok {
		t.Fatal("dir symlink was followed")
	}
	// File content hashed.
	a, _ := m.Find("a.txt")
	if a.Type != TypeFile || a.Size != 5 || a.Hash == ([32]byte{}) {
		t.Fatalf("a.txt entry = %+v", a)
	}
}

func TestUTF8Order(t *testing.T) {
	// Byte-wise UTF-8 order: 'z'(0x7A) < 'ä'(U+00E4, 0xC3 0xA4) < '中'(U+4E2D).
	fsys := fstest.MapFS{
		"中.txt": &fstest.MapFile{Data: []byte("1")},
		"ä.txt": &fstest.MapFile{Data: []byte("2")},
		"z.txt": &fstest.MapFile{Data: []byte("3")},
	}
	m, err := Walk(fsys, ".")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	got := paths(m)
	want := []string{"z.txt", "ä.txt", "中.txt"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestInvalidUTF8Rejected(t *testing.T) {
	// 0xC0 0xAF is an overlong (non-canonical) encoding of '/'.
	bad := "bad" + string([]byte{0xC0, 0xAF}) + ".txt"
	fsys := fstest.MapFS{bad: &fstest.MapFile{Data: []byte("x")}}
	if _, err := Walk(fsys, "."); err == nil {
		t.Fatal("expected error for non-canonical UTF-8 path")
	}
}

func TestCanonicalize(t *testing.T) {
	bad := []string{"", "/abs", "a//b", "a/./b", "a/../b", "..", "a\\b", string([]byte{0xFF})}
	for _, p := range bad {
		if _, err := Canonicalize(p); err == nil {
			t.Errorf("Canonicalize(%q) succeeded, want error", p)
		}
	}
	if got, err := Canonicalize("a/b/c.txt"); err != nil || got != "a/b/c.txt" {
		t.Errorf("Canonicalize valid = %q, %v", got, err)
	}
}

func TestHardLinksSameObject(t *testing.T) {
	dir := t.TempDir()
	content := []byte("shared content")
	if err := os.WriteFile(filepath.Join(dir, "orig.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "orig.txt"), filepath.Join(dir, "hard.txt")); err != nil {
		t.Skipf("hard links unsupported: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := Walk(os.DirFS(dir), ".")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	orig, _ := m.Find("orig.txt")
	hard, _ := m.Find("hard.txt")
	other, _ := m.Find("other.txt")
	if orig.ObjID != hard.ObjID {
		t.Error("hard-linked files have different ObjIDs")
	}
	if orig.Hash != hard.Hash {
		t.Error("hard-linked files have different hashes")
	}
	if orig.ObjID == other.ObjID {
		t.Error("distinct files with equal content share an ObjID")
	}
	if orig.Hash != other.Hash {
		t.Error("files with equal content must hash equally")
	}
}

func TestSymlinkNotFollowedOnDisk(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "real.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "realdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "realdir", "inner.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("realdir", filepath.Join(dir, "dirlink")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if err := os.Symlink("real.txt", filepath.Join(dir, "filelink")); err != nil {
		t.Fatal(err)
	}
	m, err := Walk(os.DirFS(dir), ".")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	e, ok := m.Find("dirlink")
	if !ok || e.Type != TypeSymlink || e.Target != "realdir" {
		t.Fatalf("dirlink = %+v, ok=%v", e, ok)
	}
	if _, ok := m.Find("dirlink/inner.txt"); ok {
		t.Fatal("directory symlink was followed")
	}
	f, ok := m.Find("filelink")
	if !ok || f.Type != TypeSymlink || f.Target != "real.txt" {
		t.Fatalf("filelink = %+v, ok=%v", f, ok)
	}
}

func TestWalkSubroot(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "top", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "top", "sub", "f.txt"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := Walk(os.DirFS(dir), "top")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	got := paths(m)
	want := []string{"sub", "sub/f.txt"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("paths = %v, want %v", got, want)
	}
}
