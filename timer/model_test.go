package timer

// This file cross-checks the heap-based Clock against a deliberately
// naive generational event model. The model keeps events in an
// unordered slice and, on every advance, repeatedly scans for the
// smallest (deadline, seq) due event. It shares no code with the
// implementation under test, so agreement between the two over
// exhaustive and randomized operation interleavings is strong
// evidence that the heap ordering, generation masking, and
// callback-reentrancy semantics are correct.

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// --- reference model ---------------------------------------------------

type mEvent struct {
	deadline int64
	seq      uint64
	gen      uint64
	timer    *mTimer
}

type mClock struct {
	now    int64
	seq    uint64
	events []mEvent
}

type mTimer struct {
	clock  *mClock
	gen    uint64
	active bool
	cb     func()
}

func (c *mClock) afterFunc(d int64, cb func()) *mTimer {
	t := &mTimer{clock: c, cb: cb}
	t.reset(d)
	return t
}

func (t *mTimer) stop() bool {
	if !t.active {
		return false
	}
	t.active = false
	t.gen++
	return true
}

func (t *mTimer) reset(d int64) bool {
	t.gen++
	t.active = true
	t.clock.seq++
	t.clock.events = append(t.clock.events, mEvent{
		deadline: t.clock.now + d,
		seq:      t.clock.seq,
		gen:      t.gen,
		timer:    t,
	})
	return true
}

func (c *mClock) advance(delta int64) {
	target := c.now + delta
	for {
		best := -1
		for i := range c.events {
			ev := &c.events[i]
			if ev.deadline > target {
				continue
			}
			if best == -1 ||
				ev.deadline < c.events[best].deadline ||
				(ev.deadline == c.events[best].deadline && ev.seq < c.events[best].seq) {
				best = i
			}
		}
		if best == -1 {
			break
		}
		ev := c.events[best]
		c.events = append(c.events[:best], c.events[best+1:]...)
		c.now = ev.deadline
		t := ev.timer
		if !t.active || ev.gen != t.gen {
			continue
		}
		t.active = false
		t.cb()
	}
	c.now = target
}

// --- operation scripts -------------------------------------------------

type opKind int

const (
	opStop opKind = iota
	opReset
	opAdvance
)

type op struct {
	kind  opKind
	timer int
	arg   int64
}

func (o op) String() string {
	switch o.kind {
	case opStop:
		return fmt.Sprintf("Stop(t%d)", o.timer)
	case opReset:
		return fmt.Sprintf("Reset(t%d,%d)", o.timer, o.arg)
	default:
		return fmt.Sprintf("Advance(%d)", o.arg)
	}
}

// runReal executes a script against the heap-based implementation.
// Each timer's callback records its firing and resets itself with a
// per-timer delay, up to maxSelfResets total firings, so that
// callback-driven rescheduling is exercised inside every script.
func runReal(script []op, nTimers int, initial []int64, maxSelfResets int) ([]string, []bool) {
	c := NewClock(0)
	var log []string
	fires := make([]int, nTimers)
	timers := make([]*Timer, nTimers)
	mk := func(id int) func() {
		return func() {
			log = append(log, fmt.Sprintf("%d:%d", c.Now(), id))
			fires[id]++
			if fires[id] < maxSelfResets {
				timers[id].Reset(int64(id + 1))
			}
		}
	}
	for i := 0; i < nTimers; i++ {
		timers[i] = c.AfterFunc(initial[i], mk(i))
	}
	var stops []bool
	for _, o := range script {
		switch o.kind {
		case opStop:
			stops = append(stops, timers[o.timer].Stop())
		case opReset:
			timers[o.timer].Reset(o.arg)
		case opAdvance:
			c.Advance(o.arg)
		}
	}
	c.Advance(1 << 40) // flush everything still pending
	return log, stops
}

// runModel mirrors runReal against the reference model.
func runModel(script []op, nTimers int, initial []int64, maxSelfResets int) ([]string, []bool) {
	c := &mClock{}
	var log []string
	fires := make([]int, nTimers)
	timers := make([]*mTimer, nTimers)
	mk := func(id int) func() {
		return func() {
			log = append(log, fmt.Sprintf("%d:%d", c.now, id))
			fires[id]++
			if fires[id] < maxSelfResets {
				timers[id].reset(int64(id + 1))
			}
		}
	}
	for i := 0; i < nTimers; i++ {
		timers[i] = c.afterFunc(initial[i], mk(i))
	}
	var stops []bool
	for _, o := range script {
		switch o.kind {
		case opStop:
			stops = append(stops, timers[o.timer].stop())
		case opReset:
			timers[o.timer].reset(o.arg)
		case opAdvance:
			c.advance(o.arg)
		}
	}
	c.advance(1 << 40)
	return log, stops
}

func checkScript(t *testing.T, script []op, nTimers int, initial []int64, maxSelfResets int) {
	t.Helper()
	gotLog, gotStops := runReal(script, nTimers, initial, maxSelfResets)
	wantLog, wantStops := runModel(script, nTimers, initial, maxSelfResets)
	if !reflect.DeepEqual(gotLog, wantLog) || !reflect.DeepEqual(gotStops, wantStops) {
		t.Fatalf("divergence for script %v\n real: log=%v stops=%v\nmodel: log=%v stops=%v",
			script, gotLog, gotStops, wantLog, wantStops)
	}
}

// TestExhaustiveInterleavings enumerates every script of length depth
// over a small alphabet of Stop/Reset/Advance operations on two
// self-resetting timers and requires the implementation and the model
// to agree on the full firing log and every Stop return value.
func TestExhaustiveInterleavings(t *testing.T) {
	alphabet := []op{
		{opStop, 0, 0},
		{opStop, 1, 0},
		{opReset, 0, 1},
		{opReset, 0, 2},
		{opReset, 1, 1},
		{opReset, 1, 2},
		{opAdvance, 0, 1},
		{opAdvance, 0, 2},
	}
	const depth = 6
	initial := []int64{1, 2}
	total := 1
	for i := 0; i < depth; i++ {
		total *= len(alphabet)
	}
	script := make([]op, depth)
	for n := 0; n < total; n++ {
		x := n
		for i := 0; i < depth; i++ {
			script[i] = alphabet[x%len(alphabet)]
			x /= len(alphabet)
		}
		checkScript(t, script, 2, initial, 3)
	}
	t.Logf("checked %d exhaustive scripts of depth %d", total, depth)
}

// TestRandomizedInterleavings hammers the implementation with longer
// random scripts over four timers, including zero-delay resets and
// zero-length advances, across many seeds.
func TestRandomizedInterleavings(t *testing.T) {
	initial := []int64{0, 1, 2, 3}
	for seed := int64(0); seed < 200; seed++ {
		r := rand.New(rand.NewSource(seed))
		script := make([]op, 100)
		for i := range script {
			switch r.Intn(3) {
			case 0:
				script[i] = op{opStop, r.Intn(4), 0}
			case 1:
				script[i] = op{opReset, r.Intn(4), int64(r.Intn(4))}
			default:
				script[i] = op{opAdvance, 0, int64(r.Intn(6))}
			}
		}
		checkScript(t, script, 4, initial, 4)
	}
}
