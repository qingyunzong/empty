package store

import (
	"fmt"
	"os"
	"sort"
)

// Stats reports the outcome of one compaction run.
type Stats struct {
	PagesMoved      int    // live pages copied into the compact segment
	BytesReclaimed  uint64 // total size of retired segments
	SegmentsRetired int    // number of retired segments
}

// Compact copies every live page into a fresh compact segment and publishes
// the relocation together with the reference (index) update as one
// generation, then retires the superseded segments.
//
// Crash safety: the new segment is fsynced before the new index is
// published, and the index is fsynced before the manifest rename commits the
// generation. A power loss therefore leaves either the old generation or the
// new generation fully intact; orphaned files from an interrupted run are
// reclaimed by the next Open.
func (s *Store) Compact() (Stats, error) {
	var stats Stats
	oldSegments := s.sortedSegments()
	if len(oldSegments) == 0 && len(s.index) == 0 {
		return stats, nil
	}

	// Phase 1: copy live pages into the compact segment, verifying each
	// page checksum before relocation.
	newSeg := s.nextSeg
	s.nextSeg++
	path := segmentPath(s.dir, newSeg)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return stats, err
	}
	ids := s.List()
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	index := make(map[uint64]Location, len(ids))
	var off uint64
	for _, id := range ids {
		payload, err := s.Get(id) // Get verifies the page checksum
		if err != nil {
			f.Close()
			os.Remove(path)
			return stats, fmt.Errorf("compact: page %d failed verification: %w", id, err)
		}
		rec := encodeRecord(id, payload)
		if _, err := f.Write(rec); err != nil {
			f.Close()
			os.Remove(path)
			return stats, err
		}
		index[id] = Location{Segment: newSeg, Offset: off, Length: uint32(len(rec))}
		off += uint64(len(rec))
		stats.PagesMoved++
	}
	if s.hooks.AfterCopy != nil {
		s.hooks.AfterCopy()
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return stats, err
	}
	f.Close()

	// Phase 2: publish relocation + reference update as one generation.
	if err := s.publish(index, []uint64{newSeg}); err != nil {
		return stats, err
	}

	// Phase 3: retire superseded segments. The new generation is already
	// committed, so a crash here only leaves orphans for the next Open.
	if s.hooks.BeforeRetire != nil {
		s.hooks.BeforeRetire()
	}
	retired := map[uint64]bool{}
	for _, old := range oldSegments {
		if old == newSeg {
			continue
		}
		// Reclamation range check: no live reference may point into the
		// segment being retired.
		for id, loc := range s.index {
			if loc.Segment == old {
				return stats, fmt.Errorf("compact: refusing to retire segment %d: page %d still references it", old, id)
			}
		}
		size := s.segmentSize(old)
		if err := os.Remove(segmentPath(s.dir, old)); err != nil && !os.IsNotExist(err) {
			return stats, err
		}
		stats.BytesReclaimed += size
		stats.SegmentsRetired++
		retired[old] = true
		if s.hooks.AfterRetireSegment != nil {
			s.hooks.AfterRetireSegment(old)
		}
	}
	if err := syncDir(s.dir); err != nil {
		return stats, err
	}
	return stats, nil
}
