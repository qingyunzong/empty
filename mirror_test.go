package mirrorstore

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	base := t.TempDir()
	var dirs [ReplicaCount]string
	for i := range dirs {
		dirs[i] = filepath.Join(base, fmt.Sprintf("replica-%d", i))
	}
	store, err := Open(dirs)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return store
}

// putDirect writes a valid record straight into one replica directory,
// bypassing the Store, to pre-arrange states or simulate external actors.
func putDirect(t *testing.T, store *Store, replica int, key string, version uint64, data []byte) {
	t.Helper()
	rec := record{Version: version, Sum: checksumHex(data), Data: data}
	if err := writeRecord(store.path(replica, key), &rec); err != nil {
		t.Fatalf("putDirect: %v", err)
	}
}

// putRaw writes arbitrary bytes as a replica file, bypassing the Store.
func putRaw(t *testing.T, store *Store, replica int, key string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(store.path(replica, key), raw, 0o644); err != nil {
		t.Fatalf("putRaw: %v", err)
	}
}

func rawVersion(t *testing.T, store *Store, replica int, key string) uint64 {
	t.Helper()
	view := inspect(store.path(replica, key))
	if view.rec == nil {
		t.Fatalf("replica %d: no parseable record for key %q", replica, key)
	}
	return view.rec.Version
}

func TestReadMajoritySuccessAndEvidence(t *testing.T) {
	store := newStore(t)
	payload := []byte("v3-payload")
	if err := store.Write("alpha", 3, payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	res, err := store.Read("alpha")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 3 {
		t.Errorf("Version = %d, want 3", res.Version)
	}
	if string(res.Data) != string(payload) {
		t.Errorf("Data = %q, want %q", res.Data, payload)
	}
	wantDigest := sha256.Sum256(payload)
	for i, ev := range res.Evidence {
		if ev.State != StateOK {
			t.Errorf("evidence[%d].State = %v, want ok", i, ev.State)
		}
		if !ev.VersionKnown || ev.Version != 3 {
			t.Errorf("evidence[%d].Version = %d (known=%v), want 3", i, ev.Version, ev.VersionKnown)
		}
		if !ev.SumOK {
			t.Errorf("evidence[%d].SumOK = false, want true", i)
		}
		if ev.Digest != wantDigest {
			t.Errorf("evidence[%d].Digest mismatch", i)
		}
		if ev.Repaired || ev.SkippedHigher {
			t.Errorf("evidence[%d] unexpectedly repaired/skipped", i)
		}
	}
}

func TestReadRepairCorruptReplica(t *testing.T) {
	store := newStore(t)
	if err := store.Write("k", 2, []byte("data-2")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Corrupt replica 1: parseable record, but checksum does not match.
	putRaw(t, store, 1, "k", []byte(`{"version":2,"sum":"deadbeef","data":"aGVsbG8="}`))

	res, err := store.Read("k")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 2 || string(res.Data) != "data-2" {
		t.Errorf("got version %d data %q, want 2 / data-2", res.Version, res.Data)
	}
	ev := res.Evidence[1]
	if ev.State != StateCorrupt {
		t.Errorf("corrupt replica state = %v, want corrupt", ev.State)
	}
	if !ev.VersionKnown || ev.Version != 2 {
		t.Errorf("corrupt replica version = %d (known=%v), want 2", ev.Version, ev.VersionKnown)
	}
	if ev.SumOK {
		t.Errorf("corrupt replica SumOK = true, want false")
	}
	if !ev.Repaired {
		t.Errorf("corrupt replica was not repaired")
	}
	for _, i := range []int{0, 2} {
		if res.Evidence[i].State != StateOK || res.Evidence[i].Repaired {
			t.Errorf("healthy replica %d: state=%v repaired=%v", i, res.Evidence[i].State, res.Evidence[i].Repaired)
		}
	}
	// After repair the replica file is valid again at the majority version.
	view := inspect(store.path(1, "k"))
	if view.rec == nil || view.rec.Version != 2 || !view.sumOK {
		t.Fatalf("replica 1 after repair: %+v, want valid version 2", view)
	}
}

func TestReadRepairMissingReplica(t *testing.T) {
	store := newStore(t)
	if err := store.Write("k", 4, []byte("data-4")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := os.Remove(store.path(2, "k")); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	res, err := store.Read("k")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	ev := res.Evidence[2]
	if ev.State != StateMissing {
		t.Errorf("missing replica state = %v, want missing", ev.State)
	}
	if ev.VersionKnown {
		t.Errorf("missing replica VersionKnown = true, want false")
	}
	if !ev.Repaired {
		t.Errorf("missing replica was not repaired")
	}
	if got := rawVersion(t, store, 2, "k"); got != 4 {
		t.Errorf("replica 2 version after repair = %d, want 4", got)
	}
}

func TestReadRepairStaleReplica(t *testing.T) {
	store := newStore(t)
	putDirect(t, store, 0, "k", 7, []byte("data-7"))
	putDirect(t, store, 1, "k", 7, []byte("data-7"))
	putDirect(t, store, 2, "k", 3, []byte("data-3")) // valid but old

	res, err := store.Read("k")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 7 || string(res.Data) != "data-7" {
		t.Errorf("got version %d data %q, want 7 / data-7", res.Version, res.Data)
	}
	ev := res.Evidence[2]
	if ev.State != StateStale {
		t.Errorf("stale replica state = %v, want stale", ev.State)
	}
	if !ev.Repaired {
		t.Errorf("stale replica was not repaired")
	}
	if got := rawVersion(t, store, 2, "k"); got != 7 {
		t.Errorf("replica 2 version after repair = %d, want 7", got)
	}
}

func TestReadNoMajorityReturnsEvidence(t *testing.T) {
	store := newStore(t)
	putDirect(t, store, 0, "k", 1, []byte("one"))
	putDirect(t, store, 1, "k", 2, []byte("two"))
	putDirect(t, store, 2, "k", 3, []byte("three"))

	res, err := store.Read("k")
	if !errors.Is(err, ErrNoMajority) {
		t.Fatalf("Read err = %v, want ErrNoMajority", err)
	}
	if res == nil {
		t.Fatalf("Read result is nil, want evidence")
	}
	for i, ev := range res.Evidence {
		want := uint64(i + 1)
		if ev.State != StateOK || !ev.VersionKnown || ev.Version != want {
			t.Errorf("evidence[%d] = state %v version %d, want ok / %d", i, ev.State, ev.Version, want)
		}
		if ev.Repaired {
			t.Errorf("evidence[%d] repaired without a majority", i)
		}
	}
	// No majority => no repair: files are untouched.
	for i := 0; i < ReplicaCount; i++ {
		if got := rawVersion(t, store, i, "k"); got != uint64(i+1) {
			t.Errorf("replica %d version = %d, want %d (untouched)", i, got, i+1)
		}
	}
}

func TestReadNotFound(t *testing.T) {
	store := newStore(t)
	res, err := store.Read("nope")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Read err = %v, want ErrNotFound", err)
	}
	for i, ev := range res.Evidence {
		if ev.State != StateMissing {
			t.Errorf("evidence[%d].State = %v, want missing", i, ev.State)
		}
	}
}

func TestRepairNeverOverwritesHigherVersion(t *testing.T) {
	store := newStore(t)
	putDirect(t, store, 0, "k", 5, []byte("data-5"))
	putDirect(t, store, 2, "k", 5, []byte("data-5"))
	putDirect(t, store, 1, "k", 9, []byte("data-9")) // ahead of the majority

	res, err := store.Read("k")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Version != 5 {
		t.Errorf("Version = %d, want majority 5", res.Version)
	}
	ev := res.Evidence[1]
	if ev.State != StateOK || ev.Version != 9 {
		t.Errorf("higher replica evidence = state %v version %d, want ok / 9", ev.State, ev.Version)
	}
	if !ev.SkippedHigher || ev.Repaired {
		t.Errorf("higher replica: SkippedHigher=%v Repaired=%v, want true/false", ev.SkippedHigher, ev.Repaired)
	}
	if got := rawVersion(t, store, 1, "k"); got != 9 {
		t.Errorf("replica 1 version = %d, want 9 (not overwritten)", got)
	}
}

func TestRepairDoesNotClobberWriteDuringRepair(t *testing.T) {
	store := newStore(t)
	putDirect(t, store, 0, "k", 5, []byte("data-5"))
	putDirect(t, store, 2, "k", 5, []byte("data-5"))
	putRaw(t, store, 1, "k", []byte("not json")) // corrupt, needs repair

	// Simulate an external writer landing a newer record on replica 1
	// after the majority was established but before the repair write.
	hookRan := false
	store.beforeRepairWrite = func(replica int, version uint64) {
		if replica == 1 {
			hookRan = true
			putDirect(t, store, 1, "k", 9, []byte("concurrent-9"))
		}
	}

	res, err := store.Read("k")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !hookRan {
		t.Fatalf("beforeRepairWrite hook did not run")
	}
	if res.Version != 5 || string(res.Data) != "data-5" {
		t.Errorf("got version %d data %q, want 5 / data-5", res.Version, res.Data)
	}
	ev := res.Evidence[1]
	if ev.State != StateCorrupt {
		t.Errorf("evidence state = %v, want corrupt (as observed at read time)", ev.State)
	}
	if !ev.SkippedHigher || ev.Repaired {
		t.Errorf("repair of replica 1: SkippedHigher=%v Repaired=%v, want true/false", ev.SkippedHigher, ev.Repaired)
	}
	// The concurrent higher write survives the repair.
	view := inspect(store.path(1, "k"))
	if view.rec == nil || view.rec.Version != 9 || string(view.rec.Data) != "concurrent-9" {
		t.Fatalf("replica 1 after repair = %+v, want version 9 concurrent-9", view.rec)
	}
}

func TestWriteStrictlyIncreasing(t *testing.T) {
	store := newStore(t)
	if err := store.Write("k", 5, []byte("v5")); err != nil {
		t.Fatalf("Write(5): %v", err)
	}
	if err := store.Write("k", 5, []byte("again")); !errors.Is(err, ErrVersionRegression) {
		t.Errorf("Write(5) err = %v, want ErrVersionRegression", err)
	}
	if err := store.Write("k", 4, []byte("older")); !errors.Is(err, ErrVersionRegression) {
		t.Errorf("Write(4) err = %v, want ErrVersionRegression", err)
	}
	if err := store.Write("k", 6, []byte("v6")); err != nil {
		t.Fatalf("Write(6): %v", err)
	}
	// A corrupt-but-parseable high version on one replica still raises the bar.
	putRaw(t, store, 2, "k", []byte(`{"version":10,"sum":"deadbeef","data":"eA=="}`))
	if err := store.Write("k", 7, []byte("v7")); !errors.Is(err, ErrVersionRegression) {
		t.Errorf("Write(7) err = %v, want ErrVersionRegression (replica 2 is at 10)", err)
	}
	if err := store.Write("k", 11, []byte("v11")); err != nil {
		t.Fatalf("Write(11): %v", err)
	}
	for i := 0; i < ReplicaCount; i++ {
		if got := rawVersion(t, store, i, "k"); got != 11 {
			t.Errorf("replica %d version = %d, want 11", i, got)
		}
	}
}

func TestConcurrentWriteAndRepairVersionsMonotonic(t *testing.T) {
	store := newStore(t)
	putDirect(t, store, 0, "hot", 1, []byte("v1"))
	putDirect(t, store, 1, "hot", 1, []byte("v1"))
	putRaw(t, store, 2, "hot", []byte("garbage")) // forces read-repair

	var histMu sync.Mutex
	histories := make(map[int][]uint64)
	store.afterWrite = func(replica int, version uint64) {
		histMu.Lock()
		histories[replica] = append(histories[replica], version)
		histMu.Unlock()
	}

	const writes = 60
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for v := uint64(2); v <= writes; v++ {
			if err := store.Write("hot", v, []byte(fmt.Sprintf("v%d", v))); err != nil {
				t.Errorf("Write(%d): %v", v, err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < writes; i++ {
			res, err := store.Read("hot")
			if err != nil {
				t.Errorf("Read: %v", err)
				return
			}
			if res.Version < 1 {
				t.Errorf("Read returned version %d", res.Version)
				return
			}
		}
	}()
	wg.Wait()

	// Every write ever applied to a replica carries a strictly higher
	// version than the previous write to that replica.
	histMu.Lock()
	defer histMu.Unlock()
	for replica := 0; replica < ReplicaCount; replica++ {
		seq := histories[replica]
		if len(seq) == 0 {
			t.Errorf("replica %d was never written", replica)
			continue
		}
		for i := 1; i < len(seq); i++ {
			if seq[i] <= seq[i-1] {
				t.Fatalf("replica %d version regressed: history %v", replica, seq)
			}
		}
	}
	// Final state: all replicas converge on the last version.
	for i := 0; i < ReplicaCount; i++ {
		if got := rawVersion(t, store, i, "hot"); got != writes {
			t.Errorf("replica %d final version = %d, want %d", i, got, writes)
		}
	}
}
