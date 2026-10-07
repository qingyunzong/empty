// Package treewalk provides concurrent directory traversal with a bounded
// number of simultaneously open directory handles, optional symlink
// following, and cycle detection based on file identity (device + inode)
// rather than path strings.
package treewalk

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
)

// ErrCycle is reported (wrapped in Error.Err) when traversal reaches a
// directory whose file identity was already visited, e.g. through a
// symlink loop or a bind mount.
var ErrCycle = errors.New("treewalk: directory cycle detected")

// Identity uniquely identifies a file on the system, typically the
// (device, inode) pair. Two paths with the same Identity refer to the
// same underlying file.
type Identity struct {
	Dev uint64
	Ino uint64
}

// FileInfo describes a single filesystem node.
type FileInfo struct {
	ID        Identity
	IsDir     bool
	IsSymlink bool
	Size      int64
}

// DirHandle is an open directory. ReadDir returns the names of all
// entries in the directory (without path separators). Close releases the
// underlying OS handle.
type DirHandle interface {
	ReadDir() ([]string, error)
	Close() error
}

// Adapter abstracts the filesystem so tests can inject fakes. All
// methods must be safe for concurrent use.
type Adapter interface {
	// Lstat returns info about path without following a final symlink.
	Lstat(path string) (FileInfo, error)
	// Stat returns info about path, resolving symlinks.
	Stat(path string) (FileInfo, error)
	// Open opens a directory for reading.
	Open(path string) (DirHandle, error)
}

// Options controls traversal behavior.
type Options struct {
	// FollowSymlinks enables resolving and descending into symlinked
	// directories. Cycles are detected by file identity.
	FollowSymlinks bool
	// MaxOpen bounds the number of directory handles open at once.
	// Values <= 0 select a default of 16.
	MaxOpen int
}

// Entry is a visited filesystem node.
type Entry struct {
	Path string
	Info FileInfo
}

// Error associates a failure with the path that caused it.
type Error struct {
	Path string
	Op   string
	Err  error
}

func (e Error) Error() string { return e.Op + " " + e.Path + ": " + e.Err.Error() }
func (e Error) Unwrap() error { return e.Err }

// Result aggregates everything a walk produced. Entry order is
// nondeterministic because traversal is concurrent.
type Result struct {
	Entries []Entry
	Errors  []Error
}

// Walk traverses the tree rooted at root concurrently, using at most
// opts.MaxOpen simultaneously open directory handles. It collects every
// entry and per-path error, and returns promptly when ctx is canceled,
// closing every handle it opened.
func Walk(ctx context.Context, root string, opts Options, a Adapter) Result {
	k := opts.MaxOpen
	if k <= 0 {
		k = 16
	}
	w := &walker{
		ctx:     ctx,
		a:       a,
		follow:  opts.FollowSymlinks,
		visited: make(map[Identity]struct{}),
	}
	return w.run(root, k)
}

type walker struct {
	ctx    context.Context
	a      Adapter
	follow bool

	mu      sync.Mutex
	visited map[Identity]struct{}
	entries []Entry
	errs    []Error
}

func (w *walker) run(root string, workers int) Result {
	tasks := make(chan string)
	quit := w.ctx.Done()
	var pending sync.WaitGroup

	// submit hands a path to the worker pool. Sends happen in a
	// goroutine so a worker never deadlocks submitting children while
	// all workers are busy; on cancellation the task is dropped.
	var submit func(string)
	submit = func(p string) {
		pending.Add(1)
		go func() {
			select {
			case tasks <- p:
			case <-quit:
				pending.Done()
			}
		}()
	}

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range tasks {
				w.process(p, submit)
				pending.Done()
			}
		}()
	}
	// Submit the root before starting the closer so the pending count
	// is non-zero when the closer begins waiting; every subsequent
	// submit calls Add (from within process) before the worker's Done,
	// so the count can never reach zero while work remains.
	submit(root)
	go func() {
		pending.Wait()
		close(tasks)
	}()
	wg.Wait()

	w.mu.Lock()
	defer w.mu.Unlock()
	return Result{Entries: w.entries, Errors: w.errs}
}

// process handles one path. A worker opens at most one handle at a time
// and always closes it before returning, so with K workers no more than
// K handles are ever open concurrently.
func (w *walker) process(p string, submit func(string)) {
	if w.ctx.Err() != nil {
		return
	}
	info, err := w.a.Lstat(p)
	if err != nil {
		w.addErr(p, "lstat", err)
		return
	}
	resolved := info
	if info.IsSymlink {
		if !w.follow {
			w.addEntry(Entry{Path: p, Info: info})
			return
		}
		resolved, err = w.a.Stat(p)
		if err != nil {
			w.addErr(p, "stat", err)
			return
		}
	}
	if !resolved.IsDir {
		w.addEntry(Entry{Path: p, Info: resolved})
		return
	}
	if !w.mark(resolved.ID) {
		w.addErr(p, "open", ErrCycle)
		return
	}
	h, err := w.a.Open(p)
	if err != nil {
		w.addErr(p, "open", err)
		return
	}
	names, rerr := h.ReadDir()
	cerr := h.Close()
	if rerr != nil {
		w.addErr(p, "readdir", rerr)
	}
	if cerr != nil {
		w.addErr(p, "close", cerr)
	}
	w.addEntry(Entry{Path: p, Info: resolved})
	for _, name := range names {
		submit(filepath.Join(p, name))
	}
}

// mark records a directory identity, reporting false if it was already
// visited (a cycle).
func (w *walker) mark(id Identity) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.visited[id]; ok {
		return false
	}
	w.visited[id] = struct{}{}
	return true
}

func (w *walker) addEntry(e Entry) {
	w.mu.Lock()
	w.entries = append(w.entries, e)
	w.mu.Unlock()
}

func (w *walker) addErr(path, op string, err error) {
	w.mu.Lock()
	w.errs = append(w.errs, Error{Path: path, Op: op, Err: err})
	w.mu.Unlock()
}
