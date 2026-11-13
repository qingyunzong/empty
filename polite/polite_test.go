package polite

import (
	"testing"
	"time"
)

func TestReadyAtZeroBeforeFirstSend(t *testing.T) {
	l := New()
	l.Register("a.example", 100*time.Millisecond)
	ready, ok := l.ReadyAt("a.example")
	if !ok {
		t.Fatal("registered domain should report a ready time")
	}
	if !ready.IsZero() {
		t.Fatalf("domain that never sent should be ready immediately, got %v", ready)
	}
}

func TestMarkSentAdvancesNextSend(t *testing.T) {
	l := New()
	l.Register("a.example", 100*time.Millisecond)
	sent := time.Unix(1000, 0)
	if !l.MarkSent("a.example", sent) {
		t.Fatal("MarkSent should succeed for a registered domain")
	}
	ready, _ := l.ReadyAt("a.example")
	if want := sent.Add(100 * time.Millisecond); !ready.Equal(want) {
		t.Fatalf("next send = %v, want %v", ready, want)
	}
}

func TestMissingIntervalRefusesNewSends(t *testing.T) {
	l := New()
	if _, ok := l.ReadyAt("ghost.example"); ok {
		t.Fatal("unregistered domain should not report a ready time")
	}
	if l.MarkSent("ghost.example", time.Now()) {
		t.Fatal("unregistered domain should refuse new sends")
	}
}

func TestUnregisterKeepsNoMemory(t *testing.T) {
	l := New()
	l.Register("a.example", time.Second)
	l.MarkSent("a.example", time.Now())
	l.Unregister("a.example")
	if l.Registered("a.example") {
		t.Fatal("domain should be unregistered")
	}
	if _, ok := l.ReadyAt("a.example"); ok {
		t.Fatal("unregistered domain should refuse new sends")
	}
}

func TestReregisterDoesNotMoveNextSend(t *testing.T) {
	l := New()
	l.Register("a.example", 100*time.Millisecond)
	sent := time.Unix(1000, 0)
	l.MarkSent("a.example", sent)
	l.Register("a.example", 5*time.Second)
	ready, _ := l.ReadyAt("a.example")
	if want := sent.Add(100 * time.Millisecond); !ready.Equal(want) {
		t.Fatalf("re-registering must not move the recorded next send: got %v, want %v", ready, want)
	}
}
