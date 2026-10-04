// Package mirrorstore implements a mirrored file store that keeps three
// local replicas of every record. Records carry a version and a SHA-256
// checksum. A read succeeds only when a majority of replicas agree on the
// same version; successful reads repair missing, corrupt and stale
// replicas, but repair never overwrites a replica that holds a higher
// version. New writes are accepted only with a strictly increasing
// version.
package mirrorstore

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

// majority is the quorum required for a successful read: 2 of 3.
const majority = ReplicaCount/2 + 1

var (
	// ErrNoMajority is returned by Read when no single version is held by
	// a majority of healthy replicas.
	ErrNoMajority = errors.New("mirrorstore: no majority version among replicas")
	// ErrVersionRegression is returned by Write when the proposed version
	// is not strictly greater than the highest version found in any
	// replica for the key.
	ErrVersionRegression = errors.New("mirrorstore: version must be strictly increasing")
	// ErrNotFound is returned by Read when no replica holds the key.
	ErrNotFound = errors.New("mirrorstore: key not found in any replica")
)

// ReplicaState describes what a read observed on one replica.
type ReplicaState int

const (
	// StateOK means the replica held a well-formed record whose checksum
	// matched its payload.
	StateOK ReplicaState = iota
	// StateMissing means the replica had no record for the key.
	StateMissing
	// StateCorrupt means the record was unreadable, unparseable, or its
	// checksum did not match its payload.
	StateCorrupt
	// StateStale means the record was valid but older than the majority
	// version.
	StateStale
)

func (s ReplicaState) String() string {
	switch s {
	case StateOK:
		return "ok"
	case StateMissing:
		return "missing"
	case StateCorrupt:
		return "corrupt"
	case StateStale:
		return "stale"
	default:
		return "unknown"
	}
}

// ReplicaEvidence is the per-replica proof returned by Read.
type ReplicaEvidence struct {
	Replica       int               // replica index, 0..ReplicaCount-1
	Dir           string            // replica directory
	State         ReplicaState      // what the read observed
	Version       uint64            // version found (valid only if VersionKnown)
	VersionKnown  bool              // false when missing or unparseable
	SumOK         bool              // stored checksum matched the payload
	Digest        [sha256.Size]byte // SHA-256 of the payload as stored
	Repaired      bool              // read-repair rewrote this replica to the majority version
	SkippedHigher bool              // repair skipped: replica holds a version >= majority
}

// ReadResult is the outcome of a Read. It is returned together with a
// non-nil error when the read fails, so callers can inspect the evidence.
type ReadResult struct {
	Key      string
	Version  uint64 // majority version (meaningful only when err == nil)
	Data     []byte // payload from a majority replica (meaningful only when err == nil)
	Evidence [ReplicaCount]ReplicaEvidence
}

// record is the on-disk format of one replica file.
type record struct {
	Version uint64 `json:"version"`
	Sum     string `json:"sum"`  // hex-encoded SHA-256 of Data
	Data    []byte `json:"data"` // JSON base64
}

// Store is a three-replica mirrored file store. It is safe for concurrent
// use; all operations are serialized internally.
type Store struct {
	dirs [ReplicaCount]string
	mu   sync.Mutex

	// beforeRepairWrite, when set, runs inside Read after the majority is
	// established but before the given replica is repaired. Tests use it
	// to inject a concurrent external write in the middle of read-repair.
	beforeRepairWrite func(replica int, version uint64)
	// afterWrite, when set, runs after every record write to a replica
	// (both Write and read-repair). Tests use it to record per-replica
	// version histories and assert monotonicity.
	afterWrite func(replica int, version uint64)
}

// Open creates a Store using the given replica directories, creating them
// if needed.
func Open(dirs [ReplicaCount]string) (*Store, error) {
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("mirrorstore: create replica dir %s: %w", dir, err)
		}
	}
	return &Store{dirs: dirs}, nil
}

// path maps a key to its file inside one replica directory. Keys are
// hex-encoded so any byte string is a safe file name.
func (s *Store) path(replica int, key string) string {
	name := hex.EncodeToString([]byte(key)) + ".rec"
	return filepath.Join(s.dirs[replica], name)
}

// replicaView is the inspected state of one replica file.
type replicaView struct {
	rec    *record // nil when missing or unparseable
	exists bool
	sumOK  bool
	digest [sha256.Size]byte
}

// inspect reads and validates one replica file. Missing files, read
// errors and unparseable content are reported through the view rather
// than as errors: to a quorum reader they are just unavailable replicas.
func inspect(path string) replicaView {
	var view replicaView
	raw, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			view.exists = true // unreadable: treat as corrupt
		}
		return view
	}
	view.exists = true
	var rec record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return view // unparseable: corrupt, version unknown
	}
	view.rec = &rec
	view.digest = sha256.Sum256(rec.Data)
	view.sumOK = hex.EncodeToString(view.digest[:]) == rec.Sum
	return view
}

func checksumHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// writeRecord atomically replaces the file at path with rec via a
// write-fsync-rename cycle, so readers never observe a torn record.
func writeRecord(path string, rec *record) error {
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// Write stores data under key with the given version on all replicas.
// The version must be strictly greater than the highest version currently
// found in any replica for the key, including corrupt-but-parseable
// records, so versions never regress.
func (s *Store) Write(key string, version uint64, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var highest uint64
	for i := 0; i < ReplicaCount; i++ {
		view := inspect(s.path(i, key))
		if view.rec != nil && view.rec.Version > highest {
			highest = view.rec.Version
		}
	}
	if version <= highest {
		return fmt.Errorf("%w: key %q is at version %d, got %d", ErrVersionRegression, key, highest, version)
	}
	rec := record{Version: version, Sum: checksumHex(data), Data: data}
	for i := 0; i < ReplicaCount; i++ {
		if err := writeRecord(s.path(i, key), &rec); err != nil {
			return fmt.Errorf("mirrorstore: write replica %d: %w", i, err)
		}
		if s.afterWrite != nil {
			s.afterWrite(i, version)
		}
	}
	return nil
}

// Read returns the record for key. It succeeds only when a majority of
// replicas hold valid records with the same version, and returns the
// majority version's payload. On success it repairs missing, corrupt and
// stale replicas, but never overwrites a replica that holds a version
// greater than or equal to the majority version; the replica file is
// re-inspected immediately before each repair write so a concurrent
// (even external) newer write is never clobbered. On failure Read still
// returns the per-replica evidence.
func (s *Store) Read(key string) (*ReadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := &ReadResult{Key: key}
	var views [ReplicaCount]replicaView
	votes := make(map[uint64]int)
	for i := 0; i < ReplicaCount; i++ {
		ev := ReplicaEvidence{Replica: i, Dir: s.dirs[i]}
		views[i] = inspect(s.path(i, key))
		view := views[i]
		switch {
		case !view.exists:
			ev.State = StateMissing
		case view.rec == nil:
			ev.State = StateCorrupt
		default:
			ev.Version = view.rec.Version
			ev.VersionKnown = true
			ev.Digest = view.digest
			ev.SumOK = view.sumOK
			if view.sumOK {
				ev.State = StateOK
				votes[view.rec.Version]++
			} else {
				ev.State = StateCorrupt
			}
		}
		result.Evidence[i] = ev
	}

	var majVersion uint64
	majorityFound := false
	for version, n := range votes {
		if n >= majority {
			majVersion = version
			majorityFound = true
			break
		}
	}
	if !majorityFound {
		allMissing := true
		for i := 0; i < ReplicaCount; i++ {
			if result.Evidence[i].State != StateMissing {
				allMissing = false
				break
			}
		}
		if allMissing {
			return result, fmt.Errorf("%w: key %q", ErrNotFound, key)
		}
		return result, fmt.Errorf("%w: key %q", ErrNoMajority, key)
	}

	// Adopt the payload of a majority replica and mark older valid
	// replicas as stale.
	foundData := false
	for i := 0; i < ReplicaCount; i++ {
		ev := &result.Evidence[i]
		if ev.State != StateOK {
			continue
		}
		switch {
		case ev.Version == majVersion && !foundData:
			result.Data = views[i].rec.Data
			foundData = true
		case ev.Version < majVersion:
			ev.State = StateStale
		}
	}
	result.Version = majVersion

	// Repair replicas that are missing, corrupt or stale. Never overwrite
	// a replica holding a version >= the majority version.
	for i := 0; i < ReplicaCount; i++ {
		ev := &result.Evidence[i]
		if ev.State == StateOK && ev.Version == majVersion {
			continue // healthy majority replica
		}
		if ev.State == StateOK && ev.Version > majVersion {
			ev.SkippedHigher = true
			continue
		}
		if s.beforeRepairWrite != nil {
			s.beforeRepairWrite(i, majVersion)
		}
		// Re-inspect immediately before writing: a concurrent writer may
		// have installed a newer record while the read was in progress.
		// Never overwrite a higher version, even if it is corrupt; a
		// corrupt record at the majority version itself is repaired.
		current := inspect(s.path(i, key))
		if current.rec != nil {
			if current.rec.Version > majVersion {
				ev.SkippedHigher = true
				continue
			}
			if current.rec.Version == majVersion && current.sumOK {
				continue // already repaired concurrently
			}
		}
		rec := record{Version: majVersion, Sum: checksumHex(result.Data), Data: result.Data}
		if err := writeRecord(s.path(i, key), &rec); err != nil {
			return result, fmt.Errorf("mirrorstore: repair replica %d: %w", i, err)
		}
		ev.Repaired = true
		if s.afterWrite != nil {
			s.afterWrite(i, majVersion)
		}
	}
	return result, nil
}
