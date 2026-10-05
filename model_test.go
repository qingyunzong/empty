package ratelimit

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// tickModel is an independent per-tick simulation of the limiter
// semantics: every tick it refills the exact rational rate, caps at the
// burst, then executes queued reservations in reservation order whenever
// the head of the queue is affordable. Cancellation refunds by simply
// skipping the reservation. It serves as the reference for scheduled
// ticks and refunds.
type tickModel struct {
	rate   *big.Rat
	burst  *big.Rat
	tokens *big.Rat
	tick   int64
	res    []modelRes
}

type modelRes struct {
	cost      int64
	cancelled bool
	executed  bool
	execTick  int64
}

func newTickModel(rateNum, rateDen, burst int64) *tickModel {
	return &tickModel{
		rate:   big.NewRat(rateNum, rateDen),
		burst:  big.NewRat(burst, 1),
		tokens: big.NewRat(burst, 1),
	}
}

func (m *tickModel) executePass() {
	for {
		head := -1
		for i := range m.res {
			if !m.res[i].executed && !m.res[i].cancelled {
				head = i
				break
			}
		}
		if head < 0 {
			return
		}
		cost := big.NewRat(m.res[head].cost, 1)
		if m.tokens.Cmp(cost) < 0 {
			return
		}
		m.tokens.Sub(m.tokens, cost)
		m.res[head].executed = true
		m.res[head].execTick = m.tick
	}
}

func (m *tickModel) advance(to int64) {
	for m.tick < to {
		m.tick++
		m.tokens.Add(m.tokens, m.rate)
		if m.tokens.Cmp(m.burst) > 0 {
			m.tokens.Set(m.burst)
		}
		m.executePass()
	}
}

func (m *tickModel) reserve(cost int64) int {
	m.res = append(m.res, modelRes{cost: cost})
	m.executePass()
	return len(m.res) - 1
}

func (m *tickModel) cancel(i int) bool {
	if m.res[i].executed || m.res[i].cancelled {
		return false
	}
	m.res[i].cancelled = true
	m.executePass() // refunded tokens may execute the head at this tick
	return true
}

// TestAgainstTickModel drives the limiter and the per-tick model with
// identical random operation sequences and cross-checks scheduled ticks,
// cancellation results and refunds.
func TestAgainstTickModel(t *testing.T) {
	configs := []struct {
		num, den, burst int64
		maxCost         int64
		seed            int64
	}{
		{1, 1, 10, 10, 1},
		{5, 2, 20, 15, 2},
		{2, 3, 4, 4, 3},
		{7, 5, 9, 9, 4},
		{3, 1, 1, 1, 5},
	}
	for _, cfg := range configs {
		cfg := cfg
		name := fmt.Sprintf("rate%s_burst%d", big.NewRat(cfg.num, cfg.den).RatString(), cfg.burst)
		t.Run(name, func(t *testing.T) {
			rng := rand.New(rand.NewSource(cfg.seed))
			clock := NewClock(0)
			lim := NewLimiter(cfg.num, cfg.den, cfg.burst, clock)
			model := newTickModel(cfg.num, cfg.den, cfg.burst)

			type pair struct {
				r   *Reservation
				idx int
			}
			var all, live []pair

			checkExecuted := func(step int) {
				for _, p := range all {
					if model.res[p.idx].executed {
						if got := p.r.Tick(); got != model.res[p.idx].execTick {
							t.Fatalf("step %d: executed reservation moved to tick %d, model executed it at %d",
								step, got, model.res[p.idx].execTick)
						}
					}
				}
			}

			for step := 0; step < 600; step++ {
				switch rng.Intn(4) {
				case 0, 1: // advance the virtual clock
					clock.Advance(1 + rng.Int63n(6))
					model.advance(clock.Now())
				case 2: // reserve
					cost := 1 + rng.Int63n(cfg.maxCost)
					r := lim.Reserve(cost)
					if r == nil {
						t.Fatalf("step %d: Reserve(%d) returned nil", step, cost)
					}
					p := pair{r: r, idx: model.reserve(cost)}
					all = append(all, p)
					live = append(live, p)
				case 3: // cancel a random live reservation
					if len(live) == 0 {
						continue
					}
					i := rng.Intn(len(live))
					p := live[i]
					live = append(live[:i], live[i+1:]...)
					gotOK := lim.Cancel(p.r)
					wantOK := model.cancel(p.idx)
					if gotOK != wantOK {
						t.Fatalf("step %d: cancel returned %v, model says %v", step, gotOK, wantOK)
					}
				}
				checkExecuted(step)
			}

			// Drain: every non-cancelled reservation must execute at the
			// tick the limiter published.
			remaining := int64(0)
			for _, p := range all {
				if !model.res[p.idx].cancelled {
					remaining += model.res[p.idx].cost
				}
			}
			horizon := remaining*cfg.den/cfg.num + 2
			clock.Advance(horizon)
			model.advance(clock.Now())
			for i, p := range all {
				mr := model.res[p.idx]
				if mr.cancelled {
					continue
				}
				if !mr.executed {
					t.Fatalf("reservation %d never executed in model", i)
				}
				if got := p.r.Tick(); got != mr.execTick {
					t.Fatalf("reservation %d (cost %d): limiter scheduled tick %d, model executed at %d",
						i, mr.cost, got, mr.execTick)
				}
			}
		})
	}
}
