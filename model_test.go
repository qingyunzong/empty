package ratelimit

import (
	"math/rand"
	"testing"
)

// model is an independent, deliberately naive per-tick simulation used to
// cross-check the Limiter. It knows nothing about the Limiter's lazy
// closed-form arithmetic: it refills one tick at a time and finds
// reservation ticks by stepping forward tick by tick.
type model struct {
	cap, rn, rd  int64
	whole, rem   int64 // exact balance: whole + rem/rd tokens
	now          int64
	nextSeq      int64
	pending      []mClaim // reservation (seq) order
	executedSeqs []int64
}

type mClaim struct {
	seq, cost, notBefore, at int64
}

func newModel(capacity, rn, rd int64) *model {
	return &model{cap: capacity, rn: rn, rd: rd, whole: capacity, nextSeq: 1}
}

// refill advances the projected balance by exactly one tick.
func (m *model) refill(whole, rem *int64) {
	total := *rem + m.rn
	*whole += total / m.rd
	*rem = total % m.rd
	if *whole > m.cap || (*whole == m.cap && *rem > 0) {
		*whole, *rem = m.cap, 0
	}
}

// advanceTo steps the model to tick t, executing due claims in (at, seq)
// order at each tick.
func (m *model) advanceTo(t int64) {
	for m.now < t {
		m.now++
		m.refill(&m.whole, &m.rem)
		m.execDue()
	}
}

// execDue executes every claim scheduled at or before the current tick,
// mirroring the lazy execution the Limiter performs on every operation.
func (m *model) execDue() {
	for len(m.pending) > 0 && m.pending[0].at <= m.now {
		c := m.pending[0]
		m.pending = m.pending[1:]
		m.whole -= c.cost
		m.executedSeqs = append(m.executedSeqs, c.seq)
	}
}

// place finds the earliest tick for a claim of cost tokens, stepping tick
// by tick from the projected state (whole, rem at tick tp).
func (m *model) place(whole, rem, tp, cost, notBefore int64) (at, newWhole, newRem int64, ok bool) {
	t := max(notBefore, m.now, tp)
	for tp < t {
		tp++
		m.refill(&whole, &rem)
	}
	for whole < cost {
		if m.rn == 0 {
			return 0, 0, 0, false
		}
		tp++
		m.refill(&whole, &rem)
	}
	return tp, whole - cost, rem, true
}

// replay projects the balance through the pending claims in seq order.
func (m *model) replay() (whole, rem, tp int64) {
	whole, rem, tp = m.whole, m.rem, m.now
	for _, c := range m.pending {
		for tp < c.at {
			tp++
			m.refill(&whole, &rem)
		}
		whole -= c.cost
	}
	return whole, rem, tp
}

func (m *model) reserve(cost, notBefore int64) (seq, at int64, ok bool) {
	if cost <= 0 || cost > m.cap {
		return 0, 0, false
	}
	whole, rem, tp := m.replay()
	at, _, _, ok = m.place(whole, rem, tp, cost, notBefore)
	if !ok {
		return 0, 0, false
	}
	seq = m.nextSeq
	m.nextSeq++
	m.pending = append(m.pending, mClaim{seq: seq, cost: cost, notBefore: notBefore, at: at})
	return seq, at, true
}

func (m *model) cancel(seq int64) (refund int64, ok bool) {
	idx := -1
	for i, c := range m.pending {
		if c.seq == seq {
			idx = i
			break
		}
	}
	if idx < 0 {
		return 0, false
	}
	refund = m.pending[idx].cost
	m.pending = append(m.pending[:idx], m.pending[idx+1:]...)
	// Re-pack every remaining pending claim from the current tick.
	whole, rem, tp := m.whole, m.rem, m.now
	for i := range m.pending {
		at, w, r, ok := m.place(whole, rem, tp, m.pending[i].cost, m.pending[i].notBefore)
		if !ok {
			panic("model: claim became infeasible during re-pack")
		}
		m.pending[i].at = at
		whole, rem, tp = w, r, at
	}
	return refund, true
}

// TestCrossCheckPerTickModel drives the Limiter and the independent
// per-tick model through identical randomized operation sequences and
// compares reservation ticks, refunds, execution order, and exact
// balances after every step.
func TestCrossCheckPerTickModel(t *testing.T) {
	configs := []struct{ cap, rn, rd int64 }{
		{10, 1, 1}, // integral rate
		{5, 1, 2},  // fractional rate, exact remainder
		{3, 2, 3},  // fractional rate, tight capacity
		{8, 0, 1},  // no refill
		{4, 7, 3},  // fast fractional refill
		{1, 1, 4},  // tiny capacity, slow refill
		{20, 5, 2}, // larger bucket
	}
	for _, cfg := range configs {
		for seed := int64(0); seed < 8; seed++ {
			t.Run("", func(t *testing.T) {
				rng := rand.New(rand.NewSource(seed*977 + cfg.cap*31 + cfg.rn*7 + cfg.rd))
				clock := NewManualClock(0)
				l := NewLimiter(cfg.cap, cfg.rn, cfg.rd, clock)
				m := newModel(cfg.cap, cfg.rn, cfg.rd)

				var history []*Reservation // every accepted reservation
				var libExecuted []int64

				collectExecuted := func() {
					for _, r := range l.Sync() {
						libExecuted = append(libExecuted, r.Seq)
						if r.At > clock.Now() {
							t.Fatalf("executed reservation %d at future tick %d (now %d)", r.Seq, r.At, clock.Now())
						}
					}
				}

				for step := 0; step < 250; step++ {
					switch rng.Intn(5) {
					case 0, 1: // advance the virtual clock
						clock.Advance(rng.Int63n(6))
						m.advanceTo(clock.Now())
						collectExecuted()
					case 2, 3: // reserve
						cost := 1 + rng.Int63n(cfg.cap+2) // sometimes > capacity
						notBefore := clock.Now() + rng.Int63n(8) - 1
						r, ok := l.Reserve(cost, notBefore)
						mseq, wantAt, mok := m.reserve(cost, notBefore)
						if ok != mok {
							t.Fatalf("step %d: Reserve(%d, %d) ok=%v, model ok=%v", step, cost, notBefore, ok, mok)
						}
						if ok {
							if r.Seq != mseq {
								t.Fatalf("step %d: seq %d, model seq %d", step, r.Seq, mseq)
							}
							if r.At != wantAt {
								t.Fatalf("step %d: Reserve(%d, %d) at=%d, model at=%d", step, cost, notBefore, r.At, wantAt)
							}
							history = append(history, r)
						}
						collectExecuted()
					case 4: // cancel
						var target *Reservation
						var mseq int64
						switch rng.Intn(4) {
						case 0: // a pending reservation, if any
							var pend []*Reservation
							for _, r := range history {
								if l.Status(r) == Pending {
									pend = append(pend, r)
								}
							}
							if len(pend) > 0 {
								target = pend[rng.Intn(len(pend))]
							}
						case 1: // any historical reservation
							if len(history) > 0 {
								target = history[rng.Intn(len(history))]
							}
						case 2: // nil
							target = nil
						}
						if target != nil {
							mseq = target.Seq
						}
						refund, ok := l.Cancel(target)
						mrefund, mok := m.cancel(mseq)
						if ok != mok || refund != mrefund {
							t.Fatalf("step %d: Cancel(seq %d) = (%d, %v), model = (%d, %v)",
								step, mseq, refund, ok, mrefund, mok)
						}
						if ok && refund != target.Cost {
							t.Fatalf("step %d: refund %d != cost %d", step, refund, target.Cost)
						}
						collectExecuted()
					}

					// The Limiter executes due claims lazily on every
					// operation; bring the model to the same state.
					m.execDue()

					// Cross-check pending schedules.
					got := l.Pending()
					if len(got) != len(m.pending) {
						t.Fatalf("step %d: %d pending, model has %d", step, len(got), len(m.pending))
					}
					maxExecutedAt := int64(-1)
					for i, r := range got {
						mc := m.pending[i]
						if r.Seq != mc.seq || r.At != mc.at || r.Cost != mc.cost {
							t.Fatalf("step %d: pending[%d] = {seq %d at %d cost %d}, model {seq %d at %d cost %d}",
								step, i, r.Seq, r.At, r.Cost, mc.seq, mc.at, mc.cost)
						}
						if r.At < clock.Now() {
							t.Fatalf("step %d: pending seq %d scheduled at %d before now %d", step, r.Seq, r.At, clock.Now())
						}
						if i > 0 && got[i-1].At > r.At {
							t.Fatalf("step %d: pending ticks not non-decreasing in reservation order", step)
						}
					}
					for _, r := range history {
						if l.Status(r) == Executed && r.At > maxExecutedAt {
							maxExecutedAt = r.At
						}
					}
					for _, r := range got {
						if r.At < maxExecutedAt {
							t.Fatalf("step %d: pending seq %d at %d crosses executed reservation at %d",
								step, r.Seq, r.At, maxExecutedAt)
						}
					}

					// Cross-check the exact balance.
					whole, rem := l.Balance()
					if whole != m.whole || rem != m.rem {
						t.Fatalf("step %d: Balance() = (%d, %d), model = (%d, %d)", step, whole, rem, m.whole, m.rem)
					}
					collectExecuted()
				}

				// Drain: far future, everything must execute in the same order.
				clock.Advance(100000)
				m.advanceTo(clock.Now())
				collectExecuted()
				if len(libExecuted) != len(m.executedSeqs) {
					t.Fatalf("executed %d reservations, model executed %d", len(libExecuted), len(m.executedSeqs))
				}
				for i, seq := range libExecuted {
					if seq != m.executedSeqs[i] {
						t.Fatalf("execution order differs at %d: seq %d, model %d", i, seq, m.executedSeqs[i])
					}
				}
				if got := l.Pending(); len(got) != 0 {
					t.Fatalf("%d reservations still pending after drain", len(got))
				}
			})
		}
	}
}
