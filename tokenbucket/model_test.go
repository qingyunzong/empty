package tokenbucket

import (
	"math/big"
	"math/rand"
	"path/filepath"
	"testing"
)

// ratModel is an exact rational-arithmetic reference model of the bucket.
// It tracks tokens as a big.Rat, so it never loses fractional accrual.
type ratModel struct {
	capacity int64
	num, den int64
	window   int

	tokens  *big.Rat
	last    int64
	hasTime bool

	decided map[string]bool
	order   []string
}

func newRatModel(cfg Config) *ratModel {
	return &ratModel{
		capacity: cfg.Capacity,
		num:      cfg.RateNum,
		den:      cfg.RateDen,
		window:   cfg.Window,
		tokens:   new(big.Rat).SetInt64(cfg.Capacity),
		decided:  make(map[string]bool),
	}
}

func (m *ratModel) refill(now int64) {
	if !m.hasTime {
		m.last = now
		m.hasTime = true
		return
	}
	if now <= m.last {
		return
	}
	dt := now - m.last
	m.last = now
	add := new(big.Rat).SetFrac64(dt*m.num, m.den)
	m.tokens.Add(m.tokens, add)
	if cap := new(big.Rat).SetInt64(m.capacity); m.tokens.Cmp(cap) > 0 {
		m.tokens.Set(cap)
	}
}

func (m *ratModel) allow(id string, cost int64, now int64) bool {
	if d, ok := m.decided[id]; ok {
		return d
	}
	m.refill(now)
	d := m.tokens.Cmp(new(big.Rat).SetInt64(cost)) >= 0
	if d {
		m.tokens.Sub(m.tokens, new(big.Rat).SetInt64(cost))
	}
	if len(m.order) == m.window {
		delete(m.decided, m.order[0])
		m.order = m.order[1:]
	}
	m.decided[id] = d
	m.order = append(m.order, id)
	return d
}

// exactTokens returns the limiter's exact rational token balance:
// whole tokens plus rem/RateDen.
func exactTokens(l *Limiter) *big.Rat {
	tokens, rem, _ := l.State()
	r := new(big.Rat).SetInt64(tokens)
	r.Add(r, new(big.Rat).SetFrac64(rem, l.cfg.RateDen))
	return r
}

// TestAgainstRationalModel drives the persistent limiter and an exact
// rational reference model through identical random operation sequences
// (time advances, rewinds, requests, restarts, truncations) and checks
// that every decision and the exact token balance agree.
func TestAgainstRationalModel(t *testing.T) {
	seeds := []int64{1, 7, 42, 20261005}
	for _, seed := range seeds {
		rng := rand.New(rand.NewSource(seed))
		cfg := Config{Capacity: 8, RateNum: 3, RateDen: 2, Window: 6}
		path := filepath.Join(t.TempDir(), "log")
		l, err := Open(path, cfg)
		if err != nil {
			t.Fatalf("seed %d: Open: %v", seed, err)
		}
		m := newRatModel(cfg)
		now := int64(0)

		for op := 0; op < 2000; op++ {
			switch rng.Intn(10) {
			case 0, 1, 2, 3: // advance time, occasionally backwards
				if rng.Intn(8) == 0 {
					now -= int64(rng.Intn(20)) // clock rewind: must not add tokens
				} else {
					now += int64(rng.Intn(6))
				}
			case 4: // restart: close and reopen, state must survive
				if err := l.Close(); err != nil {
					t.Fatalf("seed %d op %d: Close: %v", seed, op, err)
				}
				l, err = Open(path, cfg)
				if err != nil {
					t.Fatalf("seed %d op %d: reopen: %v", seed, op, err)
				}
			case 5: // truncate the log, keeping the idempotency window
				if err := l.Truncate(); err != nil {
					t.Fatalf("seed %d op %d: Truncate: %v", seed, op, err)
				}
			default: // request from a small ID pool to force duplicates
				id := string(rune('a' + rng.Intn(10)))
				cost := int64(rng.Intn(int(cfg.Capacity) + 2))
				got, err := l.Allow(id, cost, now)
				if err != nil {
					t.Fatalf("seed %d op %d: Allow: %v", seed, op, err)
				}
				want := m.allow(id, cost, now)
				if got != want {
					t.Fatalf("seed %d op %d: id=%q cost=%d now=%d: got %v, model %v",
						seed, op, id, cost, now, got, want)
				}
				if exact := exactTokens(l); exact.Cmp(m.tokens) != 0 {
					t.Fatalf("seed %d op %d: exact balance %s, model %s",
						seed, op, exact.RatString(), m.tokens.RatString())
				}
			}
		}
		if err := l.Close(); err != nil {
			t.Fatalf("seed %d: final Close: %v", seed, err)
		}
	}
}
