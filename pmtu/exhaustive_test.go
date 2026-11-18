package pmtu

import (
	"fmt"
	"testing"
	"time"
)

// This file cross-checks Cache against a naive reference model over an
// exhaustive enumeration of event sequences. The naive model holds no
// incremental state: every query recomputes each path's MTU by folding
// the entire event log from scratch, so state-handling bugs in the
// cache (aliasing, per-path mixing, stale fields) cannot be hidden by
// shared code.

// exCfg uses small constants so aging and probing trigger within a few
// events.
var exCfg = Config{
	MinMTU:        500,
	MaxMTU:        1500,
	ProbeStep:     200,
	AgeTimeout:    10 * time.Second,
	MaxProbeFails: 2,
}

var exStart = time.Unix(1_700_000_000, 0)

type evKind int

const (
	evTickSmall evKind = iota // advance 1s
	evTickHalf                // advance AgeTimeout/2
	evTickBig                 // advance AgeTimeout + 1s
	evQuery                   // send-path MTU read (may trigger aging)
	evErr600T                 // trusted errors at assorted sizes
	evErr900T
	evErr1400T
	evErrBelowMinT // 100, clamps to MinMTU
	evErrAboveMaxT // 9000, clamps to MaxMTU (stale)
	evErr600U      // untrusted errors must never change anything
	evErr1400U
	evProbeReq // ask the send path to emit a probe
	evProbeAck // acknowledge the outstanding probe
	evProbeLost
	evSwitchDst // move focus to the other path
	evKindCount
)

const (
	dstA = "path-a"
	dstB = "path-b"
)

// event is one logged step. size records the probe size chosen by the
// cache for evProbeReq/evProbeAck so the naive fold can replay it.
type event struct {
	kind evKind
	dst  string
	size int
	at   time.Time
}

// naiveEntry is the reference per-path state, recomputed by folding.
type naiveEntry struct {
	mtu       int
	lastDec   time.Time
	probing   bool
	probeSize int
	inFlight  bool
	fails     int
}

func (n *naiveEntry) age(now time.Time) {
	if n.probing || now.Sub(n.lastDec) < exCfg.AgeTimeout {
		return
	}
	if n.mtu >= exCfg.MaxMTU {
		n.lastDec = now
		return
	}
	n.probing = true
	n.probeSize = min(n.mtu+exCfg.ProbeStep, exCfg.MaxMTU)
	n.inFlight = false
	n.fails = 0
}

func (n *naiveEntry) failProbe(now time.Time) {
	n.inFlight = false
	n.fails++
	if n.fails >= exCfg.MaxProbeFails {
		n.probing = false
		n.fails = 0
		n.lastDec = now
	}
}

// naiveFold replays the whole log and returns the per-path state. It
// also verifies that every probe size the cache emitted matches the
// naive schedule.
func naiveFold(log []event) (map[string]*naiveEntry, error) {
	tab := map[string]*naiveEntry{}
	get := func(dst string, now time.Time) *naiveEntry {
		e, ok := tab[dst]
		if !ok {
			e = &naiveEntry{mtu: exCfg.MaxMTU, lastDec: now}
			tab[dst] = e
		}
		return e
	}
	for i, ev := range log {
		switch ev.kind {
		case evTickSmall, evTickHalf, evTickBig, evSwitchDst:
			// Time and focus changes touch no path state directly;
			// aging is applied lazily on the next access.
		case evQuery:
			e := get(ev.dst, ev.at)
			e.age(ev.at)
		case evErr600T, evErr900T, evErr1400T, evErrBelowMinT, evErrAboveMaxT:
			raw := map[evKind]int{
				evErr600T: 600, evErr900T: 900, evErr1400T: 1400,
				evErrBelowMinT: 100, evErrAboveMaxT: 9000,
			}[ev.kind]
			e := get(ev.dst, ev.at)
			m := max(min(raw, exCfg.MaxMTU), exCfg.MinMTU)
			if m < e.mtu {
				e.mtu = m
				e.probing = false
				e.inFlight = false
				e.fails = 0
				e.lastDec = ev.at
			} else if e.probing && e.inFlight {
				e.failProbe(ev.at)
			}
		case evErr600U, evErr1400U:
			// Untrusted errors are dropped before they reach the table.
		case evProbeReq:
			e := get(ev.dst, ev.at)
			e.age(ev.at)
			if e.probing && !e.inFlight && e.probeSize > e.mtu {
				if ev.size != e.probeSize {
					return nil, fmt.Errorf("step %d: cache probed %d, naive schedule wants %d", i, ev.size, e.probeSize)
				}
				e.inFlight = true
			} else if ev.size != 0 {
				return nil, fmt.Errorf("step %d: cache probed %d, naive schedule wants none", i, ev.size)
			}
		case evProbeAck:
			e, ok := tab[ev.dst]
			if ok && e.probing && e.inFlight && ev.size == e.probeSize {
				e.mtu = ev.size
				e.inFlight = false
				e.fails = 0
				if e.mtu >= exCfg.MaxMTU {
					e.probing = false
					e.lastDec = ev.at
				} else {
					e.probeSize = min(e.mtu+exCfg.ProbeStep, exCfg.MaxMTU)
				}
			}
		case evProbeLost:
			if e, ok := tab[ev.dst]; ok && e.probing && e.inFlight {
				e.failProbe(ev.at)
			}
		}
	}
	return tab, nil
}

// driver applies one event to the real cache and returns the log entry.
type driver struct {
	cache       *Cache
	now         time.Time
	focus       string
	outstanding map[string]int // probe size in flight per dst
}

func newDriver() *driver {
	return &driver{
		cache:       New(exCfg),
		now:         exStart,
		focus:       dstA,
		outstanding: map[string]int{},
	}
}

func (d *driver) step(kind evKind) event {
	dst := d.focus
	ev := event{kind: kind, dst: dst}
	switch kind {
	case evTickSmall:
		d.now = d.now.Add(time.Second)
	case evTickHalf:
		d.now = d.now.Add(exCfg.AgeTimeout / 2)
	case evTickBig:
		d.now = d.now.Add(exCfg.AgeTimeout + time.Second)
	case evQuery:
		d.cache.MTU(dst, d.now)
	case evErr600T:
		d.cache.Update(dst, 600, true, d.now)
	case evErr900T:
		d.cache.Update(dst, 900, true, d.now)
	case evErr1400T:
		d.cache.Update(dst, 1400, true, d.now)
	case evErrBelowMinT:
		d.cache.Update(dst, 100, true, d.now)
	case evErrAboveMaxT:
		d.cache.Update(dst, 9000, true, d.now)
	case evErr600U:
		d.cache.Update(dst, 600, false, d.now)
	case evErr1400U:
		d.cache.Update(dst, 1400, false, d.now)
	case evProbeReq:
		if size, ok := d.cache.NextProbe(dst, d.now); ok {
			ev.size = size
			d.outstanding[dst] = size
		} else {
			delete(d.outstanding, dst)
		}
	case evProbeAck:
		// Ack the outstanding probe, or a bogus size to exercise
		// stale-ack rejection.
		if size, ok := d.outstanding[dst]; ok {
			ev.size = size
			delete(d.outstanding, dst)
		} else {
			ev.size = 12345
		}
		d.cache.ProbeAck(dst, ev.size, d.now)
	case evProbeLost:
		delete(d.outstanding, dst)
		d.cache.ProbeLost(dst, d.now)
	case evSwitchDst:
		if d.focus == dstA {
			d.focus = dstB
		} else {
			d.focus = dstA
		}
	}
	ev.at = d.now
	return ev
}

// checkInvariants verifies the anti-oscillation contract on every
// transition: the data MTU may only move down on a trusted error and up
// on a probe ack; time, queries, untrusted errors and focus switches
// must never move it.
func checkInvariants(kind evKind, before, after map[string]int) error {
	for dst, b := range before {
		a := after[dst]
		if a == b {
			continue
		}
		if a < b && kind != evErr600T && kind != evErr900T && kind != evErr1400T &&
			kind != evErrBelowMinT && kind != evErrAboveMaxT {
			return fmt.Errorf("%s: MTU %d -> %d decreased without trusted error (event %d)", dst, b, a, kind)
		}
		if a > b && kind != evProbeAck {
			return fmt.Errorf("%s: MTU %d -> %d increased without probe ack (event %d)", dst, b, a, kind)
		}
	}
	return nil
}

func TestExhaustiveEventSequences(t *testing.T) {
	depth := 6
	var log []event
	var seqs int

	var walk func(d int) error
	walk = func(d int) error {
		if d == depth {
			return nil
		}
		for kind := evKind(0); kind < evKindCount; kind++ {
			dr := newDriver()
			// Replay the prefix to rebuild cache state.
			for _, ev := range log {
				dr.step(ev.kind)
			}
			before := map[string]int{
				dstA: dr.cache.MTU(dstA, dr.now),
				dstB: dr.cache.MTU(dstB, dr.now),
			}
			ev := dr.step(kind)
			after := map[string]int{
				dstA: dr.cache.MTU(dstA, dr.now),
				dstB: dr.cache.MTU(dstB, dr.now),
			}
			if err := checkInvariants(kind, before, after); err != nil {
				return fmt.Errorf("seq %v: %w", append(log, ev), err)
			}
			for dst, mtu := range after {
				if mtu < exCfg.MinMTU || mtu > exCfg.MaxMTU {
					return fmt.Errorf("seq %v: %s MTU %d out of [%d,%d]",
						append(log, ev), dst, mtu, exCfg.MinMTU, exCfg.MaxMTU)
				}
			}
			// A probe must always exceed the data MTU: the send path
			// never emits data above the confirmed value.
			if ev.kind == evProbeReq && ev.size > 0 && ev.size <= after[ev.dst] {
				return fmt.Errorf("seq %v: probe size %d does not exceed data MTU %d",
					append(log, ev), ev.size, after[ev.dst])
			}
			log = append(log, ev)
			seqs++
			tab, err := naiveFold(log)
			if err != nil {
				return fmt.Errorf("seq %v: %w", log, err)
			}
			for _, dst := range []string{dstA, dstB} {
				want := exCfg.MaxMTU
				if e, ok := tab[dst]; ok {
					want = e.mtu
				}
				if after[dst] != want {
					return fmt.Errorf("seq %v: %s cache MTU %d, naive table %d",
						log, dst, after[dst], want)
				}
			}
			if err := walk(d + 1); err != nil {
				return err
			}
			log = log[:len(log)-1]
		}
		return nil
	}

	if err := walk(0); err != nil {
		t.Fatal(err)
	}
	t.Logf("exhaustively checked %d event sequences up to depth %d", seqs, depth)
}
