package dirwalk

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
)

// Options controls a Walk.
type Options struct {
	// FollowSymlinks enables traversing symlinks that point to
	// directories. Cycles are detected by file identity, so a symlink
	// loop terminates instead of recursing forever.
	FollowSymlinks bool
	// MaxOpen bounds the number of directory handles open at any
	// instant. Values <= 0 select a default of 8.
	MaxOpen int
}

// Record describes one path discovered during a Walk.
type Record struct {
	Path string
	Type EntryType
}

// Result is the outcome of a Walk.
type Result struct {
	// Entries contains every discovered path, sorted by path.
	Entries []Record
	// Errors maps a path to the error encountered while processing it.
	// Per-path errors do not abort the walk of unrelated paths.
	Errors map[string]error
}

// Walk traverses the directory tree rooted at root using fs, and returns
// every discovered path. At most opts.MaxOpen directory handles are open
// at any moment. The root itself is always resolved with Stat (symlinks
// followed) and must be a directory.
//
// Per-path failures are collected in Result.Errors and the walk
// continues elsewhere. If ctx is canceled, in-flight reads stop, every
// open handle is closed, and Walk returns the context's error together
// with the partial Result.
func Walk(ctx context.Context, fs Adapter, root string, opts Options) (*Result, error) {
	if opts.MaxOpen <= 0 {
		opts.MaxOpen = 8
	}
	root = filepath.Clean(root)
	w := &walker{
		fs:      fs,
		opts:    opts,
		sem:     make(chan struct{}, opts.MaxOpen),
		visited: make(map[FileID]struct{}),
		res:     &Result{Errors: make(map[string]error)},
	}

	info, err := fs.Stat(ctx, root)
	if err != nil {
		w.recordErr(root, err)
		return w.finish(ctx)
	}
	if info.Type != TypeDir {
		w.recordErr(root, fmt.Errorf("not a directory: %s", root))
		return w.finish(ctx)
	}
	w.visited[info.ID] = struct{}{}
	w.addRecord(Record{Path: root, Type: TypeDir})

	w.wg.Add(1)
	go w.walkDir(ctx, root)
	w.wg.Wait()
	return w.finish(ctx)
}

type walker struct {
	fs   Adapter
	opts Options
	sem  chan struct{}
	wg   sync.WaitGroup

	mu      sync.Mutex
	visited map[FileID]struct{}
	res     *Result
}

func (w *walker) finish(ctx context.Context) (*Result, error) {
	w.mu.Lock()
	sort.Slice(w.res.Entries, func(i, j int) bool {
		return w.res.Entries[i].Path < w.res.Entries[j].Path
	})
	res := w.res
	w.mu.Unlock()
	return res, ctx.Err()
}

func (w *walker) addRecord(r Record) {
	w.mu.Lock()
	w.res.Entries = append(w.res.Entries, r)
	w.mu.Unlock()
}

func (w *walker) recordErr(path string, err error) {
	if err == nil {
		return
	}
	w.mu.Lock()
	if _, ok := w.res.Errors[path]; !ok {
		w.res.Errors[path] = err
	}
	w.mu.Unlock()
}

// markVisited reports whether id was not seen before, and records it.
func (w *walker) markVisited(id FileID) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.visited[id]; ok {
		return false
	}
	w.visited[id] = struct{}{}
	return true
}

func (w *walker) walkDir(ctx context.Context, path string) {
	defer w.wg.Done()

	select {
	case w.sem <- struct{}{}:
	case <-ctx.Done():
		return
	}

	h, err := w.fs.OpenDir(ctx, path)
	if err != nil {
		<-w.sem
		w.recordErr(path, err)
		return
	}
	// Close the handle before releasing budget, so the semaphore never
	// undercounts live handles. Runs even on cancellation.
	defer func() {
		if cerr := w.fs.Close(h); cerr != nil {
			w.recordErr(path, cerr)
		}
		<-w.sem
	}()

	entries, err := w.fs.ReadDir(ctx, h)
	if err != nil {
		w.recordErr(path, err)
		return
	}
	for _, e := range entries {
		child := filepath.Join(path, e.Name)
		w.addRecord(Record{Path: child, Type: e.Type})
		switch e.Type {
		case TypeDir:
			w.descend(ctx, child, e.ID)
		case TypeSymlink:
			if !w.opts.FollowSymlinks {
				continue
			}
			target, err := w.fs.Stat(ctx, child)
			if err != nil {
				w.recordErr(child, err)
				continue
			}
			if target.Type == TypeDir {
				w.descend(ctx, child, target.ID)
			}
		}
	}
}

// descend schedules traversal of path, which has identity id, unless
// that identity is already being (or has been) traversed. Identity-based
// dedup is what breaks symlink cycles and bind-mount loops.
func (w *walker) descend(ctx context.Context, path string, id FileID) {
	if !w.markVisited(id) {
		return
	}
	w.wg.Add(1)
	go w.walkDir(ctx, path)
}
