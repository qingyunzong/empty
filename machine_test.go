package protocol

import (
	"bytes"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func testTable() *Table {
	return &Table{
		Initial: "idle",
		Transitions: map[Edge]string{
			{State: "idle", Action: "login"}:          "authenticated",
			{State: "authenticated", Action: "open"}:  "active",
			{State: "active", Action: "lock"}:         "locked",
			{State: "locked", Action: "unlock"}:       "active",
			{State: "active", Action: "close"}:        "closed",
			{State: "authenticated", Action: "close"}: "closed",
		},
	}
}

// memDevice stages appends in a volatile buffer; only Sync makes them
// durable, mirroring an OS page cache.
type memDevice struct {
	durable []byte
	pending []byte
	syncErr error
}

func (d *memDevice) ReadAll() ([]byte, error) { return append([]byte(nil), d.durable...), nil }
func (d *memDevice) Append(p []byte) error {
	d.pending = append(d.pending, p...)
	return nil
}
func (d *memDevice) Sync() error {
	if d.syncErr != nil {
		return d.syncErr
	}
	d.durable = append(d.durable, d.pending...)
	d.pending = nil
	return nil
}
func (d *memDevice) Truncate(size int64) error {
	d.durable = d.durable[:size]
	d.pending = nil
	return nil
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func openMem(t *testing.T, dev *memDevice, clock *fakeClock) (*Machine, *Store) {
	t.Helper()
	st, err := OpenStore(dev)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	m, err := Open(Config{Table: testTable(), Store: st, Session: "s1", TTL: time.Hour, Now: clock.now})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return m, st
}

func TestApplyPersistsBeforeReturn(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, _ := openMem(t, dev, clock)

	next, err := m.Apply("login", "k1")
	if err != nil || next != "authenticated" {
		t.Fatalf("Apply = (%q, %v)", next, err)
	}
	// By the time Apply returned, the transition record must already be
	// durable on the device.
	if !bytes.Contains(dev.durable, []byte(`"kind":"transition"`)) ||
		!bytes.Contains(dev.durable, []byte(`"key":"k1"`)) {
		t.Fatalf("transition not durable at return: %s", dev.durable)
	}
	if len(dev.pending) != 0 {
		t.Fatalf("unsynced bytes remain after Apply returned")
	}
}

func TestIdempotentReplayAddsNoRecord(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, st := openMem(t, dev, clock)

	if _, err := m.Apply("login", "k1"); err != nil {
		t.Fatal(err)
	}
	next, err := m.Apply("login", "k1")
	if err != nil || next != "authenticated" {
		t.Fatalf("replay = (%q, %v)", next, err)
	}
	if n := len(st.Records()); n != 2 { // header + one transition
		t.Fatalf("replay wrote a record: %d records", n)
	}
}

func TestIdempotencyConflict(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, st := openMem(t, dev, clock)

	if _, err := m.Apply("login", "k1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply("open", "k1"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("reuse with different action = %v", err)
	}
	if m.State() != "authenticated" {
		t.Fatalf("state changed on conflict: %q", m.State())
	}
	if n := len(st.Records()); n != 2 {
		t.Fatalf("conflict wrote a record: %d records", n)
	}
}

func TestUnauthorizedAction(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, st := openMem(t, dev, clock)

	if _, err := m.Apply("unlock", "k1"); !errors.Is(err, ErrActionNotAuthorized) {
		t.Fatalf("unauthorized = %v", err)
	}
	if m.State() != "idle" || len(st.Records()) != 1 {
		t.Fatalf("unauthorized action mutated state or journal")
	}
	// A key that failed authorization stays unbound.
	if _, err := m.Apply("login", "k1"); err != nil {
		t.Fatalf("key reuse after failed authorization = %v", err)
	}
}

func TestEmptyIdempotencyKey(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, _ := openMem(t, dev, clock)
	if _, err := m.Apply("login", ""); !errors.Is(err, ErrEmptyIdempotencyKey) {
		t.Fatalf("empty key = %v", err)
	}
}

func TestExpiredSessionRejectsTransitions(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, _ := openMem(t, dev, clock)

	if _, err := m.Apply("login", "k1"); err != nil {
		t.Fatal(err)
	}
	clock.advance(2 * time.Hour)
	if _, err := m.Apply("open", "k2"); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("expired transition = %v", err)
	}
	if _, err := m.Apply("login", "k1"); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("expired replay = %v", err)
	}
	if m.State() != "authenticated" {
		t.Fatalf("expired session changed state: %q", m.State())
	}

	// Expiry is persisted: a recovered session is still expired.
	m2, _ := openMem(t, dev, clock)
	if _, err := m2.Apply("open", "k3"); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("recovered expired session = %v", err)
	}
}

func TestRecoveryRestoresStateAndBindings(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, _ := openMem(t, dev, clock)

	for _, a := range []struct{ action, key string }{
		{"login", "k1"}, {"open", "k2"}, {"lock", "k3"},
	} {
		if _, err := m.Apply(a.action, a.key); err != nil {
			t.Fatal(err)
		}
	}

	m2, _ := openMem(t, dev, clock)
	if m2.State() != "locked" {
		t.Fatalf("recovered state = %q", m2.State())
	}
	if len(m2.Bindings()) != 3 {
		t.Fatalf("recovered bindings = %v", m2.Bindings())
	}
	// Idempotent replay works across the restart without new writes.
	if next, err := m2.Apply("lock", "k3"); err != nil || next != "locked" {
		t.Fatalf("replay after recovery = (%q, %v)", next, err)
	}
	if _, err := m2.Apply("unlock", "k3"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflict after recovery = %v", err)
	}
	if next, err := m2.Apply("unlock", "k4"); err != nil || next != "active" {
		t.Fatalf("new transition after recovery = (%q, %v)", next, err)
	}
}

func TestFailedPersistLeavesStateUntouched(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, _ := openMem(t, dev, clock)

	dev.syncErr = errors.New("disk on fire")
	if _, err := m.Apply("login", "k1"); err == nil {
		t.Fatal("expected persist error")
	}
	if m.State() != "idle" {
		t.Fatalf("state mutated despite failed persist: %q", m.State())
	}
	if _, ok := m.Bindings()["k1"]; ok {
		t.Fatal("key bound despite failed persist")
	}

	// Retry after the device recovers; the uncertain earlier write may
	// have staged a duplicate record, which recovery must tolerate.
	dev.syncErr = nil
	if next, err := m.Apply("login", "k1"); err != nil || next != "authenticated" {
		t.Fatalf("retry = (%q, %v)", next, err)
	}
	m2, _ := openMem(t, dev, clock)
	if m2.State() != "authenticated" {
		t.Fatalf("recovery after duplicate record = %q", m2.State())
	}
}

func TestTornTailIsTruncatedOnOpen(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	m, _ := openMem(t, dev, clock)
	if _, err := m.Apply("login", "k1"); err != nil {
		t.Fatal(err)
	}
	goodLen := int64(len(dev.durable))

	// Simulate a torn write: half a record reached durable storage.
	dev.durable = append(dev.durable, []byte(`{"kind":"transi`)...)
	m2, _ := openMem(t, dev, clock)
	if m2.State() != "authenticated" {
		t.Fatalf("state after torn tail = %q", m2.State())
	}
	if int64(len(dev.durable)) != goodLen {
		t.Fatalf("torn tail not truncated: %d > %d", len(dev.durable), goodLen)
	}

	// A full line with a bad checksum is also discarded.
	dev.durable = append(dev.durable, []byte("deadbeef {}\n")...)
	if _, err := OpenStore(dev); err != nil {
		t.Fatalf("OpenStore with corrupt line: %v", err)
	}
	if int64(len(dev.durable)) != goodLen {
		t.Fatalf("corrupt line not truncated: %d > %d", len(dev.durable), goodLen)
	}
}

func TestSessionMismatch(t *testing.T) {
	dev := &memDevice{}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	if _, err := OpenStore(dev); err != nil {
		t.Fatal(err)
	}
	st, _ := OpenStore(dev)
	if _, err := Open(Config{Table: testTable(), Store: st, Session: "s1", TTL: time.Hour, Now: clock.now}); err != nil {
		t.Fatal(err)
	}
	st2, _ := OpenStore(dev)
	if _, err := Open(Config{Table: testTable(), Store: st2, Session: "other", TTL: time.Hour, Now: clock.now}); !errors.Is(err, ErrSessionMismatch) {
		t.Fatalf("foreign journal = %v", err)
	}
}

func TestFileDeviceRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.log")
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}

	dev, err := OpenFileDevice(path)
	if err != nil {
		t.Fatal(err)
	}
	st, err := OpenStore(dev)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Open(Config{Table: testTable(), Store: st, Session: "s1", TTL: time.Hour, Now: clock.now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply("login", "k1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply("open", "k2"); err != nil {
		t.Fatal(err)
	}
	if err := dev.Close(); err != nil {
		t.Fatal(err)
	}

	dev2, err := OpenFileDevice(path)
	if err != nil {
		t.Fatal(err)
	}
	defer dev2.Close()
	st2, err := OpenStore(dev2)
	if err != nil {
		t.Fatal(err)
	}
	m2, err := Open(Config{Table: testTable(), Store: st2, Session: "s1", TTL: time.Hour, Now: clock.now})
	if err != nil {
		t.Fatal(err)
	}
	if m2.State() != "active" || len(m2.Bindings()) != 2 {
		t.Fatalf("file recovery = state %q, bindings %v", m2.State(), m2.Bindings())
	}
}

func TestSerialInterpreter(t *testing.T) {
	i := NewInterpreter(testTable())
	if _, err := i.Apply("unlock"); !errors.Is(err, ErrActionNotAuthorized) {
		t.Fatalf("interpreter unauthorized = %v", err)
	}
	for _, action := range []string{"login", "open", "lock", "unlock"} {
		if _, err := i.Apply(action); err != nil {
			t.Fatal(err)
		}
	}
	if i.State() != "active" || len(i.History()) != 4 {
		t.Fatalf("interpreter = state %q, history %v", i.State(), i.History())
	}
}
