package formal

import (
	"bytes"
	"context"
	"errors"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
)

var errInjected = errors.New("injected node failure")

// testNode wraps a MemoryNode with failure and latency controls.
type testNode struct {
	inner *MemoryNode

	failPutFrom uint64 // reject puts at or above this version when non-zero
	failGet     atomic.Bool

	gate        <-chan struct{}
	gateEntered chan<- struct{}
	wg          *sync.WaitGroup
}

func (n *testNode) Put(ctx context.Context, fragment Fragment) error {
	if n.failPutFrom != 0 && fragment.Version >= n.failPutFrom {
		return errInjected
	}
	return n.inner.Put(ctx, fragment)
}

func (n *testNode) Get(ctx context.Context, objectID string, index int, maxVersion uint64) (Fragment, error) {
	if n.wg != nil {
		defer n.wg.Done()
	}
	if n.failGet.Load() {
		return Fragment{}, errInjected
	}
	fragment, err := n.inner.Get(ctx, objectID, index, maxVersion)
	if err != nil {
		return Fragment{}, err
	}
	if n.gateEntered != nil {
		n.gateEntered <- struct{}{}
	}
	if n.gate != nil {
		select {
		case <-n.gate:
		case <-ctx.Done():
			return Fragment{}, ctx.Err()
		}
	}
	return fragment, nil
}

type testCluster struct {
	cluster *Cluster
	nodes   []*testNode
}

func newTestCluster(t *testing.T, k, m, writeQuorum, readQuorum int) *testCluster {
	t.Helper()
	nodes := make([]*testNode, k+m)
	interfaces := make([]Node, k+m)
	for i := range nodes {
		nodes[i] = &testNode{inner: NewMemoryNode()}
		interfaces[i] = nodes[i]
	}
	cluster, err := NewCluster(QuorumConfig{
		DataShards:   k,
		ParityShards: m,
		WriteQuorum:  writeQuorum,
		ReadQuorum:   readQuorum,
	}, interfaces)
	if err != nil {
		t.Fatalf("NewCluster: %v", err)
	}
	return &testCluster{cluster: cluster, nodes: nodes}
}

func TestClusterQuorumWriteReadDegraded(t *testing.T) {
	const k, m = 4, 2
	tc := newTestCluster(t, k, m, 4, 4)
	ctx := context.Background()
	rng := rand.New(rand.NewSource(100))
	data := randomBytes(rng, 57) // deliberately not a multiple of k

	version, err := tc.cluster.Write(ctx, "obj", data)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if version != 1 {
		t.Fatalf("version = %d, want 1", version)
	}

	for i := 0; i < 2; i++ {
		fragment, err := tc.nodes[i].inner.Get(ctx, "obj", i, ^uint64(0))
		if err != nil {
			t.Fatalf("node %d: %v", i, err)
		}
		if fragment.Version != version || fragment.DataLen != len(data) {
			t.Fatalf("node %d metadata: %+v", i, fragment)
		}
	}

	got, gotVersion, err := tc.cluster.ReadVersion(ctx, "obj")
	if err != nil {
		t.Fatalf("ReadVersion: %v", err)
	}
	if gotVersion != version || !bytes.Equal(got, data) {
		t.Fatalf("read version %d, bytes equal=%v", gotVersion, bytes.Equal(got, data))
	}

	// Losing both parity shards must degrade to a data-only read.
	tc.nodes[4].failGet.Store(true)
	tc.nodes[5].failGet.Store(true)
	got, err = tc.cluster.Read(ctx, "obj")
	if err != nil {
		t.Fatalf("degraded read: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("degraded read returned different bytes")
	}

	// One more loss leaves fewer than k shards of the committed version.
	tc.nodes[3].failGet.Store(true)
	if _, err := tc.cluster.Read(ctx, "obj"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("read with 3 of 4 shards: err=%v, want ErrUnavailable", err)
	}
}

func TestClusterFailedWriteDoesNotCommit(t *testing.T) {
	const k, m = 3, 2
	tc := newTestCluster(t, k, m, 4, 3)
	ctx := context.Background()
	rng := rand.New(rand.NewSource(101))
	first := randomBytes(rng, 41)
	second := randomBytes(rng, 41)

	v1, err := tc.cluster.Write(ctx, "obj", first)
	if err != nil {
		t.Fatalf("first Write: %v", err)
	}

	// Only three nodes accept v2; the write quorum of four is missed.
	tc.nodes[3].failPutFrom = 2
	tc.nodes[4].failPutFrom = 2
	if _, err := tc.cluster.Write(ctx, "obj", second); !errors.Is(err, ErrQuorum) {
		t.Fatalf("second Write err=%v, want ErrQuorum", err)
	}
	if version, ok := tc.cluster.CommittedVersion("obj"); !ok || version != v1 {
		t.Fatalf("committed version = %d (ok=%v), want %d", version, ok, v1)
	}

	// Uncommitted v2 exists on three nodes but must remain invisible.
	for i := 0; i < 3; i++ {
		versions := tc.nodes[i].inner.Versions("obj")
		found := false
		for _, version := range versions {
			if version == 2 {
				found = true
			}
		}
		if !found {
			t.Fatalf("node %d does not have the failed v2 fragment; versions=%v", i, versions)
		}
	}

	got, gotVersion, err := tc.cluster.ReadVersion(ctx, "obj")
	if err != nil {
		t.Fatalf("ReadVersion after failed write: %v", err)
	}
	if gotVersion != v1 || !bytes.Equal(got, first) {
		t.Fatalf("read v%d equal=%v, want v%d", gotVersion, bytes.Equal(got, first), v1)
	}
}

func TestClusterUnknownAndUncommittedObject(t *testing.T) {
	const k, m = 2, 1
	tc := newTestCluster(t, k, m, 2, 2)
	ctx := context.Background()

	if _, err := tc.cluster.Read(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Read unknown object err=%v, want ErrNotFound", err)
	}

	for i := 0; i < k+m; i++ {
		tc.nodes[i].failPutFrom = 1
	}
	if _, err := tc.cluster.Write(ctx, "never", []byte("payload")); !errors.Is(err, ErrQuorum) {
		t.Fatalf("Write with no acks err=%v, want ErrQuorum", err)
	}
	if _, ok := tc.cluster.CommittedVersion("never"); ok {
		t.Fatal("failed first write created a commit watermark")
	}
	if _, err := tc.cluster.Read(ctx, "never"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Read after failed first write err=%v, want ErrNotFound", err)
	}
}

func TestClusterLateStaleShardsNeverMixed(t *testing.T) {
	const k, m = 3, 2
	// W=3, R=4 makes the reader wait for one stale response before it can
	// finish, so both ignored and late stale shards are exercised.
	tc := newTestCluster(t, k, m, 3, 4)
	ctx := context.Background()
	rng := rand.New(rand.NewSource(102))
	first := randomBytes(rng, 3*17)
	second := randomBytes(rng, 3*17)

	v1, err := tc.cluster.Write(ctx, "obj", first)
	if err != nil {
		t.Fatalf("first Write: %v", err)
	}
	// Nodes 3 and 4 keep v1; nodes 0..2 receive and commit v2.
	tc.nodes[3].failPutFrom = 2
	tc.nodes[4].failPutFrom = 2
	v2, err := tc.cluster.Write(ctx, "obj", second)
	if err != nil {
		t.Fatalf("second Write: %v", err)
	}
	if v2 != v1+1 {
		t.Fatalf("versions %d then %d, want consecutive", v1, v2)
	}

	lateGate := make(chan struct{})
	fastGate := make(chan struct{})
	entered := make(chan struct{}, 1)
	var lateWG sync.WaitGroup
	lateWG.Add(1)
	// Node 4 captures v1 and blocks, then is released only after the read
	// has already reconstructed v2.
	tc.nodes[4].gate = lateGate
	tc.nodes[4].gateEntered = entered
	tc.nodes[4].wg = &lateWG
	// Node 2 holds back a v2 shard until node 4 has captured its stale copy,
	// making the interleaving deterministic.
	tc.nodes[2].gate = fastGate

	type result struct {
		data    []byte
		version uint64
		err     error
	}
	resultCh := make(chan result, 1)
	go func() {
		data, version, err := tc.cluster.ReadVersion(ctx, "obj")
		resultCh <- result{data: data, version: version, err: err}
	}()

	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("timed out waiting for stale shard fetch")
	}
	close(fastGate)

	res := <-resultCh
	if res.err != nil {
		t.Fatalf("ReadVersion: %v", res.err)
	}
	if res.version != v2 {
		t.Fatalf("served version %d, want %d", res.version, v2)
	}
	if !bytes.Equal(res.data, second) {
		t.Fatalf("served bytes are not v%d (equal to v1: %v)", v2, bytes.Equal(res.data, first))
	}

	// The stale v1 block arrives after reconstruction; it must not alter the
	// result (which has already been returned).
	close(lateGate)
	lateWG.Wait()
	if !bytes.Equal(res.data, second) {
		t.Fatal("late block mutated the decoded snapshot")
	}
}

func TestClusterRefusesToMixInsufficientNewVersion(t *testing.T) {
	const k, m = 3, 2
	tc := newTestCluster(t, k, m, 3, 3)
	ctx := context.Background()
	rng := rand.New(rand.NewSource(103))
	first := randomBytes(rng, 3*9)
	second := randomBytes(rng, 3*9)

	v1, err := tc.cluster.Write(ctx, "obj", first)
	if err != nil {
		t.Fatalf("first Write: %v", err)
	}
	tc.nodes[3].failPutFrom = 2
	tc.nodes[4].failPutFrom = 2
	v2, err := tc.cluster.Write(ctx, "obj", second)
	if err != nil {
		t.Fatalf("second Write: %v", err)
	}
	if v2 != v1+1 {
		t.Fatalf("versions %d then %d, want consecutive", v1, v2)
	}

	// Only two v2 fragments remain reachable; three complete v1 fragments are
	// still available.  Mixing them would yield garbage, so the read must fail.
	tc.nodes[2].failGet.Store(true)
	_, gotVersion, err := tc.cluster.ReadVersion(ctx, "obj")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("ReadVersion err=%v, want ErrUnavailable", err)
	}
	if gotVersion != 0 {
		t.Fatalf("failed read reported version %d", gotVersion)
	}

	// Sanity check: the stale version really is available and complete.
	stale := make([][]byte, k+m)
	for i := 0; i < k+m; i++ {
		fragment, err := tc.nodes[i].inner.Get(ctx, "obj", i, v1)
		if err != nil {
			t.Fatalf("get v1 shard %d: %v", i, err)
		}
		stale[i] = fragment.Data
	}
	decoded, err := tc.cluster.Codec().ReconstructData(stale, len(first))
	if err != nil || !bytes.Equal(decoded, first) {
		t.Fatalf("stale version unavailable: err=%v equal=%v", err, bytes.Equal(decoded, first))
	}
}

func TestClusterConcurrentWritesAndReadsNeverMix(t *testing.T) {
	const k, m = 3, 2
	tc := newTestCluster(t, k, m, 3, 3)
	ctx := context.Background()
	rng := rand.New(rand.NewSource(104))

	const versions = 24
	payloads := make(map[uint64][]byte, versions)
	for i := 0; i < versions; i++ {
		data := randomBytes(rng, 3*23)
		// Make every version trivially distinguishable.
		for j := range data {
			data[j] ^= byte(i + 1)
		}
		payloads[uint64(i+1)] = data
	}

	var readers sync.WaitGroup
	errCh := make(chan error, 512)
	if _, err := tc.cluster.Write(ctx, "obj", payloads[1]); err != nil {
		t.Fatalf("Write v1: %v", err)
	}
	for i := 1; i < versions; i++ {
		for r := 0; r < 8; r++ {
			readers.Add(1)
			go func() {
				defer readers.Done()
				data, version, err := tc.cluster.ReadVersion(ctx, "obj")
				if err != nil {
					select {
					case errCh <- err:
					default:
					}
					return
				}
				want, ok := payloads[version]
				if !ok || !bytes.Equal(data, want) {
					select {
					case errCh <- errors.New("read returned bytes from a mixed or unknown version"):
					default:
					}
				}
			}()
		}
		if _, err := tc.cluster.Write(ctx, "obj", payloads[uint64(i+1)]); err != nil {
			t.Fatalf("Write v%d: %v", i+1, err)
		}
	}
	readers.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
}

func TestClusterEmptyObject(t *testing.T) {
	tc := newTestCluster(t, 2, 1, 2, 2)
	ctx := context.Background()
	version, err := tc.cluster.Write(ctx, "empty", nil)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	data, gotVersion, err := tc.cluster.ReadVersion(ctx, "empty")
	if err != nil {
		t.Fatalf("ReadVersion: %v", err)
	}
	if gotVersion != version || len(data) != 0 {
		t.Fatalf("got version %d len %d", gotVersion, len(data))
	}
}

func TestClusterConfigValidation(t *testing.T) {
	makeNodes := func(n int) []Node {
		nodes := make([]Node, n)
		for i := range nodes {
			nodes[i] = NewMemoryNode()
		}
		return nodes
	}

	cases := []struct {
		name string
		cfg  QuorumConfig
		n    int
	}{
		{"write below k", QuorumConfig{3, 2, 2, 3}, 5},
		{"read below k", QuorumConfig{3, 2, 3, 2}, 5},
		{"write above n", QuorumConfig{3, 2, 6, 3}, 5},
		{"read above n", QuorumConfig{3, 2, 3, 6}, 5},
		{"quorums do not intersect", QuorumConfig{3, 2, 3, 2}, 5},
		{"wrong node count", QuorumConfig{3, 2, 3, 3}, 4},
		{"invalid codec", QuorumConfig{0, 1, 1, 1}, 1},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewCluster(tc.cfg, makeNodes(tc.n)); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("err=%v, want ErrInvalidConfig", err)
			}
		})
	}

	if _, err := NewCluster(QuorumConfig{3, 2, 3, 3}, makeNodes(5)); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestClusterReadContextCancellation(t *testing.T) {
	const k, m = 2, 1
	tc := newTestCluster(t, k, m, 2, 2)
	if _, err := tc.cluster.Write(context.Background(), "obj", []byte("abcdef")); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	defer close(gate)
	for i := 0; i < k+m; i++ {
		tc.nodes[i].gate = gate
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := tc.cluster.ReadVersion(ctx, "obj"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v, want context.Canceled", err)
	}
}
