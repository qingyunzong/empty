package manifest

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func entryPaths(m *Manifest) []string {
	var out []string
	for _, e := range m.Entries() {
		out = append(out, e.Path)
	}
	return out
}

func findEntry(t *testing.T, m *Manifest, path string) Entry {
	t.Helper()
	for _, e := range m.Entries() {
		if e.Path == path {
			return e
		}
	}
	t.Fatalf("entry %q not found", path)
	return Entry{}
}

func TestBuildSortsUTF8ByteOrder(t *testing.T) {
	root := t.TempDir()
	// UTF-8 byte order: 'a'(0x61) < 'z'(0x7A) < 'é'(0xC3..) < '中'(0xE4..)
	for _, name := range []string{"中.txt", "é.txt", "z.txt", "a.txt"} {
		writeFile(t, filepath.Join(root, name), name)
	}
	writeFile(t, filepath.Join(root, "dir", "inner.txt"), "x")
	m, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	got := entryPaths(m)
	if !sort.StringsAreSorted(got) {
		t.Fatalf("entries not in UTF-8 byte order: %v", got)
	}
	want := []string{"a.txt", "dir", "dir/inner.txt", "z.txt", "é.txt", "中.txt"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestInvalidUTF8PathRejected(t *testing.T) {
	root := t.TempDir()
	bad := filepath.Join(root, string([]byte{'b', 0xff, 0xfe}))
	if err := os.WriteFile(bad, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Build(root); err == nil {
		t.Fatal("expected error for invalid UTF-8 path")
	}
}

func TestSymlinksNotFollowed(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.txt"), "TOP-SECRET")
	writeFile(t, filepath.Join(root, "real.txt"), "hello")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link-out")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.txt", filepath.Join(root, "link-rel")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("no-such-target", filepath.Join(root, "dangling")); err != nil {
		t.Fatal(err)
	}
	m, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"link-out", "link-rel", "dangling"} {
		e := findEntry(t, m, p)
		if e.Type != TypeSymlink {
			t.Fatalf("%s: type = %v, want symlink", p, e.Type)
		}
	}
	// The symlink digest commits to the target text, not target content.
	e := findEntry(t, m, "link-out")
	want := sha256.Sum256([]byte(filepath.Join(outside, "secret.txt")))
	if e.Digest != want {
		t.Fatal("symlink digest must hash the target path text")
	}
	// The outside file's content must not appear anywhere in the manifest.
	secret := sha256.Sum256([]byte("TOP-SECRET"))
	for _, ent := range m.Entries() {
		if ent.Type == TypeFile && ent.Digest == secret {
			t.Fatal("symlink was followed: outside content leaked into manifest")
		}
	}
}

func TestHardLinksShareObject(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.bin"), "shared-content")
	if err := os.Link(filepath.Join(root, "a.bin"), filepath.Join(root, "b.bin")); err != nil {
		t.Skipf("hard links unsupported: %v", err)
	}
	writeFile(t, filepath.Join(root, "c.bin"), "shared-content") // same content, distinct inode
	m, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	a := findEntry(t, m, "a.bin")
	b := findEntry(t, m, "b.bin")
	if a.Object == "" || a.Object != b.Object {
		t.Fatalf("hard links must share one object: %q vs %q", a.Object, b.Object)
	}
	if a.Digest != b.Digest {
		t.Fatal("hard links must share the content digest")
	}
	// Object ids are content-addressed, so identical content dedupes too.
	c := findEntry(t, m, "c.bin")
	if c.Object != a.Object {
		t.Fatal("identical content should map to the same object id")
	}
	wantObj := hex.EncodeToString(a.Digest[:])
	if a.Object != wantObj {
		t.Fatalf("object id = %q, want hex of digest %q", a.Object, wantObj)
	}
}

func TestIncrementalMatchesFullRebuild(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "keep.txt"), "keep")
	writeFile(t, filepath.Join(root, "modify.txt"), "v1")
	writeFile(t, filepath.Join(root, "delete.txt"), "gone")
	writeFile(t, filepath.Join(root, "sub", "nested.txt"), "nested")
	if err := os.Symlink("keep.txt", filepath.Join(root, "oldlink")); err != nil {
		t.Fatal(err)
	}

	m, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	baseRoot := m.Root()

	// Mutate the filesystem.
	writeFile(t, filepath.Join(root, "modify.txt"), "v2")
	writeFile(t, filepath.Join(root, "added.txt"), "brand new")
	writeFile(t, filepath.Join(root, "sub", "deep", "new.txt"), "deep")
	if err := os.Remove(filepath.Join(root, "delete.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("added.txt", filepath.Join(root, "newlink")); err != nil {
		t.Fatal(err)
	}

	// Incremental update of the in-memory manifest.
	err = m.Apply(
		Change{Path: "modify.txt", Type: TypeFile, Mode: 0o644, Content: []byte("v2")},
		Change{Path: "added.txt", Type: TypeFile, Mode: 0o644, Content: []byte("brand new")},
		Change{Path: "sub/deep", Type: TypeDir, Mode: 0o755},
		Change{Path: "sub/deep/new.txt", Type: TypeFile, Mode: 0o644, Content: []byte("deep")},
		Change{Remove: true, Path: "delete.txt"},
		Change{Path: "newlink", Type: TypeSymlink, Mode: 0o777, Target: "added.txt"},
	)
	if err != nil {
		t.Fatal(err)
	}

	// Full rebuild from disk.
	rebuilt, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	if m.Root() == baseRoot {
		t.Fatal("root did not change after incremental update")
	}
	if m.Root() != rebuilt.Root() {
		t.Fatalf("incremental root %x != full rebuild root %x", m.Root(), rebuilt.Root())
	}
	if !m.Equal(rebuilt) {
		t.Fatal("incremental entries diverge from full rebuild")
	}
}

func TestRemoveMissingFails(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a"), "a")
	m, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Apply(Change{Remove: true, Path: "nope"}); err == nil {
		t.Fatal("expected error removing missing path")
	}
}
