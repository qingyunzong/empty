package dualidx

import (
	"encoding/gob"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	currentFile = "CURRENT"
	contentFile = "content.gob"
	pathFile    = "path.gob"
)

// ErrEmpty is returned by Acquire when no generation has been published yet.
var ErrEmpty = errors.New("dualidx: no generation published")

// ErrClosed is returned when operating on a closed store.
var ErrClosed = errors.New("dualidx: store closed")

// generation is an immutable, self-consistent snapshot of both indexes.
type generation struct {
	id      uint64
	dir     string
	content *ContentIndex
	paths   *PathIndex

	refs    atomic.Int64
	retired atomic.Bool
}

// Store owns the on-disk generations and the currently published one.
type Store struct {
	dir    string
	faults *FaultInjector

	mu      sync.Mutex
	current *generation
	retired map[uint64]*generation
	closed  bool
}

// OpenStore opens (creating if needed) the store rooted at dir. If a
// generation was previously published, it is loaded back from disk.
// A nil faults injector means fault injection is disabled.
func OpenStore(dir string, faults *FaultInjector) (*Store, error) {
	if faults == nil {
		faults = NewFaultInjector()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, faults: faults, retired: make(map[uint64]*generation)}

	data, err := os.ReadFile(filepath.Join(dir, currentFile))
	switch {
	case err == nil:
		id, perr := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if perr != nil {
			return nil, fmt.Errorf("dualidx: corrupt %s: %w", currentFile, perr)
		}
		gen, lerr := s.loadGeneration(id)
		if lerr != nil {
			return nil, lerr
		}
		s.current = gen
	case errors.Is(err, fs.ErrNotExist):
	default:
		return nil, err
	}
	return s, nil
}

// Close marks the store closed. Views already acquired remain usable.
func (s *Store) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}

// Generation returns the ID of the currently published generation,
// or 0 if none has been published.
func (s *Store) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil {
		return 0
	}
	return s.current.id
}

// Rebuild scans srcDir, builds both indexes from the same snapshot, and
// publishes them as a new generation. On any failure (including injected
// ones) the previously published generation stays current and the partial
// new generation is removed from disk.
func (s *Store) Rebuild(srcDir string) error {
	content, paths, err := buildIndexes(srcDir)
	if err != nil {
		return err
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrClosed
	}
	next := uint64(1)
	if s.current != nil {
		next = s.current.id + 1
	}
	for id := range s.retired {
		if id >= next {
			next = id + 1
		}
	}
	s.mu.Unlock()

	genDir := filepath.Join(s.dir, genDirName(next))
	if err := os.MkdirAll(genDir, 0o755); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			os.RemoveAll(genDir)
		}
	}()

	// Persistence point 1: content index.
	if err := s.faults.checkPersistContent(); err != nil {
		return err
	}
	if err := writeGob(filepath.Join(genDir, contentFile), content); err != nil {
		return err
	}

	// Persistence point 2: path index.
	if err := s.faults.checkPersistPath(); err != nil {
		return err
	}
	if err := writeGob(filepath.Join(genDir, pathFile), paths); err != nil {
		return err
	}

	// Publish point: atomically swing CURRENT to the new generation.
	if err := s.faults.checkPublish(); err != nil {
		return err
	}
	if err := s.publish(next); err != nil {
		return err
	}

	gen := &generation{id: next, dir: genDir, content: content, paths: paths}
	s.mu.Lock()
	old := s.current
	s.current = gen
	if old != nil {
		old.retired.Store(true)
		s.retired[old.id] = old
	}
	s.mu.Unlock()
	if old != nil {
		s.sweep(old)
	}
	committed = true
	return nil
}

// Acquire pins the current generation and returns a read-only View of it.
// The caller must Close the view; the generation's files are kept on disk
// until every view of it has been closed.
func (s *Store) Acquire() (*View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	if s.current == nil {
		return nil, ErrEmpty
	}
	s.current.refs.Add(1)
	return &View{store: s, gen: s.current}, nil
}

// sweep removes a retired generation's files once no reader references it.
func (s *Store) sweep(gen *generation) {
	s.mu.Lock()
	_, pending := s.retired[gen.id]
	if pending && gen.refs.Load() == 0 {
		delete(s.retired, gen.id)
		os.RemoveAll(gen.dir)
	}
	s.mu.Unlock()
}

// publish atomically replaces the CURRENT pointer file via write+rename.
func (s *Store) publish(id uint64) error {
	tmp := filepath.Join(s.dir, currentFile+".tmp")
	data := []byte(strconv.FormatUint(id, 10) + "\n")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, currentFile))
}

func (s *Store) loadGeneration(id uint64) (*generation, error) {
	genDir := filepath.Join(s.dir, genDirName(id))
	content := &ContentIndex{}
	if err := readGob(filepath.Join(genDir, contentFile), content); err != nil {
		return nil, err
	}
	paths := &PathIndex{}
	if err := readGob(filepath.Join(genDir, pathFile), paths); err != nil {
		return nil, err
	}
	return &generation{id: id, dir: genDir, content: content, paths: paths}, nil
}

func genDirName(id uint64) string { return fmt.Sprintf("gen-%06d", id) }

func writeGob(path string, v any) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(f).Encode(v); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func readGob(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return gob.NewDecoder(f).Decode(v)
}

// View is a pinned, read-only snapshot of one generation. Both indexes in
// a view always belong to the same generation.
type View struct {
	store *Store
	gen   *generation
	once  sync.Once
}

// Generation returns the generation ID this view is pinned to.
func (v *View) Generation() uint64 { return v.gen.id }

// Search returns the sorted source-relative paths of all documents
// containing term (case-insensitive) in this generation.
func (v *View) Search(term string) []string {
	ids := v.gen.content.Postings[strings.ToLower(term)]
	paths := make([]string, 0, len(ids))
	for _, id := range ids {
		paths = append(paths, v.gen.paths.IDToPath[id])
	}
	sort.Strings(paths)
	return paths
}

// Lookup reports whether path is indexed in this generation, and its ID.
func (v *View) Lookup(path string) (uint64, bool) {
	id, ok := v.gen.paths.PathToID[path]
	return id, ok
}

// Paths returns all indexed paths in this generation, sorted.
func (v *View) Paths() []string {
	paths := make([]string, 0, len(v.gen.paths.PathToID))
	for p := range v.gen.paths.PathToID {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

// Close releases the view. If its generation was retired and this was the
// last reference, the generation's files are deleted.
func (v *View) Close() error {
	v.once.Do(func() {
		v.gen.refs.Add(-1)
		v.store.sweep(v.gen)
	})
	return nil
}
