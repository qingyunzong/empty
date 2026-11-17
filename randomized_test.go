package formal

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"
)

// chaosStore injects packet loss, lost replies, failed reads, and resource
// version bumps. Failures are per call, as they would be on a real network.
type chaosStore struct {
	inner Store

	mu      sync.Mutex
	rng     *rand.Rand
	faults  bool
	offline bool
}

func newChaosStore(inner Store, seed int64) *chaosStore {
	return &chaosStore{
		inner:  inner,
		rng:    rand.New(rand.NewSource(seed)),
		faults: true,
	}
}

func (s *chaosStore) setFaults(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.faults = enabled
}

func (s *chaosStore) setOffline(offline bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.offline = offline
}

func (s *chaosStore) roll() (offline bool, roll int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.offline {
		return true, 0
	}
	if !s.faults {
		return false, 100
	}
	return false, s.rng.Intn(100)
}

func (s *chaosStore) Get(ctx context.Context, key LeaseKey) (Lease, bool, error) {
	offline, roll := s.roll()
	if offline || roll < 4 {
		return Lease{}, false, fmt.Errorf("%w: read", errInjected)
	}
	return s.inner.Get(ctx, key)
}

func (s *chaosStore) Create(ctx context.Context, lease Lease) (Lease, error) {
	offline, roll := s.roll()
	if offline || roll < 8 {
		return Lease{}, fmt.Errorf("%w: create", errInjected)
	}
	created, err := s.inner.Create(ctx, lease)
	if err != nil {
		return Lease{}, err
	}
	if roll < 12 {
		return Lease{}, fmt.Errorf("%w: lost create reply", errInjected)
	}
	return created, nil
}

func (s *chaosStore) Update(ctx context.Context, lease Lease, expected uint64) (Lease, error) {
	offline, roll := s.roll()
	if offline || roll < 8 {
		return Lease{}, fmt.Errorf("%w: update", errInjected)
	}
	if roll < 13 {
		_, err := s.inner.Update(ctx, lease, expected)
		if err != nil {
			return Lease{}, err
		}
		return Lease{}, fmt.Errorf("%w: lost update reply", errInjected)
	}
	if roll < 18 {
		current, ok, err := s.inner.Get(ctx, lease.Key())
		if err != nil {
			return Lease{}, err
		}
		if !ok {
			return Lease{}, ErrLeaseNotFound
		}
		if _, err := s.inner.Update(ctx, current, current.ResourceVersion); err != nil {
			return Lease{}, err
		}
		return Lease{}, ErrResourceVersionConflict
	}
	return s.inner.Update(ctx, lease, expected)
}

func TestRandomizedNoDualLeaderUnderSkewAndFaults(t *testing.T) {
	const (
		seeds    = 24
		machines = 4
		step     = 20 * time.Millisecond
		duration = 2 * time.Second
		renew    = 400 * time.Millisecond
		skew     = 200 * time.Millisecond
	)

	for seed := int64(0); seed < seeds; seed++ {
		seed := seed
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			base := newManualClock(testEpoch)
			inner := NewMemoryStore()
			rng := rand.New(rand.NewSource(seed * 7919))

			stores := make([]*chaosStore, machines)
			nodes := make([]*Machine, machines)
			for i := 0; i < machines; i++ {
				// Offsets stay in [-skew/2, skew/2], so every pair differs by
				// at most the configured bound.
				offset := time.Duration(rng.Int63n(int64(skew)+1)) - skew/2
				cfg := Config{
					Cluster:        "main",
					LeaseName:      "controller",
					Holder:         fmt.Sprintf("node-%d", i),
					LeaseDuration:  duration,
					RenewInterval:  renew,
					ClockSkewBound: skew,
				}
				stores[i] = newChaosStore(inner, seed*100+int64(i))
				stores[i].setFaults(false)
				nodes[i] = mustMachine(t, cfg, stores[i], skewedClock{base: base, offset: offset})
			}

			check := func(stage string) {
				t.Helper()
				if n := countLeaders(nodes); n > 1 {
					t.Fatalf("%s: %d simultaneous leaders", stage, n)
				}
				requireAtMostOneLeader(t, nodes...)
			}

			tickAll := func(advance time.Duration) {
				base.Advance(advance)
				for _, i := range rng.Perm(machines) {
					_ = nodes[i].Tick(context.Background())
					check(fmt.Sprintf("after tick of %s", nodes[i].Key()))
				}
			}

			// Establish a leader under healthy conditions.
			for i := 0; i < 5; i++ {
				tickAll(step)
			}
			if countLeaders(nodes) != 1 {
				t.Fatalf("healthy cluster has %d leaders", countLeaders(nodes))
			}
			for _, store := range stores {
				store.setFaults(true)
			}

			// Isolate the current leader long enough for a takeover, then heal
			// it. The old leader must not act after its deadline.
			isolated := -1
			for i, node := range nodes {
				if node.IsLeader() {
					isolated = i
					break
				}
			}
			if isolated < 0 {
				t.Fatal("no leader to isolate")
			}
			stores[isolated].setOffline(true)
			for i := 0; i < 300; i++ { // 6s, well past duration+skew
				tickAll(step)
			}
			stores[isolated].setOffline(false)

			// Exercise randomized faults and two more short partitions.
			for i := 0; i < 900; i++ {
				if i == 200 || i == 550 {
					for j, node := range nodes {
						if node.IsLeader() {
							stores[j].setOffline(true)
							break
						}
					}
				}
				if i == 350 || i == 700 {
					for _, store := range stores {
						store.setOffline(false)
					}
				}
				tickAll(step)
			}

			// Heal everything. A single leader must eventually emerge.
			for _, store := range stores {
				store.setOffline(false)
				store.setFaults(false)
			}
			stable := 0
			for i := 0; i < 1500 && stable < 10; i++ {
				tickAll(step)
				if countLeaders(nodes) == 1 {
					stable++
				} else {
					stable = 0
				}
			}
			if stable < 10 {
				t.Fatalf("no stable leader after healing; states = %v", nodeStates(nodes))
			}
		})
	}
}

func nodeStates(nodes []*Machine) []string {
	states := make([]string, len(nodes))
	for i, node := range nodes {
		states[i] = fmt.Sprintf("%s:%s(term=%d)", node.cfg.Holder, node.State(), node.Term())
	}
	return states
}
