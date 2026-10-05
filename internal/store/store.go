// Package store implements a crash-safe page store with generational
// compaction. External references use stable page IDs; the index resolves
// them to physical locations for the currently committed generation.
//
// Durability protocol (single atomic publish point):
//  1. Puts append a checksummed record to the active segment and an entry
//     to the current generation's index log; both are fsynced.
//  2. Compaction copies live pages into a new segment, flushes a new index
//     log for generation G+1, then publishes both by atomically renaming a
//     new COMMIT record into place. Only after the commit are obsolete
//     segments retired.
//  3. Recovery trusts exactly one generation: the one named by COMMIT.
//     Everything else (uncommitted segments, stale index logs, temp files)
//     is reclaimed. A crash therefore leaves either the old or the new
//     references fully intact, never a mix.
package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	commitFileName = "COMMIT"
	commitTmpName  = "COMMIT.tmp"
	segFilePrefix  = "seg-"
	segFileSuffix  = ".dat"
)

// Store is a page store rooted at a directory.
type Store struct {
	dir        string
	generation uint64
	index      map[uint64]Location

	activeSeg   *os.File
	activeSegID uint64
	activeOff   uint64
	nextSegID   uint64

	indexLog *os.File
	faults   *FaultInjector
}

// Option configures Open.
type Option func(*Store)

// WithFaultInjector installs a crash-injection hook (tests only).
func WithFaultInjector(f *FaultInjector) Option {
	return func(s *Store) { s.faults = f }
}

// Generation returns the currently committed generation.
func (s *Store) Generation() uint64 { return s.generation }

// Open opens (or creates) the store in dir and runs crash recovery:
// replay the committed generation's index, then reclaim every file that
// the committed generation does not reference.
func Open(dir string, opts ...Option) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, index: make(map[uint64]Location)}
	for _, o := range opts {
		o(s)
	}

	generation, err := readCommit(dir)
	if err != nil {
		return nil, err
	}
	s.generation = generation

	if generation > 0 || fileExists(filepath.Join(dir, indexFileName(0))) {
		_, entries, err := loadIndex(filepath.Join(dir, indexFileName(generation)))
		if err != nil {
			return nil, fmt.Errorf("store: committed generation %d unreadable: %w", generation, err)
		}
		for _, e := range entries {
			s.index[e.PageID] = e.Loc
		}
	}

	maxSegID, err := s.recoverReclaim()
	if err != nil {
		return nil, err
	}
	s.nextSegID = maxSegID + 1

	if err := s.openIndexLog(); err != nil {
		return nil, err
	}
	return s, nil
}

// recoverReclaim deletes files not referenced by the committed generation
// and verifies that every referenced segment exists. Returns the highest
// segment ID seen on disk.
func (s *Store) recoverReclaim() (uint64, error) {
	referenced := make(map[uint64]bool)
	for _, loc := range s.index {
		referenced[loc.Segment] = true
	}

	var maxSegID uint64
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return 0, err
	}
	for _, e := range entries {
		name := e.Name()
		if id, ok := parseSegFileName(name); ok {
			if id > maxSegID {
				maxSegID = id
			}
			if !referenced[id] {
				if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
					return 0, err
				}
			}
			continue
		}
		if gen, ok := parseIndexFileName(name); ok && gen != s.generation {
			if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
				return 0, err
			}
			continue
		}
		if strings.HasSuffix(name, ".tmp") {
			if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
				return 0, err
			}
		}
	}
	if err := syncDir(s.dir); err != nil {
		return 0, err
	}

	for id := range referenced {
		if !fileExists(filepath.Join(s.dir, segFileName(id))) {
			return 0, fmt.Errorf("store: committed generation %d references missing segment %d", s.generation, id)
		}
	}
	return maxSegID, nil
}

// openActiveSegment creates a fresh append segment for this session. It is
// called lazily on the first Put so that read-only sessions never leave
// an empty, unreferenced segment behind.
func (s *Store) openActiveSegment() error {
	id := s.nextSegID
	s.nextSegID++
	f, err := os.OpenFile(filepath.Join(s.dir, segFileName(id)), os.O_CREATE|os.O_RDWR|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	s.activeSeg = f
	s.activeSegID = id
	s.activeOff = 0
	return nil
}

// openIndexLog opens the committed generation's index log for appending,
// creating it (with header) if the generation has no log yet.
func (s *Store) openIndexLog() error {
	path := filepath.Join(s.dir, indexFileName(s.generation))
	fresh := !fileExists(path)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	if fresh {
		if err := writeIndexHeader(f, s.generation); err != nil {
			f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
	}
	s.indexLog = f
	return nil
}

// Put stores payload under the stable page ID, replacing any prior value.
// The record and its index entry are both fsynced before Put returns.
func (s *Store) Put(pageID uint64, payload []byte) error {
	if s.activeSeg == nil {
		if err := s.openActiveSegment(); err != nil {
			return err
		}
	}
	rec := encodeRecord(pageID, payload)
	if _, err := s.activeSeg.WriteAt(rec, int64(s.activeOff)); err != nil {
		return err
	}
	if err := s.activeSeg.Sync(); err != nil {
		return err
	}
	loc := Location{Segment: s.activeSegID, Offset: s.activeOff, Length: uint32(len(payload))}
	if err := appendIndexEntry(s.indexLog, indexEntry{PageID: pageID, Loc: loc}); err != nil {
		return err
	}
	s.index[pageID] = loc
	s.activeOff += uint64(len(rec))
	return nil
}

// Get resolves the stable page ID through the current generation's index
// and returns the payload after verifying its checksum.
func (s *Store) Get(pageID uint64) ([]byte, error) {
	loc, ok := s.index[pageID]
	if !ok {
		return nil, fmt.Errorf("store: page %d: %w", pageID, fs.ErrNotExist)
	}
	return readPage(s.dir, pageID, loc)
}

// readPage reads and validates one record at a known location.
func readPage(dir string, pageID uint64, loc Location) ([]byte, error) {
	f, err := os.Open(filepath.Join(dir, segFileName(loc.Segment)))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, recordHeaderSize+int(loc.Length)+recordTrailerSize)
	if _, err := f.ReadAt(buf, int64(loc.Offset)); err != nil {
		return nil, err
	}
	gotID, payload, err := decodeRecord(buf)
	if err != nil {
		return nil, err
	}
	if gotID != pageID {
		return nil, fmt.Errorf("store: location for page %d holds page %d", pageID, gotID)
	}
	return payload, nil
}

// PageIDs returns the sorted stable page IDs live in this generation.
func (s *Store) PageIDs() []uint64 {
	ids := make([]uint64, 0, len(s.index))
	for id := range s.index {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// Close flushes and closes the store's open files.
func (s *Store) Close() error {
	var errs []error
	if s.activeSeg != nil {
		errs = append(errs, s.activeSeg.Sync(), s.activeSeg.Close())
		if s.activeOff == 0 {
			// The session's append segment never received a record;
			// it is unreferenced garbage.
			errs = append(errs, os.Remove(filepath.Join(s.dir, segFileName(s.activeSegID))))
			errs = append(errs, syncDir(s.dir))
		}
	}
	if s.indexLog != nil {
		errs = append(errs, s.indexLog.Sync(), s.indexLog.Close())
	}
	return errors.Join(errs...)
}

// --- commit record ---

// readCommit returns the committed generation, or 0 if none exists.
func readCommit(dir string) (uint64, error) {
	buf, err := os.ReadFile(filepath.Join(dir, commitFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if len(buf) != 12 {
		return 0, errors.New("store: corrupt COMMIT record")
	}
	if crc32.ChecksumIEEE(buf[:8]) != binary.LittleEndian.Uint32(buf[8:12]) {
		return 0, errors.New("store: COMMIT checksum mismatch")
	}
	return binary.LittleEndian.Uint64(buf[:8]), nil
}

// writeCommit atomically publishes a generation: write temp, fsync,
// rename, fsync the directory. The rename is the single atomic publish
// point shared by the relocated pages and their updated references.
func writeCommit(dir string, generation uint64) error {
	buf := make([]byte, 12)
	binary.LittleEndian.PutUint64(buf[:8], generation)
	binary.LittleEndian.PutUint32(buf[8:12], crc32.ChecksumIEEE(buf[:8]))

	tmp := filepath.Join(dir, commitTmpName)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, commitFileName)); err != nil {
		return err
	}
	return syncDir(dir)
}

// --- small helpers ---

func segFileName(id uint64) string {
	return fmt.Sprintf("%s%06d%s", segFilePrefix, id, segFileSuffix)
}

func parseSegFileName(name string) (uint64, bool) {
	if !strings.HasPrefix(name, segFilePrefix) || !strings.HasSuffix(name, segFileSuffix) {
		return 0, false
	}
	id, err := strconv.ParseUint(name[len(segFilePrefix):len(name)-len(segFileSuffix)], 10, 64)
	return id, err == nil
}

func parseIndexFileName(name string) (uint64, bool) {
	if !strings.HasPrefix(name, "idx-") || !strings.HasSuffix(name, ".log") {
		return 0, false
	}
	gen, err := strconv.ParseUint(name[len("idx-"):len(name)-len(".log")], 10, 64)
	return gen, err == nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
