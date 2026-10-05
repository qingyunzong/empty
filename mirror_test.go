package mirror

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

// plantValid writes a well-formed record directly into one replica,
// bypassing the store's version rules (simulates an out-of-band writer).
func plantValid(t *testing.T, s *Store, key string, replica, version int, data string) {
	t.Helper()
	rec := fileRecord{Version: uint64(version), Data: []byte(data), Sum: checksum([]byte(data))}
	raw, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(s.path(replica, key), raw, 0o644); err != nil {
		t.Fatalf("plant: %v", err)
	}
}

func corruptReplica(t *testing.T, s *Store, key string, replica int) {
	t.Helper()
	if err := os.WriteFile(s.path(replica, key), []byte("garbage{{{"), 0o644); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
}

func removeReplica(t *testing.T, s *Store, key string, replica int) {
	t.Helper()
	if err := os.Remove(s.path(replica, key)); err != nil {
		t.Fatalf("remove: %v", err)
	}
}

func hasAnomaly(res *ReadResult, kind AnomalyKind, replica int) bool {
	for _, a := range res.Anomalies {
		if a.Kind == kind && a.Replica == replica {
			return true
		}
	}
	return false
}

func TestWriteThenQuorumRead(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	res, err := s.Read("doc")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 1 || string(res.Data) != "alpha" {
		t.Fatalf("got version=%d data=%q", res.Version, res.Data)
	}
	if len(res.Anomalies) != 0 {
		t.Fatalf("unexpected anomalies: %+v", res.Anomalies)
	}
	ev := s.Verify("doc")
	for _, re := range ev.Replicas {
		if re.Status != StatusOK || re.Version != 1 {
			t.Fatalf("replica %d: %+v", re.Replica, re)
		}
		if re.Sum != checksum([]byte("alpha")) {
			t.Fatalf("replica %d: bad sum %q", re.Replica, re.Sum)
		}
	}
	if !ev.Monotonic {
		t.Fatal("expected monotonic history")
	}
}

func TestWriteRejectsNonIncreasingVersions(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("v2"), 2); err != nil {
		t.Fatalf("Write v2: %v", err)
	}
	for _, v := range []uint64{2, 1, 0} {
		if err := s.Write("doc", []byte("nope"), v); !errors.Is(err, ErrVersionNotIncreasing) {
			t.Fatalf("Write v%d: want ErrVersionNotIncreasing, got %v", v, err)
		}
	}
	if err := s.Write("doc", []byte("v3"), 3); err != nil {
		t.Fatalf("Write v3: %v", err)
	}
	res, err := s.Read("doc")
	if err != nil || res.Version != 3 || string(res.Data) != "v3" {
		t.Fatalf("Read: %v %+v", err, res)
	}
}

func TestCorruptReplicaEnumeratedAndRepaired(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	corruptReplica(t, s, "doc", 1)

	res, err := s.Read("doc")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 1 || string(res.Data) != "alpha" {
		t.Fatalf("got version=%d data=%q", res.Version, res.Data)
	}
	if !hasAnomaly(res, AnomalyCorrupt, 1) {
		t.Fatalf("missing corrupt anomaly: %+v", res.Anomalies)
	}
	if !hasAnomaly(res, AnomalyRepaired, 1) {
		t.Fatalf("missing repaired anomaly: %+v", res.Anomalies)
	}
	ev := s.Verify("doc")
	if ev.Replicas[1].Status != StatusOK || ev.Replicas[1].Version != 1 {
		t.Fatalf("replica 1 not repaired: %+v", ev.Replicas[1])
	}
	if !ev.Monotonic {
		t.Fatal("expected monotonic history")
	}
}

func TestMissingReplicaEnumeratedAndRepaired(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	removeReplica(t, s, "doc", 2)

	res, err := s.Read("doc")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !hasAnomaly(res, AnomalyMissing, 2) || !hasAnomaly(res, AnomalyRepaired, 2) {
		t.Fatalf("anomalies: %+v", res.Anomalies)
	}
	if _, err := os.Stat(s.path(2, "doc")); err != nil {
		t.Fatalf("replica 2 not restored: %v", err)
	}
	ev := s.Verify("doc")
	if ev.Replicas[2].Status != StatusOK || ev.Replicas[2].Version != 1 {
		t.Fatalf("replica 2: %+v", ev.Replicas[2])
	}
}

func TestStaleReplicaRepairedToMajorityVersion(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("new"), 2); err != nil {
		t.Fatalf("Write: %v", err)
	}
	plantValid(t, s, "doc", 0, 1, "old") // replica 0 falls behind

	res, err := s.Read("doc")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 2 || string(res.Data) != "new" {
		t.Fatalf("got version=%d data=%q", res.Version, res.Data)
	}
	if !hasAnomaly(res, AnomalyStale, 0) || !hasAnomaly(res, AnomalyRepaired, 0) {
		t.Fatalf("anomalies: %+v", res.Anomalies)
	}
	if ev := s.Verify("doc"); ev.Replicas[0].Version != 2 {
		t.Fatalf("replica 0: %+v", ev.Replicas[0])
	}
}

func TestNoMajorityFails(t *testing.T) {
	s := newStore(t)
	// Three healthy replicas, all at different versions: no majority.
	plantValid(t, s, "doc", 0, 1, "one")
	plantValid(t, s, "doc", 1, 2, "two")
	plantValid(t, s, "doc", 2, 3, "three")
	if _, err := s.Read("doc"); !errors.Is(err, ErrNoMajority) {
		t.Fatalf("want ErrNoMajority, got %v", err)
	}

	// Two corrupt replicas leave only one valid copy: still no majority.
	s2 := newStore(t)
	if err := s2.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	corruptReplica(t, s2, "doc", 0)
	corruptReplica(t, s2, "doc", 1)
	res, err := s2.Read("doc")
	if !errors.Is(err, ErrNoMajority) {
		t.Fatalf("want ErrNoMajority, got %v", err)
	}
	if !hasAnomaly(res, AnomalyCorrupt, 0) || !hasAnomaly(res, AnomalyCorrupt, 1) {
		t.Fatalf("anomalies: %+v", res.Anomalies)
	}
}

func TestRepairNeverOverwritesHigherVersion(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("majority"), 2); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Replica 2 somehow holds a newer version (e.g. it saw a write the
	// others missed). Majority is still v2, so the read returns v2...
	plantValid(t, s, "doc", 2, 5, "newer")
	res, err := s.Read("doc")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 2 || string(res.Data) != "majority" {
		t.Fatalf("got version=%d data=%q", res.Version, res.Data)
	}
	if !hasAnomaly(res, AnomalyKeptHigher, 2) {
		t.Fatalf("anomalies: %+v", res.Anomalies)
	}
	// ...but repair must not clobber the higher-version replica.
	ev := s.Verify("doc")
	if ev.Replicas[2].Status != StatusOK || ev.Replicas[2].Version != 5 {
		t.Fatalf("replica 2 was overwritten: %+v", ev.Replicas[2])
	}
}

func TestConcurrentWriteDuringRepair(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	corruptReplica(t, s, "doc", 0)

	// Inject a write that lands after the read phase but before repair.
	s.BeforeRepair = func() {
		s.BeforeRepair = nil
		if err := s.Write("doc", []byte("beta"), 2); err != nil {
			t.Errorf("concurrent Write: %v", err)
		}
	}
	res, err := s.Read("doc")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	// The read itself returns the majority value observed at read time.
	if res.Version != 1 || string(res.Data) != "alpha" {
		t.Fatalf("got version=%d data=%q", res.Version, res.Data)
	}
	// Repair must detect the concurrent write and leave the replica alone.
	if !hasAnomaly(res, AnomalyConcurrentWrite, 0) {
		t.Fatalf("anomalies: %+v", res.Anomalies)
	}
	if hasAnomaly(res, AnomalyRepaired, 0) {
		t.Fatalf("repair should have been skipped: %+v", res.Anomalies)
	}
	ev := s.Verify("doc")
	for _, re := range ev.Replicas {
		if re.Status != StatusOK || re.Version != 2 {
			t.Fatalf("replica %d: %+v", re.Replica, re)
		}
	}
	if !ev.Monotonic {
		t.Fatalf("history not monotonic: %v", ev.History)
	}
	for replica, seq := range ev.History {
		want := []uint64{1, 2}
		if len(seq) != len(want) {
			t.Fatalf("replica %d history %v, want %v", replica, seq, want)
		}
		for i := range want {
			if seq[i] != want[i] {
				t.Fatalf("replica %d history %v, want %v", replica, seq, want)
			}
		}
	}
}

func TestVerifyReportsDamageWithoutRead(t *testing.T) {
	s := newStore(t)
	if err := s.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	corruptReplica(t, s, "doc", 0)
	removeReplica(t, s, "doc", 1)

	ev := s.Verify("doc")
	if ev.Replicas[0].Status != StatusCorrupt {
		t.Fatalf("replica 0: %+v", ev.Replicas[0])
	}
	if ev.Replicas[1].Status != StatusMissing {
		t.Fatalf("replica 1: %+v", ev.Replicas[1])
	}
	if ev.Replicas[2].Status != StatusOK || ev.Replicas[2].Version != 1 {
		t.Fatalf("replica 2: %+v", ev.Replicas[2])
	}
	if !ev.Monotonic {
		t.Fatal("expected monotonic history")
	}
}

func TestReopenStoreKeepsData(t *testing.T) {
	root := t.TempDir()
	s, err := NewStore(root)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := s.Write("doc", []byte("alpha"), 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	s2, err := NewStore(root)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	res, err := s2.Read("doc")
	if err != nil || res.Version != 1 || string(res.Data) != "alpha" {
		t.Fatalf("Read after reopen: %v %+v", err, res)
	}
	// Version rules still apply after reopen.
	if err := s2.Write("doc", []byte("nope"), 1); !errors.Is(err, ErrVersionNotIncreasing) {
		t.Fatalf("want ErrVersionNotIncreasing, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "replica-0")); err != nil {
		t.Fatalf("replica dir: %v", err)
	}
}
