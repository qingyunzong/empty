package treewalk_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"treewalk"
)

// fakeFS is an in-memory Adapter that tracks open-handle usage so tests
// can verify the concurrency budget and that every handle is closed.
type fakeFS struct {
	mu        sync.Mutex
	dirs      map[string][]string // dir path -> child names
	files     map[string]int64    // file path -> size
	links     map[string]string   // symlink path -> target path
	ids       map[string]treewalk.Identity
	nextIno   uint64
	lstatErr  map[string]error
	openErr   map[string]error
	readDelay time.Duration

	open     int // currently open handles
	maxOpen  int // high-water mark
	opened   int // total Open calls that succeeded
	closeCnt int // total Close calls
}

func newFakeFS() *fakeFS {
	return &fakeFS{
		dirs:     map[string][]string{},
		files:    map[string]int64{},
		links:    map[string]string{},
		ids:      map[string]treewalk.Identity{},
		lstatErr: map[string]error{},
		openErr:  map[string]error{},
		nextIno:  1,
	}
}

func (f *fakeFS) dir(path string, id treewalk.Identity, children ...string) {
	f.dirs[path] = children
	f.ids[path] = id
	if id.Ino >= f.nextIno {
		f.nextIno = id.Ino + 1
	}
}

func (f *fakeFS) file(path string, size int64) { f.files[path] = size }

func (f *fakeFS) link(path, target string) { f.links[path] = target }

func (f *fakeFS) idFor(path string) treewalk.Identity {
	if id, ok := f.ids[path]; ok {
		return id
	}
	id := treewalk.Identity{Dev: 1, Ino: f.nextIno}
	f.nextIno++
	f.ids[path] = id
	return id
}

var errNotExist = errors.New("no such file or directory")

// resolvePath resolves symlinks in every component of p, like the OS
// does when walking a path.
func (f *fakeFS) resolvePath(p string) string {
	for i := 0; i < 40; i++ {
		parts := strings.Split(p, "/")
		rewrote := false
		for j := range parts {
			prefix := strings.Join(parts[:j+1], "/")
			if target, ok := f.links[prefix]; ok {
				rest := strings.Join(parts[j+1:], "/")
				p = target
				if rest != "" {
					p = target + "/" + rest
				}
				rewrote = true
				break
			}
		}
		if !rewrote {
			return p
		}
	}
	return p
}

func (f *fakeFS) stat(path string, follow bool) (treewalk.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Resolve all parent components; the final component is resolved
	// below only when follow is set (lstat vs stat semantics).
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		path = f.resolvePath(path[:idx]) + "/" + path[idx+1:]
	}
	seen := map[string]bool{}
	for {
		if err, ok := f.lstatErr[path]; ok {
			return treewalk.FileInfo{}, err
		}
		if target, ok := f.links[path]; ok {
			if !follow {
				return treewalk.FileInfo{ID: f.idFor(path), IsSymlink: true}, nil
			}
			if seen[path] {
				return treewalk.FileInfo{}, errors.New("too many levels of symbolic links")
			}
			seen[path] = true
			path = target
			continue
		}
		if _, ok := f.dirs[path]; ok {
			return treewalk.FileInfo{ID: f.idFor(path), IsDir: true}, nil
		}
		if size, ok := f.files[path]; ok {
			return treewalk.FileInfo{ID: f.idFor(path), Size: size}, nil
		}
		return treewalk.FileInfo{}, errNotExist
	}
}

func (f *fakeFS) Lstat(path string) (treewalk.FileInfo, error) { return f.stat(path, false) }
func (f *fakeFS) Stat(path string) (treewalk.FileInfo, error)  { return f.stat(path, true) }

func (f *fakeFS) Open(path string) (treewalk.DirHandle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.openErr[path]; ok {
		return nil, err
	}
	// Like the OS, opening follows symlinks in every path component.
	path = f.resolvePath(path)
	if _, ok := f.dirs[path]; !ok {
		return nil, errors.New("not a directory")
	}
	f.open++
	f.opened++
	if f.open > f.maxOpen {
		f.maxOpen = f.open
	}
	return &fakeHandle{fs: f, path: path}, nil
}

func (f *fakeFS) stats() (open, maxOpen, opened, closed int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.open, f.maxOpen, f.opened, f.closeCnt
}

type fakeHandle struct {
	fs     *fakeFS
	path   string
	closed bool
}

func (h *fakeHandle) ReadDir() ([]string, error) {
	if h.fs.readDelay > 0 {
		time.Sleep(h.fs.readDelay)
	}
	h.fs.mu.Lock()
	defer h.fs.mu.Unlock()
	if h.closed {
		return nil, errors.New("read on closed handle")
	}
	return append([]string(nil), h.fs.dirs[h.path]...), nil
}

func (h *fakeHandle) Close() error {
	h.fs.mu.Lock()
	defer h.fs.mu.Unlock()
	if !h.closed {
		h.closed = true
		h.fs.open--
		h.fs.closeCnt++
	}
	return nil
}

// entryPaths returns the sorted paths of all collected entries.
func entryPaths(r treewalk.Result) []string {
	var out []string
	for _, e := range r.Entries {
		out = append(out, e.Path)
	}
	sort.Strings(out)
	return out
}

func TestBudgetConservation(t *testing.T) {
	f := newFakeFS()
	// 6 levels of 4-way branching: 1365 dirs, 1024 leaf files.
	var build func(path string, depth int)
	build = func(path string, depth int) {
		if depth == 0 {
			f.dir(path, treewalk.Identity{Dev: 1, Ino: f.nextIno}, "leaf")
			f.file(path+"/leaf", 1)
			return
		}
		var kids []string
		for i := 0; i < 4; i++ {
			kids = append(kids, fmt.Sprintf("c%d", i))
		}
		f.dir(path, treewalk.Identity{Dev: 1, Ino: f.nextIno}, kids...)
		for _, k := range kids {
			build(path+"/"+k, depth-1)
		}
	}
	build("/r", 5)

	const k = 8
	res := treewalk.Walk(context.Background(), "/r", treewalk.Options{MaxOpen: k}, f)
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	open, maxOpen, opened, closed := f.stats()
	if maxOpen > k {
		t.Fatalf("budget violated: maxOpen=%d > K=%d", maxOpen, k)
	}
	if open != 0 {
		t.Fatalf("handle leak: %d handles still open", open)
	}
	if opened != closed {
		t.Fatalf("conservation violated: opened=%d closed=%d", opened, closed)
	}
	// 1365 dirs + 1024 files = 2389 entries.
	if got, want := len(res.Entries), 2389; got != want {
		t.Fatalf("entries=%d, want %d", got, want)
	}
}

func TestBudgetConservationWithOpenErrors(t *testing.T) {
	f := newFakeFS()
	f.dir("/r", treewalk.Identity{Dev: 1, Ino: 1}, "a", "b", "c")
	f.dir("/r/a", treewalk.Identity{Dev: 1, Ino: 2})
	f.dir("/r/b", treewalk.Identity{Dev: 1, Ino: 3})
	f.dir("/r/c", treewalk.Identity{Dev: 1, Ino: 4})
	f.openErr["/r/b"] = errors.New("permission denied")

	res := treewalk.Walk(context.Background(), "/r", treewalk.Options{MaxOpen: 2}, f)
	if len(res.Errors) != 1 || res.Errors[0].Path != "/r/b" || res.Errors[0].Op != "open" {
		t.Fatalf("expected one open error for /r/b, got %v", res.Errors)
	}
	open, _, opened, closed := f.stats()
	if open != 0 || opened != closed {
		t.Fatalf("leak after errors: open=%d opened=%d closed=%d", open, opened, closed)
	}
}

// TestSymlinkCycleByIdentity builds a loop that path-based detection
// cannot catch: /m and /n are distinct paths sharing one identity (like
// a bind mount), each linking to the other. Traversal must terminate and
// report cycles.
func TestSymlinkCycleByIdentity(t *testing.T) {
	f := newFakeFS()
	shared := treewalk.Identity{Dev: 7, Ino: 42}
	f.dir("/r", treewalk.Identity{Dev: 7, Ino: 1}, "p", "q")
	f.link("/r/p", "/m")
	f.link("/r/q", "/n")
	f.dir("/m", shared, "loop")
	f.dir("/n", shared, "loop")
	f.link("/m/loop", "/n")
	f.link("/n/loop", "/m")

	done := make(chan treewalk.Result, 1)
	go func() {
		done <- treewalk.Walk(context.Background(), "/r",
			treewalk.Options{FollowSymlinks: true, MaxOpen: 4}, f)
	}()
	var res treewalk.Result
	select {
	case res = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("walk did not terminate: identity cycle not detected")
	}

	var cycles int
	for _, e := range res.Errors {
		if !errors.Is(e.Err, treewalk.ErrCycle) {
			t.Fatalf("unexpected error: %v", e)
		}
		cycles++
	}
	if cycles == 0 {
		t.Fatal("expected at least one cycle error")
	}
	// /m (or /n) is entered exactly once despite two aliases.
	paths := entryPaths(res)
	var descents int
	for _, p := range paths {
		if p == "/r/p" || p == "/r/q" {
			descents++
		}
	}
	if descents != 1 {
		t.Fatalf("aliased dir entered %d times, want 1; paths=%v", descents, paths)
	}
	if open, _, _, _ := f.stats(); open != 0 {
		t.Fatalf("handle leak: %d open", open)
	}
}

func TestSelfLoopSymlink(t *testing.T) {
	f := newFakeFS()
	f.dir("/a", treewalk.Identity{Dev: 1, Ino: 1}, "self", "f.txt")
	f.link("/a/self", "/a")
	f.file("/a/f.txt", 3)

	res := treewalk.Walk(context.Background(), "/a",
		treewalk.Options{FollowSymlinks: true, MaxOpen: 2}, f)
	if len(res.Errors) != 1 || !errors.Is(res.Errors[0].Err, treewalk.ErrCycle) {
		t.Fatalf("want exactly one cycle error, got %v", res.Errors)
	}
	if res.Errors[0].Path != "/a/self" {
		t.Fatalf("cycle reported at %q, want /a/self", res.Errors[0].Path)
	}
	want := []string{"/a", "/a/f.txt"}
	if got := entryPaths(res); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("entries=%v, want %v", got, want)
	}
}

func TestNoFollowSymlinks(t *testing.T) {
	f := newFakeFS()
	f.dir("/r", treewalk.Identity{Dev: 1, Ino: 1}, "l", "real")
	f.link("/r/l", "/target")
	f.dir("/target", treewalk.Identity{Dev: 1, Ino: 2}, "hidden")
	f.file("/target/hidden", 9)
	f.file("/r/real", 1)

	res := treewalk.Walk(context.Background(), "/r",
		treewalk.Options{FollowSymlinks: false, MaxOpen: 2}, f)
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	var linkSeen bool
	for _, e := range res.Entries {
		if e.Path == "/r/l" {
			linkSeen = true
			if !e.Info.IsSymlink {
				t.Fatal("symlink entry not marked as symlink")
			}
		}
		if e.Path == "/r/l/hidden" {
			t.Fatal("traversed into symlink with FollowSymlinks=false")
		}
	}
	if !linkSeen {
		t.Fatal("symlink entry missing")
	}
}

func TestErrorsCollectedByPath(t *testing.T) {
	f := newFakeFS()
	f.dir("/r", treewalk.Identity{Dev: 1, Ino: 1}, "ok", "ghost")
	f.file("/r/ok", 1)
	f.lstatErr["/r/ghost"] = errors.New("permission denied")

	res := treewalk.Walk(context.Background(), "/r",
		treewalk.Options{MaxOpen: 2}, f)
	if len(res.Errors) != 1 {
		t.Fatalf("want 1 error, got %v", res.Errors)
	}
	if res.Errors[0].Path != "/r/ghost" || res.Errors[0].Op != "lstat" {
		t.Fatalf("error not attributed to path: %+v", res.Errors[0])
	}
	// Walk continues past the error.
	if got := entryPaths(res); fmt.Sprint(got) != fmt.Sprint([]string{"/r", "/r/ok"}) {
		t.Fatalf("entries=%v", got)
	}
}

func TestCancelClosesAllHandles(t *testing.T) {
	f := newFakeFS()
	f.readDelay = 20 * time.Millisecond
	var build func(path string, depth int)
	build = func(path string, depth int) {
		if depth == 0 {
			return
		}
		var kids []string
		for i := 0; i < 3; i++ {
			kids = append(kids, fmt.Sprintf("d%d", i))
		}
		f.dir(path, treewalk.Identity{Dev: 1, Ino: f.nextIno}, kids...)
		for _, k := range kids {
			build(path+"/"+k, depth-1)
		}
	}
	build("/r", 6)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan treewalk.Result, 1)
	go func() {
		done <- treewalk.Walk(ctx, "/r", treewalk.Options{MaxOpen: 4}, f)
	}()
	time.Sleep(50 * time.Millisecond) // let some handles be mid-read
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("walk did not return after cancellation")
	}
	open, _, opened, closed := f.stats()
	if open != 0 || opened != closed {
		t.Fatalf("cancel leaked handles: open=%d opened=%d closed=%d", open, opened, closed)
	}
}

func TestRealFilesystem(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Mkdir(filepath.Join(root, "sub"), 0o755))
	must(os.WriteFile(filepath.Join(root, "sub", "a.txt"), []byte("hi"), 0o644))
	must(os.WriteFile(filepath.Join(root, "top.txt"), []byte("yo"), 0o644))
	// Symlink loop: root/loop -> root, and a dangling link.
	must(os.Symlink(root, filepath.Join(root, "loop")))
	must(os.Symlink(filepath.Join(root, "missing"), filepath.Join(root, "dangling")))

	res := treewalk.Walk(context.Background(), root,
		treewalk.Options{FollowSymlinks: true, MaxOpen: 4}, treewalk.OSAdapter{})

	var cycle, dangling bool
	for _, e := range res.Errors {
		switch {
		case errors.Is(e.Err, treewalk.ErrCycle) && e.Path == filepath.Join(root, "loop"):
			cycle = true
		case e.Path == filepath.Join(root, "dangling") && e.Op == "stat":
			dangling = true
		default:
			t.Fatalf("unexpected error: %v", e)
		}
	}
	if !cycle {
		t.Fatal("real symlink loop not detected by identity")
	}
	if !dangling {
		t.Fatal("dangling symlink error not collected by path")
	}
	paths := entryPaths(res)
	for _, want := range []string{
		root,
		filepath.Join(root, "sub"),
		filepath.Join(root, "sub", "a.txt"),
		filepath.Join(root, "top.txt"),
	} {
		found := false
		for _, p := range paths {
			if p == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing entry %q in %v", want, paths)
		}
	}
}
