package store

import (
	"os"
	"path/filepath"
)

// Compact copies every live page into a new compact segment, publishes the
// relocated pages and their updated references as one new generation, then
// retires the segments the new generation no longer references.
//
// Crash boundaries (injectable via FaultInjector):
//
//	copy  -> index flush -> COMMIT (atomic publish) -> retire
//
// A crash before the COMMIT rename leaves the old generation fully intact;
// a crash after it leaves the new generation fully intact. Retirement is
// idempotent and is finished by recovery on the next Open.
func (s *Store) Compact() error {
	newGen := s.generation + 1

	if err := s.faults.hook(FaultBeforeCopy); err != nil {
		return err
	}

	// 1. Copy live pages into a new compact segment, verifying each
	//    source page's checksum as it is read.
	newSegID := s.nextSegID
	s.nextSegID++
	newSegPath := filepath.Join(s.dir, segFileName(newSegID))
	newSeg, err := os.OpenFile(newSegPath, os.O_CREATE|os.O_RDWR|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	newIndex := make(map[uint64]Location, len(s.index))
	var off uint64
	for _, pageID := range s.PageIDs() {
		payload, err := s.Get(pageID) // verifies the per-page checksum
		if err != nil {
			newSeg.Close()
			return err
		}
		rec := encodeRecord(pageID, payload)
		if _, err := newSeg.WriteAt(rec, int64(off)); err != nil {
			newSeg.Close()
			return err
		}
		newIndex[pageID] = Location{Segment: newSegID, Offset: off, Length: uint32(len(payload))}
		off += uint64(len(rec))
	}
	if err := newSeg.Sync(); err != nil {
		newSeg.Close()
		return err
	}

	if err := s.faults.hook(FaultAfterCopy); err != nil {
		newSeg.Close()
		return err
	}

	// 2. Flush the new generation's index log: temp file, fsync, rename,
	//    fsync directory.
	tmpIndex := filepath.Join(s.dir, indexFileName(newGen)+".tmp")
	lf, err := os.OpenFile(tmpIndex, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		newSeg.Close()
		return err
	}
	if err := writeIndexHeader(lf, newGen); err != nil {
		lf.Close()
		newSeg.Close()
		return err
	}
	for _, pageID := range s.PageIDs() {
		if _, err := lf.Write(encodeIndexEntry(indexEntry{PageID: pageID, Loc: newIndex[pageID]})); err != nil {
			lf.Close()
			newSeg.Close()
			return err
		}
	}
	if err := lf.Sync(); err != nil {
		lf.Close()
		newSeg.Close()
		return err
	}
	if err := lf.Close(); err != nil {
		newSeg.Close()
		return err
	}
	if err := os.Rename(tmpIndex, filepath.Join(s.dir, indexFileName(newGen))); err != nil {
		newSeg.Close()
		return err
	}
	if err := syncDir(s.dir); err != nil {
		newSeg.Close()
		return err
	}

	if err := s.faults.hook(FaultAfterIndexFlush); err != nil {
		newSeg.Close()
		return err
	}

	// 3. Atomically publish: relocation and reference updates go live in
	//    the same generation with this single rename.
	if err := writeCommit(s.dir, newGen); err != nil {
		newSeg.Close()
		return err
	}

	if err := s.faults.hook(FaultAfterCommit); err != nil {
		newSeg.Close()
		return err
	}

	// 4. Retire segments the new generation no longer references, plus the
	//    old generation's index log. Anything left behind by a crash here
	//    is reclaimed by recovery on the next Open.
	oldReferenced := make(map[uint64]bool)
	for _, loc := range s.index {
		oldReferenced[loc.Segment] = true
	}
	// The session's append segment is always obsolete after compaction:
	// its live records were just copied out.
	if s.activeSeg != nil {
		oldReferenced[s.activeSegID] = true
	}
	delete(oldReferenced, newSegID)
	retiredFirst := false
	for segID := range oldReferenced {
		if err := os.Remove(filepath.Join(s.dir, segFileName(segID))); err != nil && !os.IsNotExist(err) {
			newSeg.Close()
			return err
		}
		if !retiredFirst {
			retiredFirst = true
			if err := s.faults.hook(FaultDuringRetire); err != nil {
				newSeg.Close()
				return err
			}
		}
	}
	if s.generation > 0 || fileExists(filepath.Join(s.dir, indexFileName(s.generation))) {
		if err := os.Remove(filepath.Join(s.dir, indexFileName(s.generation))); err != nil && !os.IsNotExist(err) {
			newSeg.Close()
			return err
		}
	}
	if err := syncDir(s.dir); err != nil {
		newSeg.Close()
		return err
	}

	// 5. Swap in-memory state to the new generation.
	oldSeg, oldLog := s.activeSeg, s.indexLog
	s.generation = newGen
	s.index = newIndex
	s.activeSeg = newSeg
	s.activeSegID = newSegID
	s.activeOff = off
	if err := s.openIndexLog(); err != nil {
		return err
	}
	if oldSeg != nil {
		oldSeg.Close()
	}
	oldLog.Close()
	return nil
}
