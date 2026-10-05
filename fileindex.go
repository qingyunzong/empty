// Package fileindex implements a file index cache whose entries are
// identified by path and generation. Asynchronous scan results are only
// published when every baseline captured at scan start is still valid,
// so stale results produced across a delete+recreate of the same path
// are rejected.
package fileindex

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Generation identifies one observed state of a path. It is bumped every
// time the cache observes the path's on-disk signature change.
type Generation uint64

// Entry is a single indexed path.
type Entry struct {
	Path       string
	Generation Generation
	Size       int64
	ModTime    time.Time
	IsDir      bool
}

// fileSig is the on-disk signature of a path at some moment.
type fileSig struct {
	size    int64
	modTime time.Time
	isDir   bool
}

func sigOf(info os.FileInfo) fileSig {
	return fileSig{size: info.Size(), modTime: info.ModTime(), isDir: info.IsDir()}
}

func (s fileSig) matches(e Entry) bool {
	return e.Size == s.size && e.ModTime.Equal(s.modTime) && e.IsDir == s.isDir
}

// Cache is a concurrent-safe file index. Entries are keyed by absolute
// path; each entry carries the generation of its last observed change.
// Every registered root directory also carries a version that is bumped
// whenever any entry beneath it changes, so concurrent mutations are
// detectable even for paths a scan never baselined.
type Cache struct {
	mu      sync.Mutex
	entries map[string]Entry
	roots   map[string]uint64
	nextGen Generation
}

func NewCache() *Cache {
	return &Cache{entries: make(map[string]Entry), roots: make(map[string]uint64)}
}

func normDir(dir string) string {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return filepath.Clean(dir)
	}
	return abs
}

func underDir(path, dir string) bool {
	return path == dir || strings.HasPrefix(path, dir+string(os.PathSeparator))
}

func underAnyRoot(path string, roots []string) bool {
	for _, root := range roots {
		if underDir(path, root) {
			return true
		}
	}
	return false
}

func (c *Cache) registerRootsLocked(dirs []string) []string {
	roots := make([]string, 0, len(dirs))
	seen := make(map[string]bool, len(dirs))
	for _, dir := range dirs {
		root := normDir(dir)
		if seen[root] {
			continue
		}
		seen[root] = true
		roots = append(roots, root)
		if _, ok := c.roots[root]; !ok {
			c.roots[root] = 0
		}
	}
	sort.Strings(roots)
	return roots
}

func (c *Cache) bumpRootsLocked(path string) {
	for root := range c.roots {
		if underDir(path, root) {
			c.roots[root]++
		}
	}
}

// setLocked records the observed signature for path, assigning a new
// generation when the signature differs from the cached entry.
func (c *Cache) setLocked(path string, sig fileSig) {
	if e, ok := c.entries[path]; ok && sig.matches(e) {
		return
	}
	c.nextGen++
	c.entries[path] = Entry{
		Path:       path,
		Generation: c.nextGen,
		Size:       sig.size,
		ModTime:    sig.modTime,
		IsDir:      sig.isDir,
	}
	c.bumpRootsLocked(path)
}

func (c *Cache) removeLocked(path string) {
	if _, ok := c.entries[path]; !ok {
		return
	}
	delete(c.entries, path)
	c.bumpRootsLocked(path)
}

func (c *Cache) snapshotLocked(roots []string) []Entry {
	var out []Entry
	for path, e := range c.entries {
		if underAnyRoot(path, roots) {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// collect walks dirs and returns the observed on-disk signatures keyed by
// absolute path. It never touches the cache.
func collect(dirs []string) (map[string]fileSig, error) {
	observed := make(map[string]fileSig)
	for _, dir := range dirs {
		root := normDir(dir)
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			observed[path] = sigOf(info)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return observed, nil
}

// applyLocked merges observed signatures into the cache and removes
// entries under roots that no longer exist on disk.
func (c *Cache) applyLocked(roots []string, observed map[string]fileSig) {
	for path, sig := range observed {
		c.setLocked(path, sig)
	}
	for path := range c.entries {
		if underAnyRoot(path, roots) {
			if _, ok := observed[path]; !ok {
				c.removeLocked(path)
			}
		}
	}
}

// Rescan synchronously walks dirs, applies the result to the cache, and
// returns the resulting entries under dirs. It is the reference
// implementation that asynchronous scans are validated against.
func (c *Cache) Rescan(dirs ...string) ([]Entry, error) {
	observed, err := collect(dirs)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	roots := c.registerRootsLocked(dirs)
	c.applyLocked(roots, observed)
	return c.snapshotLocked(roots), nil
}

// Snapshot returns the current entries under dirs without touching disk.
func (c *Cache) Snapshot(dirs ...string) []Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	roots := c.registerRootsLocked(dirs)
	return c.snapshotLocked(roots)
}

// Scan is an in-flight asynchronous scan over one or more directories.
// Its baseline is every entry generation and root version captured at
// Begin; Publish refuses to apply results unless all of them are still
// valid, so a delete+recreate of any scanned path in between — observed
// by the cache through a concurrent rescan — rejects the whole publish.
type Scan struct {
	cache    *Cache
	roots    []string
	baseline map[string]Generation
	versions map[string]uint64
	observed map[string]fileSig

	// BeforePublish, if non-nil, runs after Collect and before Publish
	// validates the baseline. It is a test hook used to interleave a
	// concurrent mutation deterministically.
	BeforePublish func()
}

// Begin starts an asynchronous scan over dirs and captures the baseline.
func (c *Cache) Begin(dirs ...string) *Scan {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := &Scan{
		cache:    c,
		baseline: make(map[string]Generation),
		versions: make(map[string]uint64),
	}
	s.roots = c.registerRootsLocked(dirs)
	for _, root := range s.roots {
		s.versions[root] = c.roots[root]
	}
	for path, e := range c.entries {
		if underAnyRoot(path, s.roots) {
			s.baseline[path] = e.Generation
		}
	}
	return s
}

// Collect walks the scan's directories and records what is on disk.
func (s *Scan) Collect() error {
	observed, err := collect(s.roots)
	if err != nil {
		return err
	}
	s.observed = observed
	return nil
}

// validLocked reports whether every baseline captured at Begin is still
// valid: all root versions unchanged, and every baselined path still
// present with the same generation.
func (s *Scan) validLocked() bool {
	for root, v := range s.versions {
		if s.cache.roots[root] != v {
			return false
		}
	}
	for path, gen := range s.baseline {
		e, ok := s.cache.entries[path]
		if !ok || e.Generation != gen {
			return false
		}
	}
	return true
}

// Publish applies the collected results only if the entire baseline is
// still valid. It reports whether the results were published.
func (s *Scan) Publish() bool {
	if s.BeforePublish != nil {
		s.BeforePublish()
	}
	c := s.cache
	c.mu.Lock()
	defer c.mu.Unlock()
	if !s.validLocked() {
		return false
	}
	c.applyLocked(s.roots, s.observed)
	return true
}
