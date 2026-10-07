package dirwalk

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
)

// fakeNode is one node in an in-memory filesystem.
type fakeNode struct {
	id       FileID
	typ      EntryType
	target   string               // symlink target (absolute fake path)
	children map[string]*fakeNode // dirs only, keyed by base name
}

// fakeFS is an injectable Adapter used to verify link-cycle detection and
// handle-budget conservation. It tracks the number of simultaneously open
// handles and the open/close balance.
type fakeFS struct {
	mu        sync.Mutex
	nodes     map[string]*fakeNode
	nextIno   uint64
	open      int              // currently open handles
	maxOpen   int              // high-water mark
	opens     int              // total OpenDir calls
	closes    int              // total Close calls
	openErr   map[string]error // paths whose OpenDir fails
	blockRead chan struct{}    // if non-nil, ReadDir blocks until closed or ctx done
}

func newFakeFS() *fakeFS {
	f := &fakeFS{nodes: map[string]*fakeNode{}, openErr: map[string]error{}, nextIno: 1}
	f.nodes["/"] = &fakeNode{id: f.alloc(), typ: TypeDir, children: map[string]*fakeNode{}}
	return f
}

func (f *fakeFS) alloc() FileID {
	ino := f.nextIno
	f.nextIno++
	return FileID{Dev: 1, Ino: ino}
}

func (f *fakeFS) mkdir(p string) {
	f.add(p, &fakeNode{typ: TypeDir, children: map[string]*fakeNode{}})
}

func (f *fakeFS) mkfile(p string) {
	f.add(p, &fakeNode{typ: TypeFile})
}

func (f *fakeFS) symlink(p, target string) {
	f.add(p, &fakeNode{typ: TypeSymlink, target: target})
}

func (f *fakeFS) add(p string, n *fakeNode) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n.id = f.alloc()
	parent, ok := f.nodes[path.Dir(p)]
	if !ok {
		panic("missing parent for " + p)
	}
	parent.children[path.Base(p)] = n
	f.nodes[p] = n
}

// resolve follows symlinks (absolute targets) and returns the final node.
func (f *fakeFS) resolve(p string) (*fakeNode, error) {
	for depth := 0; depth < 40; depth++ {
		n, ok := f.nodes[p]
		if !ok {
			return nil, fmt.Errorf("no such file or directory: %s", p)
		}
		if n.typ != TypeSymlink {
			return n, nil
		}
		p = n.target
	}
	return nil, fmt.Errorf("too many levels of symbolic links: %s", p)
}

func (f *fakeFS) OpenDir(ctx context.Context, p string) (Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err, ok := f.openErr[p]; ok {
		return nil, err
	}
	n, err := f.resolve(p)
	if err != nil {
		return nil, err
	}
	if n.typ != TypeDir {
		return nil, fmt.Errorf("not a directory: %s", p)
	}
	f.open++
	f.opens++
	if f.open > f.maxOpen {
		f.maxOpen = f.open
	}
	return n, nil
}

func (f *fakeFS) ReadDir(ctx context.Context, h Handle) ([]Entry, error) {
	if f.blockRead != nil {
		select {
		case <-f.blockRead:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	n := h.(*fakeNode)
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Entry, 0, len(n.children))
	for name, c := range n.children {
		out = append(out, Entry{Name: name, Type: c.typ, ID: c.id})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *fakeFS) Stat(ctx context.Context, p string) (Entry, error) {
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	n, err := f.resolve(p)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Name: path.Base(p), Type: n.typ, ID: n.id}, nil
}

func (f *fakeFS) Close(h Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.open--
	f.closes++
	if f.open < 0 {
		panic("close without open")
	}
	return nil
}

func (f *fakeFS) stats() (open, maxOpen, opens, closes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.open, f.maxOpen, f.opens, f.closes
}

var errInjected = errors.New("injected failure")

// pathsOf flattens result entries to a path set for assertions.
func pathsOf(res *Result) map[string]EntryType {
	m := make(map[string]EntryType, len(res.Entries))
	for _, r := range res.Entries {
		m[r.Path] = r.Type
	}
	return m
}

func hasPathPrefix(res *Result, prefix string) bool {
	for _, r := range res.Entries {
		if strings.HasPrefix(r.Path, prefix) {
			return true
		}
	}
	return false
}
