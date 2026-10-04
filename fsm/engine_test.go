package fsm

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

var base = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// testTable models a tiny session protocol:
//
//	idle --dial--> ringing --answer--> talking --hangup--> idle
//	talking --hold--> held --resume--> talking
func testTable(t *testing.T) *Table {
	t.Helper()
	tbl, err := NewTable("idle", []Transition{
		{From: "idle", Action: "dial", To: "ringing"},
		{From: "ringing", Action: "answer", To: "talking"},
		{From: "talking", Action: "hold", To: "held"},
		{From: "held", Action: "resume", To: "talking"},
		{From: "talking", Action: "hangup", To: "idle"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return tbl
}

func openAt(t *testing.T, path string, tbl *Table, now *time.Time) *Engine {
	t.Helper()
	e, err := Open(path, tbl, func() time.Time { return *now })
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestTableIsPublicAndValidates(t *testing.T) {
	tbl := testTable(t)
	if got := len(tbl.Transitions()); got != 5 {
		t.Fatalf("Transitions() len = %d, want 5", got)
	}
	if to, ok := tbl.Lookup("idle", "dial"); !ok || to != "ringing" {
		t.Fatalf("Lookup(idle, dial) = %q, %v", to, ok)
	}
	if _, err := NewTable("", nil); err == nil {
		t.Fatal("empty initial state accepted")
	}
	dup := []Transition{{From: "a", Action: "x", To: "b"}, {From: "a", Action: "x", To: "c"}}
	if _, err := NewTable("a", dup); err == nil {
		t.Fatal("duplicate transition accepted")
	}
}

func TestAuthorizeByPublicTable(t *testing.T) {
	now := base
	path := filepath.Join(t.TempDir(), "wal.log")
	e := openAt(t, path, testTable(t), &now)
	defer e.Close()

	if err := e.StartSession("s1", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k1", "answer"); !errors.Is(err, ErrActionNotAuthorized) {
		t.Fatalf("unauthorized action: got %v, want ErrActionNotAuthorized", err)
	}
	to, err := e.Apply("s1", "k1", "dial")
	if err != nil || to != "ringing" {
		t.Fatalf("Apply(dial) = %q, %v", to, err)
	}
	if st, _ := e.State("s1"); st != "ringing" {
		t.Fatalf("state = %q, want ringing", st)
	}
	if _, err := e.Apply("nope", "k2", "dial"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("got %v, want ErrSessionNotFound", err)
	}
}

func TestPersistBeforeReturn(t *testing.T) {
	now := base
	path := filepath.Join(t.TempDir(), "wal.log")
	e := openAt(t, path, testTable(t), &now)
	defer e.Close()

	if err := e.StartSession("s1", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k1", "dial"); err != nil {
		t.Fatal(err)
	}
	// The record must already be durable: an independent reader on the same
	// file sees it without any close/flush from the writer.
	_, recs, err := OpenWAL(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 || recs[1].Kind != KindTransition || recs[1].To != "ringing" {
		t.Fatalf("durable records = %+v, want session + transition to ringing", recs)
	}
}

func TestIdempotencyKeyBindsToOneAction(t *testing.T) {
	now := base
	path := filepath.Join(t.TempDir(), "wal.log")
	e := openAt(t, path, testTable(t), &now)

	if err := e.StartSession("s1", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k1", "dial"); err != nil {
		t.Fatal(err)
	}
	before := len(e.Records())

	// Same key + same action: replay recorded outcome, no new write.
	to, err := e.Apply("s1", "k1", "dial")
	if err != nil || to != "ringing" {
		t.Fatalf("replay = %q, %v", to, err)
	}
	if got := len(e.Records()); got != before {
		t.Fatalf("replay wrote a record: %d -> %d", before, got)
	}

	// Same key + different action: conflict.
	if _, err := e.Apply("s1", "k1", "answer"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("got %v, want ErrIdempotencyConflict", err)
	}
	// Same key + different session: conflict.
	if err := e.StartSession("s2", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s2", "k1", "dial"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("cross-session reuse: got %v, want ErrIdempotencyConflict", err)
	}
	e.Close()

	// Bindings survive restart.
	e2 := openAt(t, path, testTable(t), &now)
	defer e2.Close()
	if _, err := e2.Apply("s1", "k1", "answer"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("after restart: got %v, want ErrIdempotencyConflict", err)
	}
	if to, err := e2.Apply("s1", "k1", "dial"); err != nil || to != "ringing" {
		t.Fatalf("replay after restart = %q, %v", to, err)
	}
}

func TestExpiredSessionRejectsTransition(t *testing.T) {
	now := base
	path := filepath.Join(t.TempDir(), "wal.log")
	e := openAt(t, path, testTable(t), &now)

	if err := e.StartSession("s1", 30*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k1", "dial"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(31 * time.Minute)
	if _, err := e.Apply("s1", "k2", "answer"); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("got %v, want ErrSessionExpired", err)
	}
	e.Close()

	// Expiry is persisted: still rejected after restart.
	e2 := openAt(t, path, testTable(t), &now)
	defer e2.Close()
	if _, err := e2.Apply("s1", "k3", "answer"); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("after restart: got %v, want ErrSessionExpired", err)
	}
}

func TestRecoveryReplaysLog(t *testing.T) {
	now := base
	path := filepath.Join(t.TempDir(), "wal.log")
	e := openAt(t, path, testTable(t), &now)
	if err := e.StartSession("s1", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k1", "dial"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k2", "answer"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply("s1", "k3", "hold"); err != nil {
		t.Fatal(err)
	}
	e.Close()

	e2 := openAt(t, path, testTable(t), &now)
	defer e2.Close()
	if st, _ := e2.State("s1"); st != "held" {
		t.Fatalf("recovered state = %q, want held", st)
	}
	if to, err := e2.Apply("s1", "k4", "resume"); err != nil || to != "talking" {
		t.Fatalf("resume after recovery = %q, %v", to, err)
	}
}
