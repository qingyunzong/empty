package formal

import (
	"errors"
	"testing"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func wantUsage(t *testing.T, fs *FS, p string, links, inodes, bytes int64) {
	t.Helper()
	got, err := fs.Stats(p)
	if err != nil {
		t.Fatalf("Stats(%q): %v", p, err)
	}
	want := Usage{Links: links, Inodes: inodes, Bytes: bytes}
	if got != want {
		t.Fatalf("Stats(%q) = %s, want %s", p, got, want)
	}
}

// checkEveryDirectory compares every maintained aggregate with a fresh naive
// per-entry walk of the same subtree.
func checkEveryDirectory(t *testing.T, fs *FS) {
	t.Helper()
	if err := fs.Check(); err != nil {
		t.Fatalf("Check: %v", err)
	}
	for _, dir := range fs.Dirs() {
		maintained, err := fs.Stats(dir.Path)
		if err != nil {
			t.Fatalf("Stats(%q): %v", dir.Path, err)
		}
		naive, err := fs.NaiveStats(dir.Path)
		if err != nil {
			t.Fatalf("NaiveStats(%q): %v", dir.Path, err)
		}
		if maintained != naive {
			t.Fatalf("%s: maintained %s, naive %s", dir.Path, maintained, naive)
		}
		if dir.Usage != maintained {
			t.Fatalf("%s: Dirs reported %s, Stats reported %s", dir.Path, dir.Usage, maintained)
		}
	}
}

func TestBasicAccounting(t *testing.T) {
	fs := New()
	checkEveryDirectory(t, fs)

	must(t, fs.MkdirAll("/a/b"))
	must(t, fs.Mkdir("/c"))
	must(t, fs.CreateFile("/a/f1", 100))
	must(t, fs.CreateFile("/a/b/f2", 50))
	must(t, fs.CreateFile("/c/f3", 25))
	checkEveryDirectory(t, fs)

	wantUsage(t, fs, "/", 6, 6, 175)
	wantUsage(t, fs, "/a", 3, 3, 150)
	wantUsage(t, fs, "/a/b", 1, 1, 50)
	wantUsage(t, fs, "/c", 1, 1, 25)

	// A hard link into /a adds one namespace entry and one distinct inode to
	// /a, while the global inode and byte totals stay unchanged.
	must(t, fs.Link("/c/f3", "/a/f3-link"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 7, 6, 175)
	wantUsage(t, fs, "/a", 4, 4, 175)
	wantUsage(t, fs, "/c", 1, 1, 25)

	// A hard link to an inode that is already present in the subtree adds a
	// link but no new inode or bytes.
	must(t, fs.Link("/a/f1", "/c/f1-link"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 8, 6, 175)
	wantUsage(t, fs, "/a", 4, 4, 175)
	wantUsage(t, fs, "/c", 2, 2, 125)

	must(t, fs.Remove("/c/f1-link"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 7, 6, 175)
	wantUsage(t, fs, "/c", 1, 1, 25)

	// Removing the only link to f2 frees the inode.
	must(t, fs.Remove("/a/b/f2"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 6, 5, 125)
	wantUsage(t, fs, "/a", 3, 3, 125)
	wantUsage(t, fs, "/a/b", 0, 0, 0)

	must(t, fs.Remove("/a/b"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/a", 2, 2, 125)
}

func TestHardLinkConservation(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/a/b"))
	must(t, fs.Mkdir("/c"))
	must(t, fs.CreateFile("/a/b/f", 40))

	id, err := fs.Inode("/a/b/f")
	must(t, err)
	wantLinks := func(want int64) {
		t.Helper()
		got, err := fs.InodeLinks(id)
		must(t, err)
		if got != want {
			t.Fatalf("inode links = %d, want %d", got, want)
		}
	}

	wantLinks(1)
	must(t, fs.Link("/a/b/f", "/c/l1"))
	wantLinks(2)
	must(t, fs.LinkInode(id, "/c/l2"))
	wantLinks(3)
	checkEveryDirectory(t, fs)

	// Three links, two different subtrees, but one inode globally.
	global := fs.GlobalUsage()
	if global.Inodes != 5 { // root, a, b, c, file
		// root, /a, /a/b, /c, and file = 5 inodes total, including root.
		t.Fatalf("global inodes = %d, want 5", global.Inodes)
	}
	if global.Bytes != 40 {
		t.Fatalf("global bytes = %d, want 40", global.Bytes)
	}

	must(t, fs.Remove("/c/l1"))
	wantLinks(2)
	must(t, fs.Remove("/a/b/f"))
	wantLinks(1)
	must(t, fs.Remove("/c/l2"))
	if _, err := fs.InodeLinks(id); !errors.Is(err, ErrNotExist) {
		t.Fatalf("freed inode lookup error = %v, want ErrNotExist", err)
	}
	checkEveryDirectory(t, fs)
	if got := fs.GlobalUsage(); got != (Usage{Links: 3, Inodes: 4, Bytes: 0}) {
		// /a and /c hang off root; /a/b hangs off /a.
		t.Fatalf("global usage = %s, want links=3 inodes=4 bytes=0", got)
	}
}

func TestRenameFileCrossDirectory(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/a/sub"))
	must(t, fs.Mkdir("/b"))
	must(t, fs.Mkdir("/c"))
	must(t, fs.CreateFile("/a/f", 100))
	must(t, fs.CreateFile("/b/g", 7))
	must(t, fs.Link("/a/f", "/c/f-other"))
	checkEveryDirectory(t, fs)

	wantUsage(t, fs, "/", 7, 6, 107)
	wantUsage(t, fs, "/a", 2, 2, 100)
	wantUsage(t, fs, "/b", 1, 1, 7)
	wantUsage(t, fs, "/c", 1, 1, 100)

	must(t, fs.Rename("/a/f", "/b/f"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 7, 6, 107) // one link moved, nothing global changed
	wantUsage(t, fs, "/a", 1, 1, 0)
	wantUsage(t, fs, "/b", 2, 2, 107)
	wantUsage(t, fs, "/c", 1, 1, 100)

	// Move the /c link to /b as well. The source /c loses the inode, /b gains
	// only a link because the inode is already present there.
	must(t, fs.Rename("/c/f-other", "/b/f-second"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 7, 6, 107)
	wantUsage(t, fs, "/c", 0, 0, 0)
	wantUsage(t, fs, "/b", 3, 2, 107)

	// Move one of the two /b links through the common root into /a/sub. /b and
	// /a/sub change; the root sees no aggregate change.
	must(t, fs.Rename("/b/f-second", "/a/sub/f"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/", 7, 6, 107)
	wantUsage(t, fs, "/b", 2, 2, 107)
	wantUsage(t, fs, "/a/sub", 1, 1, 100)
	wantUsage(t, fs, "/a", 2, 2, 100) // /a/sub entry + /a/sub/f entry
}

func TestRenameDirectoryCrossBranch(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/src/sub"))
	must(t, fs.Mkdir("/dst"))
	must(t, fs.Mkdir("/other"))
	must(t, fs.CreateFile("/src/sub/x", 10))
	must(t, fs.CreateFile("/src/y", 20))
	must(t, fs.CreateFile("/other/z", 30))
	must(t, fs.Link("/other/z", "/src/sub/z-link"))
	must(t, fs.Link("/src/y", "/dst/y-link"))
	checkEveryDirectory(t, fs)

	wantUsage(t, fs, "/src", 4, 4, 60)     // sub, y, sub/x, sub/z-link
	wantUsage(t, fs, "/src/sub", 2, 2, 40) // x, z-link
	wantUsage(t, fs, "/dst", 1, 1, 20)
	wantUsage(t, fs, "/other", 1, 1, 30)
	wantUsage(t, fs, "/", 9, 7, 60)

	must(t, fs.Rename("/src/sub", "/dst/sub"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/src", 1, 1, 20)
	wantUsage(t, fs, "/dst", 4, 4, 60) // y-link, sub, sub/x, sub/z-link
	wantUsage(t, fs, "/dst/sub", 2, 2, 40)
	wantUsage(t, fs, "/other", 1, 1, 30)
	wantUsage(t, fs, "/", 9, 7, 60)

	if _, err := fs.Stats("/src/sub"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("Stats after rename error = %v, want ErrNotExist", err)
	}

	// Move it back under a new name. /src and /dst swap the subtree deltas.
	must(t, fs.Rename("/dst/sub", "/src/sub2"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/src", 4, 4, 60)
	wantUsage(t, fs, "/src/sub2", 2, 2, 40)
	wantUsage(t, fs, "/dst", 1, 1, 20)
	wantUsage(t, fs, "/", 9, 7, 60)

	// A rename whose parents share an ancestor must not change that ancestor.
	rootBefore, _ := fs.Stats("/")
	must(t, fs.Rename("/src/sub2/x", "/dst/x"))
	checkEveryDirectory(t, fs)
	rootAfter, _ := fs.Stats("/")
	if rootBefore != rootAfter {
		t.Fatalf("root changed across sibling rename: %s -> %s", rootBefore, rootAfter)
	}
	wantUsage(t, fs, "/src/sub2", 1, 1, 30) // only z-link remains
	wantUsage(t, fs, "/dst", 2, 2, 30)      // y-link and x
	wantUsage(t, fs, "/src", 3, 3, 50)      // sub2, y, sub2/z-link
	wantUsage(t, fs, "/", 9, 7, 60)
}

func TestRenameReplacement(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/a"))
	must(t, fs.Mkdir("/b"))
	must(t, fs.CreateFile("/a/src", 10))
	must(t, fs.CreateFile("/a/dst", 20))
	checkEveryDirectory(t, fs)

	must(t, fs.Rename("/a/src", "/a/dst"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/a", 1, 1, 10)
	if got := fs.GlobalUsage(); got != (Usage{Links: 3, Inodes: 4, Bytes: 10}) {
		t.Fatalf("global usage = %s, want links=3 inodes=4 bytes=10", got)
	}

	// Directory over an empty directory is allowed and frees the target inode.
	must(t, fs.Mkdir("/b/src-dir"))
	must(t, fs.Mkdir("/b/dst-dir"))
	must(t, fs.Rename("/b/src-dir", "/b/dst-dir"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/b", 1, 1, 0)

	// Directory over a non-empty directory is rejected without any change.
	must(t, fs.Mkdir("/b/full"))
	must(t, fs.CreateFile("/b/full/file", 5))
	before, _ := fs.Stats("/b")
	if err := fs.Rename("/a/dst", "/b/full"); !errors.Is(err, ErrIsDir) {
		t.Fatalf("rename over non-empty dir = %v, want ErrNotEmpty", err)
	}
	after, _ := fs.Stats("/b")
	if before != after {
		t.Fatalf("failed rename changed /b: %s -> %s", before, after)
	}
	checkEveryDirectory(t, fs)

	// A file cannot replace a directory, and a directory cannot replace a file.
	must(t, fs.Mkdir("/b/empty-dir"))
	if err := fs.Rename("/a/dst", "/b/empty-dir"); !errors.Is(err, ErrIsDir) {
		t.Fatalf("file over dir = %v, want ErrIsDir", err)
	}
	if err := fs.Rename("/b/empty-dir", "/a/dst"); !errors.Is(err, ErrNotDir) {
		t.Fatalf("dir over file = %v, want ErrNotDir", err)
	}
	checkEveryDirectory(t, fs)
}

func TestRenameReplacesHardLinkTarget(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/a"))
	must(t, fs.Mkdir("/b"))
	must(t, fs.Mkdir("/c"))
	must(t, fs.CreateFile("/a/src", 100))
	must(t, fs.CreateFile("/b/dst", 70))
	must(t, fs.Link("/b/dst", "/c/dst-other"))
	checkEveryDirectory(t, fs)

	// The replaced target survives through its other link, so only the
	// namespace link count changes; no inode is freed.
	must(t, fs.Rename("/a/src", "/b/dst"))
	checkEveryDirectory(t, fs)
	wantUsage(t, fs, "/a", 0, 0, 0)
	wantUsage(t, fs, "/b", 1, 1, 100)
	wantUsage(t, fs, "/c", 1, 1, 70)
	wantUsage(t, fs, "/", 5, 5, 170) // root,a,b,c entries + /b/dst + /c/dst-other
	if got := fs.GlobalUsage(); got != (Usage{Links: 5, Inodes: 6, Bytes: 170}) {
		t.Fatalf("global usage = %s, want links=5 inodes=6 bytes=170", got)
	}

	// Replacing a link with another link to the same inode removes exactly one
	// hard link and keeps the inode charged once.
	must(t, fs.Mkdir("/d"))
	must(t, fs.Link("/b/dst", "/d/same"))
	before, _ := fs.Stats("/")
	must(t, fs.Rename("/d/same", "/b/dst"))
	checkEveryDirectory(t, fs)
	after, _ := fs.Stats("/")
	want := Usage{Links: before.Links - 1, Inodes: before.Inodes, Bytes: before.Bytes}
	if after != want {
		t.Fatalf("same-inode replacement root = %s, want %s", after, want)
	}
	wantUsage(t, fs, "/d", 0, 0, 0)
	wantUsage(t, fs, "/b", 1, 1, 100)
}

func TestRenameDirectoryReplacesEmptyDirectory(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/a/move/sub"))
	must(t, fs.MkdirAll("/b/empty"))
	must(t, fs.Mkdir("/keep"))
	must(t, fs.CreateFile("/a/move/sub/file", 9))
	must(t, fs.Link("/a/move/sub/file", "/keep/link"))
	checkEveryDirectory(t, fs)

	must(t, fs.Rename("/a/move", "/b/empty"))
	checkEveryDirectory(t, fs)
	if _, err := fs.Stats("/a/move"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("old directory still present: %v", err)
	}
	wantUsage(t, fs, "/b", 3, 3, 9) // empty, empty/sub, empty/sub/file
	wantUsage(t, fs, "/b/empty/sub", 1, 1, 9)
	wantUsage(t, fs, "/a", 0, 0, 0)
	wantUsage(t, fs, "/keep", 1, 1, 9)
	wantUsage(t, fs, "/", 7, 6, 9)
}

func TestNamespaceAliasesAndPaths(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("//a/./b/"))
	must(t, fs.Create("a/b/f", 3))
	must(t, fs.HardLink("a/b/f", "a/b/g"))
	if got, err := fs.Stat("/a/b"); err != nil || got != (Usage{Links: 2, Inodes: 1, Bytes: 3}) {
		t.Fatalf("Stat = %s, %v", got, err)
	}
	must(t, fs.Unlink("/a/b/g"))
	if err := fs.Rmdir("/a/b"); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("Rmdir non-empty = %v", err)
	}
	if err := fs.Rmdir("/a/b/f"); !errors.Is(err, ErrNotDir) {
		t.Fatalf("Rmdir file = %v", err)
	}
	must(t, fs.Remove("/a/b/f"))
	must(t, fs.Rmdir("/a/b"))
	must(t, fs.Rmdir("/a"))
	checkEveryDirectory(t, fs)
	if got := fs.RootUsage(); got != (Usage{}) {
		t.Fatalf("root usage = %s, want zero", got)
	}
	if NewQuota() == nil {
		t.Fatal("NewQuota returned nil")
	}
}

func TestRenameIntoOwnSubtreeRejected(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/a/b"))
	must(t, fs.CreateFile("/a/b/f", 1))
	before := fs.Dirs()

	if err := fs.Rename("/a", "/a/b/a"); !errors.Is(err, ErrInvalidRename) {
		t.Fatalf("rename into own subtree = %v, want ErrInvalidRename", err)
	}
	if err := fs.Rename("/a", "/a/b"); !errors.Is(err, ErrInvalidRename) && !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("rename onto descendant = %v", err)
	}
	checkEveryDirectory(t, fs)
	after := fs.Dirs()
	if len(before) != len(after) {
		t.Fatalf("failed rename changed directory set: %d -> %d", len(before), len(after))
	}
}

func TestRemoveAllKeepsExternalHardLinks(t *testing.T) {
	fs := New()
	must(t, fs.MkdirAll("/tree/sub"))
	must(t, fs.Mkdir("/outside"))
	must(t, fs.CreateFile("/tree/sub/file", 64))
	must(t, fs.Link("/tree/sub/file", "/outside/kept"))
	must(t, fs.CreateFile("/tree/own", 5))
	checkEveryDirectory(t, fs)

	id, err := fs.Inode("/outside/kept")
	must(t, err)

	must(t, fs.RemoveAll("/tree"))
	checkEveryDirectory(t, fs)
	if _, err := fs.Stats("/tree"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("Stats(/tree) error = %v, want ErrNotExist", err)
	}
	wantUsage(t, fs, "/outside", 1, 1, 64)
	wantUsage(t, fs, "/", 2, 2, 64) // /outside and /outside/kept
	if links, err := fs.InodeLinks(id); err != nil || links != 1 {
		t.Fatalf("kept inode links = %d, %v; want 1", links, err)
	}

	// Removing an absent path is a no-op.
	must(t, fs.RemoveAll("/does/not/exist"))
	if err := fs.RemoveAll("/"); !errors.Is(err, ErrRoot) {
		t.Fatalf("RemoveAll(/) = %v, want ErrRoot", err)
	}
}

func TestErrors(t *testing.T) {
	fs := New()
	if err := fs.Mkdir("/a"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Mkdir("/a"); !errors.Is(err, ErrExist) {
		t.Fatalf("duplicate mkdir = %v", err)
	}
	if err := fs.CreateFile("/a", 1); !errors.Is(err, ErrExist) {
		t.Fatalf("create over dir = %v", err)
	}
	if err := fs.CreateFile("/missing/f", 1); !errors.Is(err, ErrNotExist) {
		t.Fatalf("create under missing parent = %v", err)
	}
	if err := fs.CreateFile("/file", -1); !errors.Is(err, ErrNegativeSize) {
		t.Fatalf("negative size = %v", err)
	}
	if err := fs.Link("/a", "/dir-link"); !errors.Is(err, ErrIsDir) {
		t.Fatalf("link dir = %v", err)
	}
	if err := fs.Remove("/"); !errors.Is(err, ErrRoot) {
		t.Fatalf("remove root = %v", err)
	}
	if err := fs.Rename("/missing", "/missing"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("rename missing to itself = %v, want ErrNotExist", err)
	}
	if _, err := fs.Stats("/nope"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("stats missing = %v", err)
	}
	checkEveryDirectory(t, fs)
}
