// Package store implements a crash-safe page store with compaction.
//
// Pages are addressed externally by a stable page ID. A generation-scoped
// index maps page IDs to (segment, offset) locations; relocation during
// compaction and the reference update are published together as one
// generation. The atomic manifest rename is the only commit point, so a
// power loss always leaves either the old generation or the new generation
// fully intact.
package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ErrNotFound is returned by Get and Delete for unknown page IDs.
var ErrNotFound = errors.New("page not found")

// Hooks are fault-injection points fired at compaction boundaries. Tests
// use them to simulate power loss; production code passes nil.
type Hooks struct {
	AfterCopy          func() // live pages copied to the new segment, not yet durable
	AfterIndexFlush    func() // new index published, manifest not yet committed
	BeforeRetire       func() // new generation committed, old segments not yet retired
	AfterRetireSegment func(segment uint64)
}

// Options tune Store behaviour. Zero values pick defaults.
type Options struct {
	Hooks           *Hooks
	MaxSegmentBytes uint64 // rotate the active segment beyond this size
}

const defaultMaxSegmentBytes = 64 << 20

// Store is a single-directory page store.
type Store struct {
	dir        string
	generation uint64
	segments   map[uint64]bool // segments of the committed generation
	index      map[uint64]Location
	activeSeg  uint64
	nextSeg    uint64
	maxSeg     uint64
	hooks      Hooks
}

// Open opens (or creates) the store in dir and recovers from any interrupted
// operation by removing files that are not part of the committed generation.
func Open(dir string, opts *Options) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		dir:      dir,
		segments: map[uint64]bool{},
		index:    map[uint64]Location{},
		maxSeg:   defaultMaxSegmentBytes,
	}
	if opts != nil {
		if opts.Hooks != nil {
			s.hooks = *opts.Hooks
		}
		if opts.MaxSegmentBytes > 0 {
			s.maxSeg = opts.MaxSegmentBytes
		}
	}

	m, err := readManifest(dir)
	if err != nil {
		return nil, fmt.Errorf("load manifest: %w", err)
	}
	s.generation = m.Generation
	for _, id := range m.Segments {
		s.segments[id] = true
	}
	if m.Generation > 0 || len(m.Segments) > 0 {
		idx, err := readIndexFile(dir, m.Generation)
		if err != nil {
			return nil, fmt.Errorf("committed generation %d unreadable: %w", m.Generation, err)
		}
		s.index = idx
	}
	for _, id := range m.Segments {
		if _, err := os.Stat(segmentPath(dir, id)); err != nil {
			return nil, fmt.Errorf("committed generation %d misses segment %d: %w", m.Generation, id, err)
		}
	}
	if err := s.cleanupLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func segmentPath(dir string, id uint64) string {
	return filepath.Join(dir, fmt.Sprintf("seg-%020d.seg", id))
}

// cleanupLocked removes orphan segments, stale indexes and tmp files left
// behind by a crash, and derives segment numbering from what survives.
func (s *Store) cleanupLocked() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	var maxSeg uint64
	for _, e := range entries {
		name := e.Name()
		switch {
		case strings.HasPrefix(name, "seg-") && strings.HasSuffix(name, ".seg"):
			id, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(name, "seg-"), ".seg"), 10, 64)
			if err != nil {
				continue
			}
			if id > maxSeg {
				maxSeg = id
			}
			if !s.segments[id] {
				if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
					return err
				}
			}
		case strings.HasPrefix(name, "index-") && strings.HasSuffix(name, ".idx"):
			gen, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(name, "index-"), ".idx"), 10, 64)
			if err != nil {
				continue
			}
			if gen != s.generation {
				if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
					return err
				}
			}
		case strings.HasSuffix(name, ".tmp"):
			if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
				return err
			}
		}
	}
	s.nextSeg = maxSeg + 1
	s.activeSeg = maxSeg
	if !s.segments[s.activeSeg] {
		s.activeSeg = 0
	}
	return syncDir(s.dir)
}

// publish atomically moves the store to the next generation: the new index
// is flushed first, then the manifest rename commits index and segment set
// together.
func (s *Store) publish(index map[uint64]Location, segments []uint64) error {
	gen := s.generation + 1
	if err := writeIndexFile(s.dir, gen, index); err != nil {
		return err
	}
	if s.hooks.AfterIndexFlush != nil {
		s.hooks.AfterIndexFlush()
	}
	if err := writeManifest(s.dir, manifest{Generation: gen, Segments: segments}); err != nil {
		return err
	}
	oldGen := s.generation
	s.generation = gen
	s.index = index
	s.segments = map[uint64]bool{}
	s.activeSeg = 0
	for _, id := range segments {
		s.segments[id] = true
		if id > s.activeSeg {
			s.activeSeg = id
		}
	}
	if oldGen > 0 {
		// Stale index cleanup is best-effort: a crash here is recovered
		// by Open.
		_ = os.Remove(indexPath(s.dir, oldGen))
	}
	return nil
}

// sortedSegments returns the committed segment IDs in order.
func (s *Store) sortedSegments() []uint64 {
	ids := make([]uint64, 0, len(s.segments))
	for id := range s.segments {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// Put inserts or replaces a page and commits it in its own generation.
func (s *Store) Put(id uint64, payload []byte) error {
	if s.activeSeg == 0 || s.segmentSize(s.activeSeg) >= s.maxSeg {
		s.activeSeg = s.nextSeg
		s.nextSeg++
	}
	rec := encodeRecord(id, payload)
	path := segmentPath(s.dir, s.activeSeg)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	off, err := f.Seek(0, 2)
	if err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(rec); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()

	index := s.cloneIndex()
	index[id] = Location{Segment: s.activeSeg, Offset: uint64(off), Length: uint32(len(rec))}
	segments := s.sortedSegments()
	if !s.segments[s.activeSeg] {
		segments = append(segments, s.activeSeg)
	}
	return s.publish(index, segments)
}

// Get resolves the stable page ID through the current index and verifies the
// page checksum before returning the payload.
func (s *Store) Get(id uint64) ([]byte, error) {
	loc, ok := s.index[id]
	if !ok {
		return nil, ErrNotFound
	}
	f, err := os.Open(segmentPath(s.dir, loc.Segment))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	rid, payload, _, err := readRecordAt(f, loc.Offset)
	if err != nil {
		return nil, err
	}
	if rid != id {
		return nil, fmt.Errorf("index points at page %d, want %d", rid, id)
	}
	return payload, nil
}

// Delete removes a page and commits the removal in its own generation. The
// abandoned bytes stay in the segment until Compact reclaims them.
func (s *Store) Delete(id uint64) error {
	if _, ok := s.index[id]; !ok {
		return ErrNotFound
	}
	index := s.cloneIndex()
	delete(index, id)
	return s.publish(index, s.sortedSegments())
}

// List returns the live page IDs in ascending order.
func (s *Store) List() []uint64 {
	ids := make([]uint64, 0, len(s.index))
	for id := range s.index {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// Generation reports the currently committed generation.
func (s *Store) Generation() uint64 { return s.generation }

// Verify walks every committed segment record-by-record, checks each page
// checksum, and confirms the index matches the scanned locations exactly.
func (s *Store) Verify() error {
	scanned := map[uint64]Location{}
	for _, seg := range s.sortedSegments() {
		seg := seg
		err := scanSegment(segmentPath(s.dir, seg), func(id uint64, off uint64, total uint32) error {
			scanned[id] = Location{Segment: seg, Offset: off, Length: total}
			return nil
		})
		if err != nil {
			return err
		}
	}
	for id, loc := range s.index {
		got, ok := scanned[id]
		if !ok {
			return fmt.Errorf("index references page %d missing from segment %d", id, loc.Segment)
		}
		if got != loc {
			return fmt.Errorf("index location for page %d is %+v, segment holds %+v", id, loc, got)
		}
	}
	return nil
}

// Close releases resources. All commits are already durable, so Close only
// fsyncs the directory.
func (s *Store) Close() error { return syncDir(s.dir) }

func (s *Store) cloneIndex() map[uint64]Location {
	index := make(map[uint64]Location, len(s.index)+1)
	for id, loc := range s.index {
		index[id] = loc
	}
	return index
}

func (s *Store) segmentSize(id uint64) uint64 {
	fi, err := os.Stat(segmentPath(s.dir, id))
	if errors.Is(err, fs.ErrNotExist) {
		return 0
	}
	if err != nil {
		return 0
	}
	return uint64(fi.Size())
}
