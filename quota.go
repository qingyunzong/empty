package formal

import (
	"fmt"
	"path"
	"strings"
	"sync"
)

// InodeID identifies an allocated inode.
type InodeID uint64

// Usage is the aggregate quota usage of a directory subtree.
//
// A directory's own inode is not part of its Usage. The values describe the
// entries below the directory, recursively. Directories have size zero in this
// model, while regular files have the size supplied at creation.
type Usage struct {
	Links  int64
	Inodes int64
	Bytes  int64
}

func (u Usage) String() string {
	return fmt.Sprintf("links=%d inodes=%d bytes=%d", u.Links, u.Inodes, u.Bytes)
}

type inodeKind uint8

const (
	kindFile inodeKind = iota
	kindDir
)

type inode struct {
	id    InodeID
	kind  inodeKind
	size  int64
	links int64

	// refs[d] is the number of links to this inode inside d's subtree. It has
	// an entry for every ancestor d of a directory containing a direct link to
	// the inode. Only positive counts are retained.
	refs map[*directory]int64

	// dir is set for directory inodes only.
	dir *directory
}

type directory struct {
	inode   *inode
	parent  *directory
	entries map[string]*inode
	usage   Usage
}

// FS is a concurrent-safe filesystem namespace with subtree quota accounting.
//
// All operations are serialized by a single lock. A rename is therefore an
// atomic transition as observed through this API: readers see either the
// state before the rename or the state after it, never a partially moved
// subtree.
type FS struct {
	mu sync.RWMutex

	root   *directory
	byID   map[InodeID]*inode
	nextID uint64

	inodeCount int64
	linkCount  int64
	byteCount  int64
}

// Quota is an alias for FS, emphasizing its use as a quota accounting engine.
type Quota = FS

// New returns an empty filesystem containing only the root directory.
func New() *FS {
	rootInode := &inode{
		id:   0,
		kind: kindDir,
		refs: make(map[*directory]int64),
	}
	root := &directory{
		inode:   rootInode,
		entries: make(map[string]*inode),
	}
	rootInode.dir = root

	return &FS{
		root:       root,
		byID:       map[InodeID]*inode{0: rootInode},
		nextID:     1,
		inodeCount: 1,
	}
}

// NewQuota is an alias for New.
func NewQuota() *Quota { return New() }

// RootUsage returns the maintained usage of the whole tree. Its Inodes count
// excludes the root directory inode, matching Usage's subtree semantics.
func (fs *FS) RootUsage() Usage {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.root.usage
}

// GlobalUsage returns live inode, link, and byte totals. Inodes includes the
// root inode.
func (fs *FS) GlobalUsage() Usage {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return Usage{Links: fs.linkCount, Inodes: fs.inodeCount, Bytes: fs.byteCount}
}

// InodeCount returns the number of live inodes, including the root inode.
func (fs *FS) InodeCount() int64 {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.inodeCount
}

// LinkCount returns the number of namespace entries in the whole tree.
func (fs *FS) LinkCount() int64 {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.linkCount
}

// ByteCount returns the sum of the sizes of all live inodes. Hard-linked
// inodes are counted once.
func (fs *FS) ByteCount() int64 {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.byteCount
}

func cleanPath(p string) (string, error) {
	if strings.IndexByte(p, 0) >= 0 {
		return "", fmt.Errorf("formal: invalid path %q", p)
	}
	if p == "" {
		return "/", nil
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return path.Clean(p), nil
}

func splitPath(p string) (parentPath, name string, err error) {
	p, err = cleanPath(p)
	if err != nil {
		return "", "", err
	}
	if p == "/" {
		return "", "", ErrRoot
	}
	return path.Dir(p), path.Base(p), nil
}

func (fs *FS) resolveDirLocked(p string) (*directory, error) {
	p, err := cleanPath(p)
	if err != nil {
		return nil, err
	}
	if p == "/" {
		return fs.root, nil
	}
	dir := fs.root
	for _, part := range strings.Split(strings.TrimPrefix(p, "/"), "/") {
		in, ok := dir.entries[part]
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrNotExist, p)
		}
		if in.kind != kindDir {
			return nil, fmt.Errorf("%w: %s", ErrNotDir, p)
		}
		dir = in.dir
	}
	return dir, nil
}

func (fs *FS) resolveEntryLocked(p string) (parent *directory, name string, in *inode, err error) {
	parentPath, name, err := splitPath(p)
	if err != nil {
		return nil, "", nil, err
	}
	parent, err = fs.resolveDirLocked(parentPath)
	if err != nil {
		return nil, "", nil, err
	}
	in, ok := parent.entries[name]
	if !ok {
		return nil, "", nil, fmt.Errorf("%w: %s", ErrNotExist, p)
	}
	return parent, name, in, nil
}
