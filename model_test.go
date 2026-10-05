package timer

// This file compares the heap-based Clock implementation against an
// independent generational event model. The model keeps every scheduled
// event in a flat slice and, on each advance, repeatedly scans for the
// earliest (deadline, seq) event, dropping entries whose generation no
// longer matches its timer. Both sides are driven by identical
// operation scripts; each side keeps its own firing log and fire
// counts, and the two must agree exactly after every step.

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// ----- generational event model -----

type mEvent struct {
	timer     *mTimer
	gen       uint64
	deadline  int64
	seq       int64
	cancelled bool
}

type mTimer struct {
	gen uint64
	cur *mEvent
	fn  func()
}

type model struct {
	now    int64
	seq    int64
	events []*mEvent
}

func (m *model) schedule(t *mTimer, d int64) {
	ev := &mEvent{timer: t, gen: t.gen, deadline: m.now + d, seq: m.seq}
	m.seq++
	m.events = append(m.events, ev)
	t.cur = ev
}

func (m *model) afterFunc(d int64, fn func()) *mTimer {
	t := &mTimer{fn: fn}
	m.schedule(t, d)
	return t
}

func (m *model) stop(t *mTimer) bool {
	if t.cur == nil {
		return false
	}
	t.cur.cancelled = true
	t.cur = nil
	return true
}

func (m *model) reset(t *mTimer, d int64) {
	if t.cur != nil {
		t.cur.cancelled = true
		t.cur = nil
	}
	t.gen++
	m.schedule(t, d)
}

func (m *model) advance(n int64) {
	target := m.now + n
	for {
		best := -1
		for i, ev := range m.events {
			if ev.deadline > target {
				continue
			}
			if best == -1 ||
				ev.deadline < m.events[best].deadline ||
				(ev.deadline == m.events[best].deadline && ev.seq < m.events[best].seq) {
				best = i
			}
		}
		if best == -1 {
			break
		}
		ev := m.events[best]
		m.events = append(m.events[:best], m.events[best+1:]...)
		m.now = ev.deadline
		if ev.cancelled || ev.gen != ev.timer.gen || ev.timer.cur != ev {
			continue // masked stale generation
		}
		ev.timer.cur = nil
		ev.timer.fn()
	}
	m.now = target
}

// ----- dual-system harness -----

// selfResetConfigs: on the k-th firing of a timer created with config
// c, the timer resets itself with delay configs[c][k], if k is in
// range. Reactions are deterministic and applied per system.
var selfResetConfigs = [][]int64{
	{},           // never re-arm
	{1, 1},       // re-arm twice with delay 1
	{0, 2, 0, 2}, // alternate same-tick and delayed re-arms
}

const numSlots = 3 // timers are addressed by slot id

// side tracks one system's per-slot state.
type side struct {
	fires [numSlots]int
	log   []int
}

type harness struct {
	real   *Clock
	mdl    *model
	timers [numSlots]*Timer
	mtmrs  [numSlots]*mTimer
	cfgs   [numSlots]int
	rside  side
	mside  side
}

func newHarness() *harness {
	return &harness{real: NewClock(), mdl: &model{}}
}

func (h *harness) onFireReal(id int) {
	h.rside.log = append(h.rside.log, id)
	k := h.rside.fires[id]
	h.rside.fires[id]++
	if cfg := selfResetConfigs[h.cfgs[id]]; k < len(cfg) {
		h.timers[id].Reset(cfg[k])
	}
}

func (h *harness) onFireModel(id int) {
	h.mside.log = append(h.mside.log, id)
	k := h.mside.fires[id]
	h.mside.fires[id]++
	if cfg := selfResetConfigs[h.cfgs[id]]; k < len(cfg) {
		h.mdl.reset(h.mtmrs[id], cfg[k])
	}
}

func (h *harness) create(id int, d int64, cfg int) {
	h.stopTimer(id)
	h.cfgs[id] = cfg
	h.rside.fires[id] = 0
	h.mside.fires[id] = 0
	captured := id
	h.timers[id] = h.real.AfterFunc(d, func() { h.onFireReal(captured) })
	h.mtmrs[id] = h.mdl.afterFunc(d, func() { h.onFireModel(captured) })
}

func (h *harness) stopTimer(id int) {
	if h.timers[id] != nil {
		h.timers[id].Stop()
		h.mdl.stop(h.mtmrs[id])
		h.timers[id] = nil
		h.mtmrs[id] = nil
	}
}

func (h *harness) stop(id int) {
	if h.timers[id] == nil {
		return
	}
	gotReal := h.timers[id].Stop()
	gotModel := h.mdl.stop(h.mtmrs[id])
	if gotReal != gotModel {
		panic(fmt.Sprintf("Stop result mismatch: real=%v model=%v", gotReal, gotModel))
	}
	h.timers[id] = nil
	h.mtmrs[id] = nil
}

func (h *harness) reset(id int, d int64) {
	if h.timers[id] == nil {
		return
	}
	h.timers[id].Reset(d)
	h.mdl.reset(h.mtmrs[id], d)
}

func (h *harness) advance(n int64) {
	h.real.Advance(n)
	h.mdl.advance(n)
	if h.real.Now() != h.mdl.now {
		panic(fmt.Sprintf("clock mismatch: real=%d model=%d", h.real.Now(), h.mdl.now))
	}
	if !reflect.DeepEqual(h.rside.log, h.mside.log) {
		panic(fmt.Sprintf("firing log mismatch: real=%v model=%v", h.rside.log, h.mside.log))
	}
	if h.rside.fires != h.mside.fires {
		panic(fmt.Sprintf("fire count mismatch: real=%v model=%v", h.rside.fires, h.mside.fires))
	}
}

// ----- operation scripts -----

type opKind int

const (
	opCreate opKind = iota
	opStop
	opReset
	opAdvance
)

type op struct {
	kind opKind
	id   int
	arg  int64 // delay for create/reset, ticks for advance
	cfg  int   // self-reset config for create
}

func (o op) String() string {
	switch o.kind {
	case opCreate:
		return fmt.Sprintf("create(id=%d delay=%d cfg=%d)", o.id, o.arg, o.cfg)
	case opStop:
		return fmt.Sprintf("stop(id=%d)", o.id)
	case opReset:
		return fmt.Sprintf("reset(id=%d delay=%d)", o.id, o.arg)
	default:
		return fmt.Sprintf("advance(%d)", o.arg)
	}
}

// runScript executes the script on a fresh harness. Any divergence
// between the real implementation and the model panics.
func runScript(script []op) {
	h := newHarness()
	for _, o := range script {
		switch o.kind {
		case opCreate:
			h.create(o.id, o.arg, o.cfg)
		case opStop:
			h.stop(o.id)
		case opReset:
			h.reset(o.id, o.arg)
		case opAdvance:
			h.advance(o.arg)
		}
	}
}

func checkScript(t *testing.T, script []op) {
	t.Helper()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("script %v: %v", script, r)
		}
	}()
	runScript(script)
}

// opSpace enumerates the full operation alphabet used for exhaustive
// testing: 3 slots, delays {0,1,2}, advances {0,1,2}, 3 self-reset cfgs.
func opSpace() []op {
	var ops []op
	for id := 0; id < numSlots; id++ {
		for d := int64(0); d <= 2; d++ {
			for cfg := 0; cfg < len(selfResetConfigs); cfg++ {
				ops = append(ops, op{kind: opCreate, id: id, arg: d, cfg: cfg})
			}
			ops = append(ops, op{kind: opReset, id: id, arg: d})
		}
		ops = append(ops, op{kind: opStop, id: id})
	}
	for n := int64(0); n <= 2; n++ {
		ops = append(ops, op{kind: opAdvance, arg: n})
	}
	return ops
}

// TestExhaustiveInterleavings enumerates every operation sequence up to
// the given depth over the full alphabet and verifies the real
// implementation against the generational model at each step.
func TestExhaustiveInterleavings(t *testing.T) {
	ops := opSpace()
	const depth = 4
	script := make([]op, 0, depth)
	count := 0
	var dfs func()
	dfs = func() {
		if len(script) == depth {
			count++
			checkScript(t, script)
			return
		}
		for _, o := range ops {
			script = append(script, o)
			dfs()
			script = script[:len(script)-1]
		}
	}
	dfs()
	t.Logf("exhaustively checked %d scripts of depth %d over %d ops", count, depth, len(ops))
}

// TestRandomizedInterleavings fuzzes deeper scripts with a wider
// parameter range (delays and advances up to 4) across many seeds.
func TestRandomizedInterleavings(t *testing.T) {
	const seeds = 300
	const scriptLen = 60
	for seed := int64(0); seed < seeds; seed++ {
		rng := rand.New(rand.NewSource(seed))
		script := make([]op, 0, scriptLen)
		for i := 0; i < scriptLen; i++ {
			id := rng.Intn(numSlots)
			switch rng.Intn(4) {
			case 0:
				script = append(script, op{kind: opCreate, id: id, arg: int64(rng.Intn(5)), cfg: rng.Intn(len(selfResetConfigs))})
			case 1:
				script = append(script, op{kind: opStop, id: id})
			case 2:
				script = append(script, op{kind: opReset, id: id, arg: int64(rng.Intn(5))})
			case 3:
				script = append(script, op{kind: opAdvance, arg: int64(rng.Intn(5))})
			}
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("seed %d diverged: %v\nscript: %v", seed, r, script)
				}
			}()
			runScript(script)
		}()
	}
}

// TestModelSanity guards the harness itself: the simplest reset-mask
// scenario must produce exactly one firing on both sides.
func TestModelSanity(t *testing.T) {
	h := newHarness()
	h.create(0, 1, 0)
	h.reset(0, 1)
	h.advance(1)
	if want := []int{0}; !reflect.DeepEqual(h.rside.log, want) {
		t.Fatalf("log = %v, want %v (stale generation must be masked)", h.rside.log, want)
	}
}
