package merklefs

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// fileEntry builds a file Entry for path inside fsys the same way Walk does.
func fileEntry(t *testing.T, fsys fs.FS, path string) Entry {
	t.Helper()
	info, err := fs.Stat(fsys, path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := hashFile(fsys, path)
	if err != nil {
		t.Fatal(err)
	}
	e := Entry{Path: path, Type: TypeFile, Size: info.Size(), Hash: h}
	if key, ok := statObject(info); ok {
		e.ObjID = objectID(key)
	} else {
		e.ObjID = objectIDPath(path)
	}
	return e
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestIncrementalMatchesRebuild applies a batch of changes incrementally
// and checks the resulting manifest against a full re-walk of the tree.
func TestIncrementalMatchesRebuild(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.txt", "alpha")
	write(t, dir, "b.txt", "bravo")
	write(t, dir, "sub/c.txt", "charlie")
	if err := os.Symlink("a.txt", filepath.Join(dir, "link")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if err := os.Link(filepath.Join(dir, "a.txt"), filepath.Join(dir, "hard.txt")); err != nil {
		t.Skipf("hard links unsupported: %v", err)
	}

	fsys := os.DirFS(dir)
	m1, err := Walk(fsys, ".")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}

	// Mutate the filesystem.
	write(t, dir, "b.txt", "bravo-v2")    // modify content
	write(t, dir, "sub/d.txt", "delta")   // add file
	write(t, dir, "newdir/e.txt", "echo") // add dir + file
	if err := os.Remove(filepath.Join(dir, "sub/c.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "hard.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "b.txt"), filepath.Join(dir, "b-hard.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("sub", filepath.Join(dir, "dirlink")); err != nil {
		t.Fatal(err)
	}

	// Describe the same mutations as incremental changes.
	changes := []Change{
		{Kind: Upsert, Entry: fileEntry(t, fsys, "b.txt")},
		{Kind: Upsert, Entry: fileEntry(t, fsys, "sub/d.txt")},
		{Kind: Upsert, Entry: Entry{Path: "newdir", Type: TypeDir}},
		{Kind: Upsert, Entry: fileEntry(t, fsys, "newdir/e.txt")},
		{Kind: Remove, Entry: Entry{Path: "sub/c.txt"}},
		{Kind: Remove, Entry: Entry{Path: "hard.txt"}},
		{Kind: Upsert, Entry: fileEntry(t, fsys, "b-hard.txt")},
		{Kind: Upsert, Entry: Entry{Path: "dirlink", Type: TypeSymlink, Target: "sub"}},
	}
	m2inc, err := m1.Apply(changes...)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Full rebuild from the mutated tree.
	m2full, err := Walk(fsys, ".")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}

	if m2inc.Root() != m2full.Root() {
		t.Fatalf("incremental root %x != rebuild root %x", m2inc.Root(), m2full.Root())
	}
	if !reflect.DeepEqual(m2inc.Entries, m2full.Entries) {
		t.Fatalf("incremental entries differ from rebuild:\ninc:  %+v\nfull: %+v", m2inc.Entries, m2full.Entries)
	}

	// The hard link added incrementally must share the object of b.txt.
	b, _ := m2inc.Find("b.txt")
	bh, _ := m2inc.Find("b-hard.txt")
	if b.ObjID != bh.ObjID {
		t.Fatal("incremental hard link not recorded as same object")
	}
}

func TestApplyErrors(t *testing.T) {
	m := testManifest(t, 3)
	if _, err := m.Apply(Change{Kind: Remove, Entry: Entry{Path: "absent"}}); err == nil {
		t.Error("removing absent path succeeded")
	}
	if _, err := m.Apply(Change{Kind: Upsert, Entry: Entry{Path: "../evil"}}); err == nil {
		t.Error("upserting non-canonical path succeeded")
	}
	if _, err := m.Apply(Change{Kind: 0, Entry: Entry{Path: "file000.txt"}}); err == nil {
		t.Error("unknown change kind succeeded")
	}
}

func TestApplyEmptyRoundTrip(t *testing.T) {
	m := testManifest(t, 5)
	var changes []Change
	for _, e := range m.Entries {
		changes = append(changes, Change{Kind: Remove, Entry: e})
	}
	empty, err := m.Apply(changes...)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Len() != 0 || empty.Root() != emptyRoot {
		t.Fatal("removing all entries did not yield the empty manifest")
	}
	// Rebuild everything from empty.
	var up []Change
	for _, e := range m.Entries {
		up = append(up, Change{Kind: Upsert, Entry: e})
	}
	full, err := empty.Apply(up...)
	if err != nil {
		t.Fatal(err)
	}
	if full.Root() != m.Root() {
		t.Fatal("rebuilt root differs from original")
	}
}
