package objstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// gcState tracks a single in-flight GC cycle. The protected set is guarded
// by gcMu: root/lease additions and (re-)uploads record their closures here
// so the sweep can never delete an object that became reachable mid-cycle.
type gcState struct {
	epoch     int64
	protected map[Hash]bool
}

// Evidence is the unreachable-proof attached to every deletion. It records
// the exact root sets against which the object was found unreachable: the
// snapshot taken at GC start and the recheck taken immediately before the
// sweep, plus the size of the reachable closure that was searched.
type Evidence struct {
	Epoch         int64           `json:"epoch"`
	Hash          Hash            `json:"hash"`
	Time          time.Time       `json:"time"`
	Reason        string          `json:"reason"`
	SnapshotRoots map[string]Hash `json:"snapshot_roots"`
	RecheckRoots  map[string]Hash `json:"recheck_roots"`
	ReachableSize int             `json:"reachable_size"`
}

// GCStats summarizes one collection cycle.
type GCStats struct {
	Epoch     int64
	Scanned   int
	Kept      int
	Deleted   int
	Protected int // deletion candidates rescued by recheck or protection
}

// ErrGCRunning is returned when a GC cycle is already in flight.
var ErrGCRunning = errors.New("objstore: gc already running")

// RunGC performs a mark-sweep collection:
//
//  1. snapshot roots and live leases (barrier: AfterSnapshot)
//  2. mark the reachable closure (barrier: AfterMark)
//  3. recheck candidates against the current roots/leases (barrier: BeforeSweep)
//  4. for each remaining candidate, write fsynced unreachable evidence and
//     only then delete the object (barrier: BeforeDelete)
//
// Roots or leases added at any point during the cycle protect their closure
// via gcMu, so a concurrently reachable object is never deleted.
func (s *Store) RunGC() (*GCStats, error) {
	s.mu.Lock()
	if s.active != nil {
		s.mu.Unlock()
		return nil, ErrGCRunning
	}
	gs := &gcState{epoch: s.now().UnixNano(), protected: map[Hash]bool{}}
	s.active = gs
	snapRoots := s.rootsCopyLocked()
	snapLeases := s.liveLeasesLocked()
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if s.active == gs {
			s.active = nil
		}
		s.mu.Unlock()
	}()

	if b := s.barriers.AfterSnapshot; b != nil {
		b(s)
	}

	reachable, err := s.markFrom(snapRoots, snapLeases)
	if err != nil {
		return nil, err
	}

	if b := s.barriers.AfterMark; b != nil {
		b(s)
	}

	all, err := s.listObjects()
	if err != nil {
		return nil, err
	}
	var candidates []Hash
	for _, h := range all {
		if !reachable[h] {
			candidates = append(candidates, h)
		}
	}

	// Recheck against the roots/leases visible now: anything that became
	// reachable since the snapshot is rescued before the sweep starts.
	s.mu.Lock()
	nowRoots := s.rootsCopyLocked()
	nowLeases := s.liveLeasesLocked()
	s.mu.Unlock()
	reachableNow, err := s.markFrom(nowRoots, nowLeases)
	if err != nil {
		return nil, err
	}

	if b := s.barriers.BeforeSweep; b != nil {
		b(s)
	}

	stats := &GCStats{Epoch: gs.epoch, Scanned: len(all), Kept: len(reachable)}
	for _, h := range candidates {
		if reachableNow[h] {
			stats.Protected++
			continue
		}
		if b := s.barriers.BeforeDelete; b != nil {
			b(s, h)
		}
		s.gcMu.Lock()
		if gs.protected[h] {
			// Became reachable (root/lease/upload) after the recheck.
			s.gcMu.Unlock()
			stats.Protected++
			continue
		}
		ev := Evidence{
			Epoch:         gs.epoch,
			Hash:          h,
			Time:          s.now(),
			Reason:        "unreachable from roots and live leases at snapshot and recheck",
			SnapshotRoots: snapRoots,
			RecheckRoots:  nowRoots,
			ReachableSize: len(reachableNow),
		}
		if err := s.appendEvidence(ev); err != nil {
			s.gcMu.Unlock()
			return stats, fmt.Errorf("objstore: gc: evidence for %s: %w", h, err)
		}
		if err := os.Remove(s.objectPath(h)); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.gcMu.Unlock()
			return stats, fmt.Errorf("objstore: gc: delete %s: %w", h, err)
		}
		s.gcMu.Unlock()
		stats.Deleted++
	}
	return stats, nil
}

// markFrom computes the reachable closure from roots and live lease hashes.
// Dangling references (missing objects) are tolerated and skipped.
func (s *Store) markFrom(roots map[string]Hash, leases map[Hash]bool) (map[Hash]bool, error) {
	reachable := map[Hash]bool{}
	var stack []Hash
	for _, h := range roots {
		stack = append(stack, h)
	}
	for h := range leases {
		stack = append(stack, h)
	}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if reachable[h] {
			continue
		}
		obj, err := s.Get(h)
		if errors.Is(err, ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		reachable[h] = true
		stack = append(stack, obj.Refs...)
	}
	return reachable, nil
}

// appendEvidence fsyncs one evidence record to evidence.log and records it
// in memory. It is always called before the corresponding object deletion.
func (s *Store) appendEvidence(ev Evidence) error {
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.evidencePath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
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
	s.evMu.Lock()
	s.deletions = append(s.deletions, ev)
	s.evMu.Unlock()
	return nil
}

func (s *Store) evidencePath() string { return filepath.Join(s.dir, "evidence.log") }

// Deletions returns the in-memory evidence records of this store instance.
func (s *Store) Deletions() []Evidence {
	s.evMu.Lock()
	defer s.evMu.Unlock()
	out := make([]Evidence, len(s.deletions))
	copy(out, s.deletions)
	return out
}

// ReadEvidence loads all deletion evidence persisted in evidence.log.
func (s *Store) ReadEvidence() ([]Evidence, error) {
	data, err := os.ReadFile(s.evidencePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Evidence
	for _, line := range splitLines(data) {
		if len(line) == 0 {
			continue
		}
		var ev Evidence
		if err := json.Unmarshal(line, &ev); err != nil {
			return nil, fmt.Errorf("objstore: corrupt evidence log: %w", err)
		}
		out = append(out, ev)
	}
	return out, nil
}

func splitLines(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for i, c := range b {
		if c == '\n' {
			out = append(out, b[start:i])
			start = i + 1
		}
	}
	if start < len(b) {
		out = append(out, b[start:])
	}
	return out
}

// rootsCopyLocked copies the roots map. Caller holds mu.
func (s *Store) rootsCopyLocked() map[string]Hash {
	out := make(map[string]Hash, len(s.roots))
	for k, v := range s.roots {
		out[k] = v
	}
	return out
}

// sortedHashes is a small helper for tests and callers.
func sortedHashes(set map[Hash]bool) []Hash {
	out := make([]Hash, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
