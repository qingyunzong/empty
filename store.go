// Package dualindex maintains a content index and a path index over a set of
// documents and publishes both atomically as a single generation. Readers
// acquire a snapshot of one generation and therefore always observe the
// content index and the path index from the same build. A failed build keeps
// the previously published generation; retired generations are deleted only
// after their last reader has released them.
package dualindex

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const (
	docsFile    = "docs.gob"
	contentFile = "content.gob"
	pathFile    = "path.gob"
	currentFile = "current"
)

// File is a single document in an update batch.
type File struct {
	Path    string
	Content []byte
}

// Batch describes one incremental update to the document set.
type Batch struct {
	Put    []File
	Delete []string
}

// generation is one immutable, self-contained build of the store.
type generation struct {
	num     int
	dir     string
	docs    map[string][]byte
	content *contentIndex
	path    *pathIndex
	refs    int
}

func generationDirName(num int) string {
	return fmt.Sprintf("gen-%06d", num)
}

// Store owns the on-disk generations and the currently published pointer.
// Open assumes exclusive access to the directory.
type Store struct {
	dir string

	// Faults injects failures at the index persistence points and at publish.
	Faults Faults

	mu      sync.Mutex
	docs    map[string][]byte
	current *generation
	retired []*generation
	nextGen int
}

// Open opens (or initializes) the store rooted at dir. If a generation was
// previously published it is reloaded; leftover directories from failed or
// superseded builds are removed.
func Open(dir string) (*Store, error) {
	gensDir := filepath.Join(dir, "generations")
	if err := os.MkdirAll(gensDir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, docs: make(map[string][]byte), nextGen: 1}
	s.current = &generation{
		num:     0,
		docs:    make(map[string][]byte),
		content: &contentIndex{Gen: 0, Terms: make(map[string][]string)},
		path:    &pathIndex{Gen: 0, Paths: make(map[string]PathEntry)},
	}

	data, err := os.ReadFile(filepath.Join(dir, currentFile))
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("dualindex: read current generation: %w", err)
	}
	num, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return nil, fmt.Errorf("dualindex: corrupt current generation file: %w", err)
	}
	g, err := s.loadGeneration(num)
	if err != nil {
		return nil, err
	}
	s.current = g
	s.docs = g.docs
	s.nextGen = num + 1

	entries, err := os.ReadDir(gensDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() && e.Name() != generationDirName(num) {
			os.RemoveAll(filepath.Join(gensDir, e.Name()))
		}
	}
	os.Remove(filepath.Join(dir, currentFile+".tmp"))
	return s, nil
}

func (s *Store) loadGeneration(num int) (*generation, error) {
	dir := filepath.Join(s.dir, "generations", generationDirName(num))
	var docs map[string][]byte
	var ci contentIndex
	var pi pathIndex
	if err := readGob(filepath.Join(dir, docsFile), &docs); err != nil {
		return nil, fmt.Errorf("dualindex: load generation %d docs: %w", num, err)
	}
	if err := readGob(filepath.Join(dir, contentFile), &ci); err != nil {
		return nil, fmt.Errorf("dualindex: load generation %d content index: %w", num, err)
	}
	if err := readGob(filepath.Join(dir, pathFile), &pi); err != nil {
		return nil, fmt.Errorf("dualindex: load generation %d path index: %w", num, err)
	}
	if ci.Gen != num || pi.Gen != num {
		return nil, fmt.Errorf("dualindex: generation %d index mismatch (content=%d path=%d)",
			num, ci.Gen, pi.Gen)
	}
	return &generation{num: num, dir: dir, docs: docs, content: &ci, path: &pi}, nil
}

// Update applies b to the current document set, builds and persists both
// indexes as a new generation, and publishes it atomically. If any step
// fails, the previously published generation remains current and the
// half-built generation is removed.
func (s *Store) Update(b Batch) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	newDocs := make(map[string][]byte, len(s.docs)+len(b.Put))
	for p, c := range s.docs {
		newDocs[p] = c
	}
	for _, p := range b.Delete {
		delete(newDocs, p)
	}
	for _, f := range b.Put {
		c := make([]byte, len(f.Content))
		copy(c, f.Content)
		newDocs[f.Path] = c
	}

	num := s.nextGen
	s.nextGen++
	dir := filepath.Join(s.dir, "generations", generationDirName(num))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("dualindex: create generation %d: %w", num, err)
	}
	published := false
	defer func() {
		if !published {
			os.RemoveAll(dir)
		}
	}()

	ci, pi := buildIndexes(num, newDocs)

	if err := writeGobAtomic(filepath.Join(dir, docsFile), newDocs); err != nil {
		return fmt.Errorf("dualindex: persist generation %d docs: %w", num, err)
	}
	if err := s.Faults.inject(FaultPersistContent); err != nil {
		return err
	}
	if err := writeGobAtomic(filepath.Join(dir, contentFile), ci); err != nil {
		return fmt.Errorf("dualindex: persist generation %d content index: %w", num, err)
	}
	if err := s.Faults.inject(FaultPersistPath); err != nil {
		return err
	}
	if err := writeGobAtomic(filepath.Join(dir, pathFile), pi); err != nil {
		return fmt.Errorf("dualindex: persist generation %d path index: %w", num, err)
	}
	if err := s.Faults.inject(FaultPublish); err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(s.dir, currentFile), func(w io.Writer) error {
		_, err := io.WriteString(w, strconv.Itoa(num))
		return err
	}); err != nil {
		return fmt.Errorf("dualindex: publish generation %d: %w", num, err)
	}

	s.retired = append(s.retired, s.current)
	s.current = &generation{num: num, dir: dir, docs: newDocs, content: ci, path: pi}
	s.docs = newDocs
	published = true
	s.gcLocked()
	return nil
}

// gcLocked deletes retired generations that no reader references anymore.
func (s *Store) gcLocked() {
	kept := s.retired[:0]
	for _, g := range s.retired {
		if g.refs > 0 {
			kept = append(kept, g)
			continue
		}
		if g.dir != "" {
			os.RemoveAll(g.dir)
		}
	}
	s.retired = kept
}

// Gen returns the currently published generation number.
func (s *Store) Gen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current.num
}

// Query is a convenience wrapper around Acquire/Snapshot.Query.
func (s *Store) Query(term string) []string {
	sn := s.Acquire()
	defer sn.Close()
	return sn.Query(term)
}

// Stat is a convenience wrapper around Acquire/Snapshot.Stat.
func (s *Store) Stat(path string) (PathEntry, bool) {
	sn := s.Acquire()
	defer sn.Close()
	return sn.Stat(path)
}
