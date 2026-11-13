package snapshot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"testing"
	"time"
)

// fakeFS is an in-memory FileSystem with controllable pagination,
// mtime precision, inode availability, and cancellation injection.
type fakeFS struct {
	dirs      map[string][]string // dir -> entry names
	files     map[string]*fakeFile
	pageSize  int
	precision time.Duration
	withID    bool
	nextIno   uint64

	listCalls int
	cancelAt  int // cancel ctx on the Nth List call; 0 disables
	ctx       context.Context
}

type fakeFile struct {
	content []byte
	mod     time.Time
	ino     uint64
}

func newFakeFS() *fakeFS {
	return &fakeFS{
		dirs:      map[string][]string{"/": {}},
		files:     map[string]*fakeFile{},
		pageSize:  2,
		precision: time.Second,
		withID:    true,
		nextIno:   1,
		ctx:       context.Background(),
	}
}

func (f *fakeFS) addFile(dir, name, content string, mod time.Time) {
	if f.dirs[dir] == nil {
		f.dirs[dir] = nil
	}
	p := dir + "/" + name
	if dir == "/" {
		p = "/" + name
	}
	f.dirs[dir] = append(f.dirs[dir], p)
	f.files[p] = &fakeFile{content: []byte(content), mod: mod, ino: f.nextIno}
	f.nextIno++
}

func (f *fakeFS) writeFile(p, content string, mod time.Time) {
	f.files[p].content = []byte(content)
	f.files[p].mod = mod
}

func (f *fakeFS) rename(old, new string) {
	ff := f.files[old]
	delete(f.files, old)
	f.files[new] = ff
	for dir, entries := range f.dirs {
		for i, e := range entries {
			if e == old {
				f.dirs[dir][i] = new
			}
		}
	}
}

func (f *fakeFS) remove(p string) {
	delete(f.files, p)
	for dir, entries := range f.dirs {
		for i, e := range entries {
			if e == p {
				f.dirs[dir] = append(entries[:i], entries[i+1:]...)
				return
			}
		}
	}
}

func (f *fakeFS) List(ctx context.Context, dir, cursor string) ([]DirEntry, string, error) {
	f.listCalls++
	if f.cancelAt > 0 && f.listCalls == f.cancelAt {
		return nil, "", context.Canceled
	}
	names := f.dirs[dir]
	sort.Strings(names)
	start := 0
	if cursor != "" {
		fmt.Sscanf(cursor, "%d", &start)
	}
	end := start + f.pageSize
	if end > len(names) {
		end = len(names)
	}
	var out []DirEntry
	for _, p := range names[start:end] {
		ff, isFile := f.files[p]
		if !isFile {
			out = append(out, DirEntry{Path: p, IsDir: true})
			continue
		}
		e := DirEntry{
			Path:    p,
			Size:    int64(len(ff.content)),
			ModTime: ff.mod.Truncate(f.precision),
		}
		if f.withID {
			e.ID = FileID{Dev: 1, Ino: ff.ino}
			e.HasID = true
		}
		out = append(out, e)
	}
	next := ""
	if end < len(names) {
		next = fmt.Sprintf("%d", end)
	}
	return out, next, nil
}

func (f *fakeFS) Open(ctx context.Context, p string) (io.ReadCloser, error) {
	ff, ok := f.files[p]
	if !ok {
		return nil, errors.New("no such file")
	}
	return io.NopCloser(strings.NewReader(string(ff.content))), nil
}

var base = time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)

func scanPaths(files []File) []string {
	var out []string
	for _, f := range files {
		out = append(out, f.Path)
	}
	return out
}

func TestDeliversAfterStableScans(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "a.csv", "hello", base)
	s := New(fs, Config{})

	got, err := s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("first scan delivered %v, want none", scanPaths(got))
	}

	got, err = s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != "/a.csv" {
		t.Fatalf("second scan delivered %v, want [/a.csv]", scanPaths(got))
	}

	got, err = s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("third scan re-delivered %v", scanPaths(got))
	}
}

func TestGrowingFileNeverStabilizes(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "up.bin", "chunk1", base)
	s := New(fs, Config{})

	for i := 2; i <= 5; i++ {
		if got, _ := s.Scan(context.Background(), "/"); len(got) != 0 {
			t.Fatalf("scan %d delivered %v while upload in progress", i-1, scanPaths(got))
		}
		fs.writeFile("/up.bin", strings.Repeat("x", i*10), base.Add(time.Duration(i)*time.Minute))
	}
	if got, _ := s.Scan(context.Background(), "/"); len(got) != 0 {
		t.Fatalf("delivered %v on first quiet scan", scanPaths(got))
	}
	got, _ := s.Scan(context.Background(), "/")
	if len(got) != 1 {
		t.Fatalf("got %v after upload finished, want 1 file", scanPaths(got))
	}
}

func TestTempFilesIgnored(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "data.csv", "ok", base)
	fs.addFile("/", "data.csv.part", "partial", base)
	fs.addFile("/", ".hidden", "x", base)
	fs.addFile("/", "upload.tmp", "x", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	got, _ := s.Scan(context.Background(), "/")
	if len(got) != 1 || got[0].Path != "/data.csv" {
		t.Fatalf("delivered %v, want only /data.csv", scanPaths(got))
	}
}

func TestRenameWithInodeKeepsStability(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "uploading.tmp", "payload", base)
	// Bypass the temp filter for this test: the uploader renames a
	// non-temp staging name to the final name.
	fs.rename("/uploading.tmp", "/staging.dat")
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	fs.rename("/staging.dat", "/final.dat")
	got, err := s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != "/final.dat" {
		t.Fatalf("rename across scans: got %v, want [/final.dat]", scanPaths(got))
	}
}

func TestRenameWithoutInodeUsesDigestGeneration(t *testing.T) {
	fs := newFakeFS()
	fs.withID = false
	fs.addFile("/", "staging.dat", "payload", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	fs.rename("/staging.dat", "/final.dat")
	got, err := s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != "/final.dat" {
		t.Fatalf("rename without inode: got %v, want [/final.dat]", scanPaths(got))
	}
	if got[0].Gen == 0 {
		t.Fatal("digest generation not carried over")
	}
}

func TestContentChangeResetsStability(t *testing.T) {
	fs := newFakeFS()
	fs.withID = false
	fs.addFile("/", "f.bin", "v1", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	got, _ := s.Scan(context.Background(), "/")
	if len(got) != 1 {
		t.Fatalf("got %v, want 1 file", scanPaths(got))
	}
	gen1 := got[0].Gen

	// Same path, same size, same mtime bucket, different content.
	fs.writeFile("/f.bin", "v2", base)
	if got, _ := s.Scan(context.Background(), "/"); len(got) != 0 {
		t.Fatalf("changed content delivered immediately: %v", scanPaths(got))
	}
	got, _ = s.Scan(context.Background(), "/")
	if len(got) != 1 {
		t.Fatalf("got %v, want re-delivery after change", scanPaths(got))
	}
	if got[0].Gen == gen1 {
		t.Fatal("digest generation did not advance after content change")
	}
}

func TestMtimePrecisionDifference(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "f.csv", "data", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	// Server now reports sub-second precision for the same mtime.
	fs.precision = time.Nanosecond
	fs.files["/f.csv"].mod = base.Add(400 * time.Millisecond)
	got, err := s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("sub-second mtime jitter broke stability: got %v", scanPaths(got))
	}
}

func TestPagination(t *testing.T) {
	fs := newFakeFS()
	fs.pageSize = 1 // one entry per page
	for i := 0; i < 5; i++ {
		fs.addFile("/", fmt.Sprintf("f%d.csv", i), "x", base)
	}
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	got, err := s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 {
		t.Fatalf("paginated scan delivered %v, want 5 files", scanPaths(got))
	}
}

func TestCancelledScanDoesNotCommit(t *testing.T) {
	fs := newFakeFS()
	fs.pageSize = 1
	fs.addFile("/", "a.csv", "a", base)
	fs.addFile("/", "b.csv", "b", base)
	s := New(fs, Config{})

	// First complete scan observes both files once.
	if _, err := s.Scan(context.Background(), "/"); err != nil {
		t.Fatal(err)
	}

	// Second scan is cancelled after the first page: only /a.csv was
	// re-observed. Nothing may be committed.
	fs.listCalls = 0
	fs.cancelAt = 1
	if _, err := s.Scan(context.Background(), "/"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	fs.cancelAt = 0

	// Resume: both files still need one more full observation, so this
	// scan delivers them only now, together.
	got, err := s.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("resume delivered %v, want both files exactly once", scanPaths(got))
	}
	if got, _ := s.Scan(context.Background(), "/"); len(got) != 0 {
		t.Fatalf("re-delivered %v", scanPaths(got))
	}
}

func TestExportImportResumesWithoutDoubleDelivery(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "a.csv", "a", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	state, err := s.Export()
	if err != nil {
		t.Fatal(err)
	}

	// Simulate a service restart with the same remote.
	s2 := New(fs, Config{})
	if err := s2.Import(state); err != nil {
		t.Fatal(err)
	}
	got, err := s2.Scan(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != "/a.csv" {
		t.Fatalf("after restore got %v, want [/a.csv]", scanPaths(got))
	}
}

func TestStableAge(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "fresh.csv", "x", base)
	now := base
	s := New(fs, Config{
		StableAge: time.Hour,
		Now:       func() time.Time { return now },
	})

	s.Scan(context.Background(), "/")
	if got, _ := s.Scan(context.Background(), "/"); len(got) != 0 {
		t.Fatalf("delivered %v before StableAge elapsed", scanPaths(got))
	}
	now = base.Add(2 * time.Hour)
	got, _ := s.Scan(context.Background(), "/")
	if len(got) != 1 {
		t.Fatalf("got %v after StableAge, want 1 file", scanPaths(got))
	}
}

func TestDisappearedFileRestartsStability(t *testing.T) {
	fs := newFakeFS()
	fs.addFile("/", "f.csv", "v1", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	fs.remove("/f.csv")
	s.Scan(context.Background(), "/")
	fs.addFile("/", "f.csv", "v1", base)
	if got, _ := s.Scan(context.Background(), "/"); len(got) != 0 {
		t.Fatalf("reappeared file delivered too early: %v", scanPaths(got))
	}
	if got, _ := s.Scan(context.Background(), "/"); len(got) != 1 {
		t.Fatalf("got %v, want 1 file", scanPaths(got))
	}
}

func TestSubdirectories(t *testing.T) {
	fs := newFakeFS()
	fs.dirs["/"] = []string{"/inbox"}
	fs.dirs["/inbox"] = nil
	fs.addFile("/inbox", "nested.csv", "n", base)
	s := New(fs, Config{})

	s.Scan(context.Background(), "/")
	got, _ := s.Scan(context.Background(), "/")
	if len(got) != 1 || got[0].Path != "/inbox/nested.csv" {
		t.Fatalf("got %v, want [/inbox/nested.csv]", scanPaths(got))
	}
}
