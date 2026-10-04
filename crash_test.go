package protocol

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
	"time"
)

// crashPanic simulates a process crash: the machine is discarded and only
// bytes synced to durable storage survive.
type crashPanic struct{}

// crashDevice counts write points (Append and Sync calls). Once the budget
// is spent, the next write point crashes. A crash during Sync performs a
// torn flush: only half of the staged bytes reach durable storage.
type crashDevice struct {
	durable []byte
	pending []byte
	budget  int // -1 = unlimited
	writes  int
}

func (d *crashDevice) ReadAll() ([]byte, error) { return append([]byte(nil), d.durable...), nil }

func (d *crashDevice) Append(p []byte) error {
	d.writes++
	if d.budget >= 0 && d.writes > d.budget {
		panic(crashPanic{})
	}
	d.pending = append(d.pending, p...)
	return nil
}

func (d *crashDevice) Sync() error {
	d.writes++
	if d.budget >= 0 && d.writes > d.budget {
		half := len(d.pending) / 2
		d.durable = append(d.durable, d.pending[:half]...)
		d.pending = nil
		panic(crashPanic{})
	}
	d.durable = append(d.durable, d.pending...)
	d.pending = nil
	return nil
}

func (d *crashDevice) Truncate(size int64) error {
	d.durable = d.durable[:size]
	d.pending = nil
	return nil
}

// crash drops the volatile buffer and disarms the injector: each scenario
// injects exactly one crash, then lets the restart run to completion.
func (d *crashDevice) crash() {
	d.pending = nil
	d.budget = -1
}

// attempt runs fn, reporting whether it crashed.
func attempt(fn func()) (crashed bool) {
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(crashPanic); ok {
				crashed = true
				return
			}
			panic(r)
		}
	}()
	fn()
	return false
}

type step struct{ action, key string }

// oracle is the expected behavior of the script, derived from the serial
// table interpreter plus the idempotency and expiry rules.
type oracle struct {
	interp  *Interpreter
	keys    map[string]KeyBinding
	expired bool
}

func (o *oracle) expect(t *testing.T, s step, got string, err error) {
	t.Helper()
	if o.expired {
		if !errors.Is(err, ErrSessionExpired) {
			t.Fatalf("step %+v: got (%q, %v), want ErrSessionExpired", s, got, err)
		}
		return
	}
	if b, ok := o.keys[s.key]; ok {
		if b.Action != s.action {
			if !errors.Is(err, ErrIdempotencyConflict) {
				t.Fatalf("step %+v: got (%q, %v), want ErrIdempotencyConflict", s, got, err)
			}
			return
		}
		if err != nil || got != b.To {
			t.Fatalf("step %+v: replay got (%q, %v), want (%q, nil)", s, got, err, b.To)
		}
		return
	}
	next, ok := o.interp.table.Step(o.interp.State(), s.action)
	if !ok {
		if !errors.Is(err, ErrActionNotAuthorized) {
			t.Fatalf("step %+v: got (%q, %v), want ErrActionNotAuthorized", s, got, err)
		}
		return
	}
	if err != nil || got != next {
		t.Fatalf("step %+v: got (%q, %v), want (%q, nil)", s, got, err, next)
	}
	from := o.interp.State()
	if _, err := o.interp.Apply(s.action); err != nil {
		t.Fatalf("oracle: %v", err)
	}
	o.keys[s.key] = KeyBinding{Action: s.action, From: from, To: next}
}

// runScenario executes the script against a Machine, injecting one crash
// at write point budget (or never, when budget < 0), restarting after the
// crash, and finally comparing the recovered machine and its journal
// against the serial interpreter oracle. It returns the device so callers
// can count the write points of a clean run.
func runScenario(t *testing.T, table *Table, steps []step, advanceAfter int, budget int) *crashDevice {
	t.Helper()
	dev := &crashDevice{budget: budget}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	o := &oracle{interp: NewInterpreter(table), keys: map[string]KeyBinding{}}

	var m *Machine
	var st *Store
	open := func() error {
		var err error
		if st, err = OpenStore(dev); err != nil {
			return err
		}
		m, err = Open(Config{Table: table, Store: st, Session: "s1", TTL: time.Hour, Now: clock.now})
		return err
	}
	restart := func() {
		for {
			dev.crash()
			var openErr error
			if attempt(func() { openErr = open() }) {
				continue
			}
			if openErr != nil {
				t.Fatalf("reopen after crash: %v", openErr)
			}
			return
		}
	}

	// First open, with the crash budget still armed.
	var openErr error
	if attempt(func() { openErr = open() }) {
		restart()
	} else if openErr != nil {
		t.Fatalf("open: %v", openErr)
	}

	advanced := false
	stepIdx := 0
	for stepIdx < len(steps) {
		if stepIdx == advanceAfter && !advanced {
			clock.advance(2 * time.Hour)
			o.expired = true
			advanced = true
		}
		s := steps[stepIdx]
		var got string
		var err error
		if attempt(func() { got, err = m.Apply(s.action, s.key) }) {
			// Crashed mid-Apply: the transition may or may not be
			// durable. Restart and retry the same step; the idempotency
			// key makes the retry safe either way.
			restart()
			continue
		}
		o.expect(t, s, got, err)
		stepIdx++
	}

	// One final clean restart, then compare the recovered machine and its
	// journal against the serial interpreter.
	restart()
	if m.State() != o.interp.State() {
		t.Fatalf("final state %q, interpreter %q", m.State(), o.interp.State())
	}
	if !reflect.DeepEqual(m.Bindings(), o.keys) {
		t.Fatalf("final bindings %v, oracle %v", m.Bindings(), o.keys)
	}
	recs := st.Records()
	hist := o.interp.History()
	if len(recs) != len(hist)+1 {
		t.Fatalf("journal has %d records, interpreter history has %d transitions", len(recs), len(hist))
	}
	for i, h := range hist {
		r := recs[i+1]
		if r.Kind != KindTransition || r.Action != h.Action || r.From != h.From || r.To != h.To || r.Seq != i+1 {
			t.Fatalf("journal record %d = %+v, interpreter transition = %+v", i+1, r, h)
		}
	}
	return dev
}

// TestCrashAtEveryWritePoint runs a scripted protocol and, for every write
// point of a clean execution, injects a crash at that point, restarts, and
// verifies the recovered machine against the serial table interpreter.
func TestCrashAtEveryWritePoint(t *testing.T) {
	steps := []step{
		{"login", "k1"},  // idle -> authenticated
		{"login", "k1"},  // idempotent replay
		{"open", "k1"},   // conflict: k1 is bound to login
		{"unlock", "k2"}, // unauthorized from authenticated; k2 stays unbound
		{"open", "k2"},   // authenticated -> active
		{"lock", "k3"},   // active -> locked
		{"unlock", "k4"}, // locked -> active
		{"close", "k5"},  // active -> closed
		// clock advances past the TTL here
		{"login", "k6"}, // expired: rejected
		{"close", "k5"}, // expired replay: rejected
	}
	const advanceAfter = 8

	clean := runScenario(t, testTable(), steps, advanceAfter, -1)
	writePoints := clean.writes
	t.Logf("clean run executes %d write points", writePoints)
	for k := 0; k <= writePoints; k++ {
		t.Run(fmt.Sprintf("crash_at_write_point_%d", k), func(t *testing.T) {
			runScenario(t, testTable(), steps, advanceAfter, k)
		})
	}
}

// cyclicTable has no dead ends, so a random walk keeps producing
// transitions.
func cyclicTable() *Table {
	return &Table{
		Initial: "idle",
		Transitions: map[Edge]string{
			{State: "idle", Action: "login"}:           "authenticated",
			{State: "authenticated", Action: "open"}:   "active",
			{State: "authenticated", Action: "logout"}: "idle",
			{State: "active", Action: "lock"}:          "locked",
			{State: "locked", Action: "unlock"}:        "active",
			{State: "active", Action: "close"}:         "closed",
			{State: "closed", Action: "reopen"}:        "idle",
		},
	}
}

// TestCrashAtEveryWritePointRandomScript does the same for a randomized
// script that exercises replays, conflicts, unauthorized actions, and
// expiry, with a fixed seed for determinism.
func TestCrashAtEveryWritePointRandomScript(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	actions := []string{"login", "open", "logout", "lock", "unlock", "close", "reopen"}
	gen := NewInterpreter(cyclicTable())
	steps := make([]step, 0, 40)
	usedKeys := 0
	for i := 0; i < 40; i++ {
		action := actions[rng.Intn(len(actions))]
		// Prefer actions the table authorizes from the generator's
		// current state, so the script contains many real transitions.
		if rng.Intn(10) < 7 {
			var allowed []string
			for _, a := range actions {
				if _, ok := gen.table.Step(gen.State(), a); ok {
					allowed = append(allowed, a)
				}
			}
			if len(allowed) > 0 {
				action = allowed[rng.Intn(len(allowed))]
			}
		}
		// Sometimes reuse an existing key (producing replays and
		// conflicts), otherwise mint a fresh one.
		var key string
		if usedKeys > 0 && rng.Intn(10) < 4 {
			key = fmt.Sprintf("k%d", rng.Intn(usedKeys))
		} else {
			key = fmt.Sprintf("k%d", usedKeys)
			usedKeys++
		}
		// Track the generator's own state for authorized actions only;
		// keys already bound by the script may still conflict, which is
		// exactly what the test wants to exercise.
		if _, ok := gen.table.Step(gen.State(), action); ok {
			gen.Apply(action)
		}
		steps = append(steps, step{
			action: action,
			key:    key,
		})
	}
	const advanceAfter = 34

	clean := runScenario(t, cyclicTable(), steps, advanceAfter, -1)
	writePoints := clean.writes
	t.Logf("clean run executes %d write points", writePoints)
	for k := 0; k <= writePoints; k++ {
		t.Run(fmt.Sprintf("crash_at_write_point_%d", k), func(t *testing.T) {
			runScenario(t, cyclicTable(), steps, advanceAfter, k)
		})
	}
}
