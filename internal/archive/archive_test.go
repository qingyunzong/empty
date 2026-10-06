package archive

import (
	"archive/tar"
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

// --- helpers ---------------------------------------------------------------

func inodeOf(t *testing.T, p string) uint64 {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat %s: %v", p, err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("no Stat_t for %s", p)
	}
	return uint64(st.Ino)
}

type entryMeta struct {
	Kind  string
	Size  int64
	Mode  string
	Mtime int64
	Ino   uint64
	Link  string
}

// snapshot records every entry under root so tests can prove the source
// tree is left untouched.
func snapshot(t *testing.T, root string) map[string]entryMeta {
	t.Helper()
	m := map[string]entryMeta{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if rel == "." {
			return nil
		}
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		meta := entryMeta{Size: info.Size(), Mode: info.Mode().String(), Mtime: info.ModTime().UnixNano()}
		switch {
		case info.IsDir():
			meta.Kind = "dir"
		case info.Mode()&os.ModeSymlink != 0:
			meta.Kind = "symlink"
			meta.Link, _ = os.Readlink(p)
		case info.Mode().IsRegular():
			meta.Kind = "file"
			meta.Ino = inodeOf(t, p)
		default:
			meta.Kind = "other"
		}
		m[rel] = meta
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func buildSourceTree(t *testing.T) string {
	t.Helper()
	src := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(src, "sub", "deep"), 0o755))
	must(os.WriteFile(filepath.Join(src, "hello.txt"), []byte("hello world"), 0o644))
	must(os.WriteFile(filepath.Join(src, "sub", "data.bin"), []byte{0, 1, 2, 3, 255}, 0o600))
	// Hard link pair sharing one inode.
	must(os.Link(filepath.Join(src, "hello.txt"), filepath.Join(src, "sub", "deep", "hello-alias.txt")))
	// Ordinary relative symlink.
	must(os.Symlink("../hello.txt", filepath.Join(src, "sub", "hello-link")))
	// Circular symlink pair: must be recorded, never followed.
	must(os.Symlink("loop-b", filepath.Join(src, "loop-a")))
	must(os.Symlink("loop-a", filepath.Join(src, "loop-b")))
	return src
}

func pack(t *testing.T, src string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	if err := Create(src, &buf); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return &buf
}

// tarBytes builds a handcrafted archive from (header, body) pairs.
func tarBytes(t *testing.T, entries ...any) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for i := 0; i < len(entries); i += 2 {
		hdr := entries[i].(*tar.Header)
		body := entries[i+1].(string)
		hdr.Size = int64(len(body))
		if hdr.Typeflag != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			if _, err := io.WriteString(tw, body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// --- tests -----------------------------------------------------------------

func TestRoundTrip(t *testing.T) {
	src := buildSourceTree(t)
	before := snapshot(t, src)

	archiveData := pack(t, src)

	dest := filepath.Join(t.TempDir(), "new-root")
	if err := Extract(dest, bytes.NewReader(archiveData.Bytes())); err != nil {
		t.Fatalf("Extract: %v", err)
	}

	// Regular file contents survive.
	got, err := os.ReadFile(filepath.Join(dest, "hello.txt"))
	if err != nil || string(got) != "hello world" {
		t.Fatalf("hello.txt = %q, %v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(dest, "sub", "data.bin"))
	if err != nil || !bytes.Equal(got, []byte{0, 1, 2, 3, 255}) {
		t.Fatalf("data.bin = %v, %v", got, err)
	}

	// Hard link relationship: both names resolve to the same inode in the
	// new root, and the inode differs from the source copy.
	a := inodeOf(t, filepath.Join(dest, "hello.txt"))
	b := inodeOf(t, filepath.Join(dest, "sub", "deep", "hello-alias.txt"))
	if a != b {
		t.Fatalf("hard link broken: inodes %d != %d", a, b)
	}
	if a == inodeOf(t, filepath.Join(src, "hello.txt")) {
		t.Fatal("restored file unexpectedly shares inode with source")
	}

	// Relative symlink recorded verbatim.
	link, err := os.Readlink(filepath.Join(dest, "sub", "hello-link"))
	if err != nil || link != "../hello.txt" {
		t.Fatalf("symlink = %q, %v", link, err)
	}

	// Circular symlinks restored as links, not followed.
	la, err := os.Readlink(filepath.Join(dest, "loop-a"))
	if err != nil || la != "loop-b" {
		t.Fatalf("loop-a = %q, %v", la, err)
	}
	lb, err := os.Readlink(filepath.Join(dest, "loop-b"))
	if err != nil || lb != "loop-a" {
		t.Fatalf("loop-b = %q, %v", lb, err)
	}

	// Old target directory unchanged by pack and restore.
	after := snapshot(t, src)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("source tree mutated:\nbefore=%v\nafter=%v", before, after)
	}
}

func TestHardlinkTargetArrivesLate(t *testing.T) {
	// The hard link entry precedes its target in the stream.
	data := tarBytes(t,
		&tar.Header{Typeflag: tar.TypeLink, Name: "alias.txt", Linkname: "dir/original.txt"}, "",
		&tar.Header{Typeflag: tar.TypeDir, Name: "dir", Mode: 0o755}, "",
		&tar.Header{Typeflag: tar.TypeReg, Name: "dir/original.txt", Mode: 0o644}, "payload",
	)
	dest := filepath.Join(t.TempDir(), "out")
	if err := Extract(dest, bytes.NewReader(data)); err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if a, b := inodeOf(t, filepath.Join(dest, "alias.txt")), inodeOf(t, filepath.Join(dest, "dir", "original.txt")); a != b {
		t.Fatalf("late hard link not resolved: inodes %d != %d", a, b)
	}
	got, _ := os.ReadFile(filepath.Join(dest, "alias.txt"))
	if string(got) != "payload" {
		t.Fatalf("alias content = %q", got)
	}
}

func TestIllegalEntriesFailWholeRelease(t *testing.T) {
	cases := map[string][]byte{
		"dotdot name": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeReg, Name: "../evil.txt", Mode: 0o644}, "x"),
		"absolute name": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeReg, Name: "/abs/evil.txt", Mode: 0o644}, "x"),
		"nested traversal": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeReg, Name: "a/../../evil.txt", Mode: 0o644}, "x"),
		"symlink escapes root": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeSymlink, Name: "link", Linkname: "../../etc/passwd"}, ""),
		"absolute symlink target": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeSymlink, Name: "link", Linkname: "/etc/passwd"}, ""),
		"hardlink escapes root": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeLink, Name: "link", Linkname: "../victim"}, ""),
		"hardlink missing target": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeLink, Name: "link", Linkname: "never/created"}, ""),
		"unsupported type": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeChar, Name: "dev0", Mode: 0o644}, ""),
		"good then bad": tarBytes(t,
			&tar.Header{Typeflag: tar.TypeReg, Name: "fine.txt", Mode: 0o644}, "ok",
		),
	}
	// Append a bad entry to the "good then bad" archive so partial output
	// must be rolled back.
	{
		good := cases["good then bad"]
		bad := tarBytes(t, &tar.Header{Typeflag: tar.TypeReg, Name: "../evil", Mode: 0o644}, "x")
		cases["good then bad"] = append(good[:len(good)-1024], bad...) // strip tar EOF blocks, splice
	}

	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			dest := filepath.Join(parent, "out")
			err := Extract(dest, bytes.NewReader(data))
			if err == nil {
				t.Fatalf("Extract succeeded, want failure")
			}
			if _, statErr := os.Lstat(dest); !os.IsNotExist(statErr) {
				t.Fatalf("partial release left behind at %q", dest)
			}
			// No temp extraction dirs linger either.
			leftovers, _ := filepath.Glob(filepath.Join(parent, ".extract-*"))
			if len(leftovers) != 0 {
				t.Fatalf("temp dirs left behind: %v", leftovers)
			}
		})
	}
}

func TestExtractRefusesExistingDest(t *testing.T) {
	src := buildSourceTree(t)
	data := pack(t, src)
	dest := t.TempDir() // already exists
	if err := Extract(dest, bytes.NewReader(data.Bytes())); err == nil {
		t.Fatal("Extract into existing dir succeeded, want failure")
	}
}

func TestCreateRejectsIllegalSourceEntries(t *testing.T) {
	t.Run("absolute symlink", func(t *testing.T) {
		src := t.TempDir()
		if err := os.Symlink("/etc/hostname", filepath.Join(src, "abs-link")); err != nil {
			t.Fatal(err)
		}
		if err := Create(src, io.Discard); err == nil {
			t.Fatal("Create succeeded with absolute symlink, want failure")
		}
	})
	t.Run("fifo", func(t *testing.T) {
		src := t.TempDir()
		if err := syscall.Mkfifo(filepath.Join(src, "pipe"), 0o644); err != nil {
			t.Skipf("mkfifo: %v", err)
		}
		if err := Create(src, io.Discard); err == nil {
			t.Fatal("Create succeeded with fifo, want failure")
		}
	})
}
