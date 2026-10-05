// Package mirror implements a mirrored file library: every record is stored
// in three local replica directories, reads succeed only when a majority of
// replicas agree on the same version, read-repair never overwrites a higher
// version, and new writes must use strictly increasing versions.
package mirror

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ReplicaCount is the number of local replicas kept for every record.
const ReplicaCount = 3

// majority is the smallest number of replicas that must agree for a read to
// succeed: 2 out of 3.
const majority = ReplicaCount/2 + 1

var (
	// ErrNoMajority is returned by Read when no version is held by a
	// majority of healthy replicas.
	ErrNoMajority = errors.New("mirror: no majority version among replicas")
	// ErrVersionNotIncreasing is returned by Write when the requested
	// version is not strictly greater than the current version.
	ErrVersionNotIncreasing = errors.New("mirror: version must be strictly increasing")
)

// Status describes the health of a single replica copy of a record.
type Status string

const (
	StatusOK      Status = "ok"
	StatusMissing Status = "missing"
	StatusCorrupt Status = "corrupt"
)

// fileRecord is the on-disk format of one replica copy.
type fileRecord struct {
	Version uint64 `json:"version"`
	Data    []byte `json:"data"`
	Sum     string `json:"sum"` // hex SHA-256 of Data
}

func checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// snapshot is the observed state of one replica at a point in time.
type snapshot struct {
	status Status
	rec    fileRecord
	detail string
}

// AnomalyKind classifies irregularities found while reading and repairing.
type AnomalyKind string

const (
	AnomalyCorrupt         AnomalyKind = "corrupt"
	AnomalyMissing         AnomalyKind = "missing"
	AnomalyStale           AnomalyKind = "stale"
	AnomalyRepaired        AnomalyKind = "repaired"
	AnomalyKeptHigher      AnomalyKind = "kept-higher-version"
	AnomalyConcurrentWrite AnomalyKind = "concurrent-write-during-repair"
)

// Anomaly describes one irregularity on one replica.
type Anomaly struct {
	Replica int
	Kind    AnomalyKind
	Version uint64
	Detail  string
}

// ReadResult is the outcome of a quorum read plus the repair report.
type ReadResult struct {
	Key       string
	Version   uint64
	Data      []byte
	Anomalies []Anomaly
}

// ReplicaEvidence is the verified state of one replica of a key.
type ReplicaEvidence struct {
	Replica int
	Status  Status
	Version uint64
	Sum     string
	Detail  string
}

// Evidence is the result of Verify: per-replica state plus the version
// history observed by this store, with a monotonicity check.
type Evidence struct {
	Key       string
	Replicas  [ReplicaCount]ReplicaEvidence
	History   map[int][]uint64 // replica -> versions applied by this store, in order
	Monotonic bool             // true if every replica's history never decreases
}

// Store keeps three local replica directories under a root directory.
type Store struct {
	dirs [ReplicaCount]string
	mu   sync.Mutex
	hist map[string]map[int][]uint64 // key -> replica -> applied versions

	// BeforeRepair, if set, runs between the read phase and the repair
	// phase of Read. It is a test hook used to inject a concurrent write
	// while a repair is in flight.
	BeforeRepair func()
}

// NewStore creates (or opens) a store rooted at root with three replica
// directories underneath it.
func NewStore(root string) (*Store, error) {
	s := &Store{hist: make(map[string]map[int][]uint64)}
	for i := 0; i < ReplicaCount; i++ {
		dir := filepath.Join(root, fmt.Sprintf("replica-%d", i))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		s.dirs[i] = dir
	}
	return s, nil
}

func (s *Store) path(replica int, key string) string {
	return filepath.Join(s.dirs[replica], key+".json")
}

// readReplicaLocked inspects one replica without modifying it.
func (s *Store) readReplicaLocked(replica int, key string) snapshot {
	raw, err := os.ReadFile(s.path(replica, key))
	if errors.Is(err, os.ErrNotExist) {
		return snapshot{status: StatusMissing, detail: "replica file absent"}
	}
	if err != nil {
		return snapshot{status: StatusCorrupt, detail: err.Error()}
	}
	var rec fileRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return snapshot{status: StatusCorrupt, detail: "unparseable record: " + err.Error()}
	}
	if checksum(rec.Data) != rec.Sum {
		return snapshot{status: StatusCorrupt, detail: "checksum mismatch"}
	}
	return snapshot{status: StatusOK, rec: rec}
}

// writeReplicaLocked atomically replaces one replica copy and records the
// applied version in the history log.
func (s *Store) writeReplicaLocked(replica int, key string, rec fileRecord) error {
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	tmp := s.path(replica, key) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path(replica, key)); err != nil {
		return err
	}
	s.appendHistoryLocked(key, replica, rec.Version)
	return nil
}

func (s *Store) appendHistoryLocked(key string, replica int, version uint64) {
	m := s.hist[key]
	if m == nil {
		m = make(map[int][]uint64)
		s.hist[key] = m
	}
	m[replica] = append(m[replica], version)
}

// Write stores data at the given version on all replicas. The version must
// be strictly greater than the highest valid version currently held by any
// replica.
func (s *Store) Write(key string, data []byte, version uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var current uint64
	for i := 0; i < ReplicaCount; i++ {
		snap := s.readReplicaLocked(i, key)
		if snap.status == StatusOK && snap.rec.Version > current {
			current = snap.rec.Version
		}
	}
	if version <= current {
		return fmt.Errorf("%w: key %q is at version %d, got %d",
			ErrVersionNotIncreasing, key, current, version)
	}
	rec := fileRecord{Version: version, Data: data, Sum: checksum(data)}
	for i := 0; i < ReplicaCount; i++ {
		if err := s.writeReplicaLocked(i, key, rec); err != nil {
			return err
		}
	}
	return nil
}

// Read performs a quorum read of key: it succeeds only if a majority of
// replicas hold a valid copy of the same version. Afterwards it repairs
// missing, corrupt and stale replicas from the majority record, but never
// overwrites a replica that holds a higher version — including versions
// written concurrently while the repair was in flight.
func (s *Store) Read(key string) (*ReadResult, error) {
	s.mu.Lock()
	var snaps [ReplicaCount]snapshot
	for i := range snaps {
		snaps[i] = s.readReplicaLocked(i, key)
	}
	s.mu.Unlock()

	counts := make(map[uint64]int)
	for _, snap := range snaps {
		if snap.status == StatusOK {
			counts[snap.rec.Version]++
		}
	}
	var majVersion uint64
	found := false
	for v, c := range counts {
		if c >= majority && (!found || v > majVersion) {
			majVersion, found = v, true
		}
	}

	res := &ReadResult{Key: key}
	for i, snap := range snaps {
		switch {
		case snap.status == StatusMissing:
			res.Anomalies = append(res.Anomalies, Anomaly{Replica: i, Kind: AnomalyMissing, Detail: snap.detail})
		case snap.status == StatusCorrupt:
			res.Anomalies = append(res.Anomalies, Anomaly{Replica: i, Kind: AnomalyCorrupt, Detail: snap.detail})
		case found && snap.rec.Version < majVersion:
			res.Anomalies = append(res.Anomalies, Anomaly{Replica: i, Kind: AnomalyStale, Version: snap.rec.Version})
		}
	}
	if !found {
		return res, ErrNoMajority
	}

	var majRec fileRecord
	for _, snap := range snaps {
		if snap.status == StatusOK && snap.rec.Version == majVersion {
			majRec = snap.rec
			break
		}
	}
	res.Version = majVersion
	res.Data = majRec.Data

	if s.BeforeRepair != nil {
		s.BeforeRepair()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for i, snap := range snaps {
		if snap.status == StatusOK && snap.rec.Version >= majVersion {
			if snap.rec.Version > majVersion {
				res.Anomalies = append(res.Anomalies, Anomaly{
					Replica: i, Kind: AnomalyKeptHigher, Version: snap.rec.Version,
					Detail: "replica holds a higher version; repair skipped",
				})
			}
			continue
		}
		// Re-read under lock: the replica may have changed since the
		// read phase (concurrent write during repair).
		cur := s.readReplicaLocked(i, key)
		if cur.status == StatusOK && cur.rec.Version >= majVersion {
			res.Anomalies = append(res.Anomalies, Anomaly{
				Replica: i, Kind: AnomalyConcurrentWrite, Version: cur.rec.Version,
				Detail: "replica changed during repair; left untouched",
			})
			continue
		}
		if err := s.writeReplicaLocked(i, key, majRec); err != nil {
			return res, err
		}
		res.Anomalies = append(res.Anomalies, Anomaly{
			Replica: i, Kind: AnomalyRepaired, Version: majVersion,
			Detail: "replica restored from majority record",
		})
	}
	return res, nil
}

// Verify returns evidence of the current state of every replica of key and
// checks that each replica's version history is monotonically
// non-decreasing.
func (s *Store) Verify(key string) *Evidence {
	s.mu.Lock()
	defer s.mu.Unlock()
	ev := &Evidence{Key: key, Monotonic: true, History: make(map[int][]uint64)}
	for i := 0; i < ReplicaCount; i++ {
		snap := s.readReplicaLocked(i, key)
		re := ReplicaEvidence{Replica: i, Status: snap.status, Detail: snap.detail}
		if snap.status == StatusOK {
			re.Version = snap.rec.Version
			re.Sum = snap.rec.Sum
		}
		ev.Replicas[i] = re
	}
	for replica, seq := range s.hist[key] {
		cp := append([]uint64(nil), seq...)
		ev.History[replica] = cp
		for j := 1; j < len(cp); j++ {
			if cp[j] < cp[j-1] {
				ev.Monotonic = false
			}
		}
	}
	return ev
}
