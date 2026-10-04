package fsm

import (
	"fmt"
	"math/rand"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// crashSentinel is panicked by the fault-injection hook to simulate power
// loss at an exact write point.
var crashSentinel = fmt.Errorf("simulated crash")

// scriptOp is one step of a deterministic test script.
type scriptOp struct {
	kind    string // "start" | "apply" | "advance"
	session string
	ttl     time.Duration
	key     string
	action  Action
	advance time.Duration
}

// runScript executes the script against a fresh log file. If crashAt >= 0,
// the (crashAt)-th write point across all WAL appends panics, unflushed
// bytes are discarded, and the engine is restarted on the same file before
// the script continues. It returns the surviving engine and the total
// number of write points visited.
func runScript(t *testing.T, tbl *Table, script []scriptOp, crashAt int) (*Engine, int) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "wal.log")
	now := base
	var e *Engine
	points := 0
	crashed := false

	CrashHook = func(p WritePoint) {
		if crashAt >= 0 && !crashed && points == crashAt {
			crashed = true
			panic(crashSentinel)
		}
		points++
	}
	defer func() { CrashHook = nil }()

	open := func() {
		var err error
		e, err = Open(path, tbl, func() time.Time { return now })
		if err != nil {
			t.Fatalf("reopen: %v", err)
		}
	}
	open()

	for _, op := range script {
		func() {
			defer func() {
				if r := recover(); r != nil {
					if r != crashSentinel {
						panic(r)
					}
					e.SimulateCrash() // lose unflushed bytes, then restart
					open()
				}
			}()
			switch op.kind {
			case "start":
				e.StartSession(op.session, op.ttl)
			case "apply":
				e.Apply(op.session, op.key, op.action)
			case "advance":
				now = now.Add(op.advance)
			}
		}()
	}
	return e, points
}

// checkAgainstInterpreter verifies the engine's recovered state equals the
// state a serial table interpreter derives from the durable record log.
func checkAgainstInterpreter(t *testing.T, tbl *Table, e *Engine) {
	t.Helper()
	recs := e.Records()
	it := NewInterpreter(tbl)
	if err := it.Replay(recs); err != nil {
		t.Fatalf("interpreter rejected durable log: %v", err)
	}
	sessions, keys := e.Snapshot()
	if !reflect.DeepEqual(sessions, it.Sessions) {
		t.Fatalf("session mismatch:\nengine:      %v\ninterpreter: %v", sessions, it.Sessions)
	}
	if !reflect.DeepEqual(keys, it.Keys) {
		t.Fatalf("key binding mismatch:\nengine:      %v\ninterpreter: %v", keys, it.Keys)
	}
}

// TestCrashAtEveryWritePoint interrupts the commit path at every single
// write point, restarts, and cross-checks the recovered engine against the
// serial table interpreter.
func TestCrashAtEveryWritePoint(t *testing.T) {
	tbl := testTable(t)
	script := []scriptOp{
		{kind: "start", session: "s1", ttl: time.Hour},
		{kind: "apply", session: "s1", key: "k1", action: "dial"},
		{kind: "apply", session: "s1", key: "k1", action: "dial"},   // idempotent replay
		{kind: "apply", session: "s1", key: "k1", action: "answer"}, // conflict, no write
		{kind: "apply", session: "s1", key: "k2", action: "answer"},
		{kind: "start", session: "s2", ttl: time.Minute},
		{kind: "apply", session: "s2", key: "k3", action: "dial"},
		{kind: "advance", advance: 2 * time.Minute},                 // s2 expires
		{kind: "apply", session: "s2", key: "k4", action: "answer"}, // expired, no write
		{kind: "apply", session: "s1", key: "k5", action: "hold"},
		{kind: "apply", session: "s1", key: "k6", action: "resume"},
		{kind: "apply", session: "s1", key: "k7", action: "hangup"},
		{kind: "apply", session: "s1", key: "k8", action: "dial"},
	}

	_, total := runScript(t, tbl, script, -1)
	t.Logf("script visits %d write points", total)
	if total == 0 {
		t.Fatal("script performs no writes")
	}

	for k := 0; k < total; k++ {
		t.Run(fmt.Sprintf("write-point-%d", k), func(t *testing.T) {
			e, _ := runScript(t, tbl, script, k)
			defer e.Close()
			checkAgainstInterpreter(t, tbl, e)
		})
	}
}

// TestCrashRandomized replays randomized scripts with randomized crash
// points and restarts, then cross-checks against the serial interpreter.
func TestCrashRandomized(t *testing.T) {
	tbl := testTable(t)
	actions := []Action{"dial", "answer", "hold", "resume", "hangup", "bogus"}
	rng := rand.New(rand.NewSource(1))

	for trial := 0; trial < 20; trial++ {
		t.Run(fmt.Sprintf("trial-%d", trial), func(t *testing.T) {
			var script []scriptOp
			for i := 0; i < 40; i++ {
				switch rng.Intn(10) {
				case 0:
					script = append(script, scriptOp{
						kind:    "start",
						session: fmt.Sprintf("s%d", rng.Intn(4)),
						ttl:     time.Duration(1+rng.Intn(60)) * time.Minute,
					})
				case 1:
					script = append(script, scriptOp{
						kind:    "advance",
						advance: time.Duration(rng.Intn(120)) * time.Minute,
					})
				default:
					script = append(script, scriptOp{
						kind:    "apply",
						session: fmt.Sprintf("s%d", rng.Intn(4)),
						key:     fmt.Sprintf("k%d", rng.Intn(12)),
						action:  actions[rng.Intn(len(actions))],
					})
				}
			}
			_, total := runScript(t, tbl, script, -1)
			crashAt := -1
			if total > 0 {
				crashAt = rng.Intn(total)
			}
			e, _ := runScript(t, tbl, script, crashAt)
			defer e.Close()
			checkAgainstInterpreter(t, tbl, e)
		})
	}
}
