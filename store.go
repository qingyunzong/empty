package shardmig

import (
	"fmt"
	"sync"
)

// Migration tracks an in-flight range move from Src to Dst. During the
// migration Src forwards messages for Range to Dst, and Dst only commits
// the new generation NewEpoch.
type Migration struct {
	Src       *Shard
	Dst       *Shard
	Range     Range
	NewEpoch  uint64
	prevEpoch uint64 // Dst's generation before the migration
	done      bool
}

// Store routes messages to shards by key range and drives migrations.
type Store struct {
	mu     sync.RWMutex
	routes []route
	epoch  uint64
}

type route struct {
	rng Range
	sh  *Shard
}

// NewStore returns an empty store whose generation counter starts at 1.
func NewStore() *Store {
	return &Store{epoch: 1}
}

// AddShard registers shard as the owner of rngs.
func (s *Store) AddShard(shard *Shard, rngs ...Range) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rng := range rngs {
		if rng.empty() {
			return fmt.Errorf("shardmig: empty range [%q, %q)", rng.Lo, rng.Hi)
		}
		for _, r := range s.routes {
			if overlaps(r.rng, rng) {
				return fmt.Errorf("%w: [%q, %q)", ErrOverlap, rng.Lo, rng.Hi)
			}
		}
	}
	for _, rng := range rngs {
		s.routes = append(s.routes, route{rng: rng, sh: shard})
	}
	return nil
}

// Owner returns the shard currently routing key. During a migration this is
// still the old shard, which forwards to the new one.
func (s *Store) Owner(key string) (*Shard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.routes {
		if r.rng.Contains(key) {
			return r.sh, nil
		}
	}
	return nil, fmt.Errorf("%w: %q", ErrNoRoute, key)
}

// Process routes a discrete message to its owner and commits it exactly
// once, following forwards across an in-flight migration.
func (s *Store) Process(m Message) error {
	sh, err := s.Owner(m.Key)
	if err != nil {
		return err
	}
	return sh.apply(m)
}

// BeginMigration starts moving rng, a sub-range of a route owned by src,
// to dst. It allocates a new generation: until Complete or Abort, src
// forwards rng's messages to dst and dst commits only the new generation.
func (s *Store) BeginMigration(src, dst *Shard, rng Range) (*Migration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rng.empty() {
		return nil, fmt.Errorf("shardmig: empty range [%q, %q)", rng.Lo, rng.Hi)
	}
	ok := false
	for _, r := range s.routes {
		if r.sh == src && containsRange(r.rng, rng) {
			ok = true
			break
		}
	}
	if !ok {
		return nil, fmt.Errorf("shardmig: range [%q, %q) not routed to shard %q", rng.Lo, rng.Hi, src.ID())
	}
	s.epoch++
	m := &Migration{
		Src:       src,
		Dst:       dst,
		Range:     rng,
		NewEpoch:  s.epoch,
		prevEpoch: dst.Epoch(),
	}
	src.mu.Lock()
	dst.mu.Lock()
	src.forwards = append(src.forwards, forward{rng: rng, dst: dst})
	dst.epoch = m.NewEpoch
	dst.mu.Unlock()
	src.mu.Unlock()
	return m, nil
}

// Complete atomically moves rng's data and processed IDs to the new shard,
// cuts the route over and clears forwarding. It is idempotent: retrying
// after an interruption converges to the same complete state.
func (s *Store) Complete(m *Migration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m.done {
		return nil
	}
	m.Src.mu.Lock()
	m.Dst.mu.Lock()
	if !m.Src.hasForward(m.Range, m.Dst) {
		m.Dst.mu.Unlock()
		m.Src.mu.Unlock()
		return fmt.Errorf("%w: [%q, %q)", ErrNotMigrating, m.Range.Lo, m.Range.Hi)
	}
	transfer(m.Src, m.Dst, m.Range)
	m.Src.forwards = removeForward(m.Src.forwards, m.Range, m.Dst)
	m.Dst.mu.Unlock()
	m.Src.mu.Unlock()
	s.cutover(m.Src, m.Dst, m.Range)
	m.done = true
	return nil
}

// Abort rolls back an interrupted migration: state for rng already accepted
// by the new shard moves back to the old shard, forwarding is cleared and
// generations are restored, leaving a complete and consistent state.
func (s *Store) Abort(m *Migration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m.done {
		return nil
	}
	m.Src.mu.Lock()
	m.Dst.mu.Lock()
	if !m.Src.hasForward(m.Range, m.Dst) {
		m.Dst.mu.Unlock()
		m.Src.mu.Unlock()
		return fmt.Errorf("%w: [%q, %q)", ErrNotMigrating, m.Range.Lo, m.Range.Hi)
	}
	transfer(m.Dst, m.Src, m.Range)
	m.Src.forwards = removeForward(m.Src.forwards, m.Range, m.Dst)
	m.Dst.epoch = m.prevEpoch
	m.Dst.mu.Unlock()
	m.Src.mu.Unlock()
	m.done = true
	return nil
}

// cutover replaces src's route for rng with dst, splitting the old route
// into its remaining left and right parts. s.mu must be held.
func (s *Store) cutover(src, dst *Shard, rng Range) {
	var next []route
	for _, r := range s.routes {
		if r.sh != src || !containsRange(r.rng, rng) {
			next = append(next, r)
			continue
		}
		if left := (Range{Lo: r.rng.Lo, Hi: rng.Lo}); !left.empty() {
			next = append(next, route{rng: left, sh: src})
		}
		if right := (Range{Lo: rng.Hi, Hi: r.rng.Hi}); rng.Hi != "" && !right.empty() {
			next = append(next, route{rng: right, sh: src})
		}
	}
	next = append(next, route{rng: rng, sh: dst})
	s.routes = next
}
