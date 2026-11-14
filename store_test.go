package dataeng

import (
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode"
)

var cst = time.FixedZone("CST", 8*3600)

func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02T15:04", s, cst)
	if err != nil {
		panic(err)
	}
	return t
}

func normalize(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func testRule() Rule {
	return Rule{
		ID:              "customer",
		NormVersion:     1,
		Normalize:       normalize,
		Window:          WindowSpec{Size: 24 * time.Hour, Location: cst},
		AllowedLateness: 2 * time.Hour,
	}
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s := NewStore()
	if _, err := s.RegisterRule(testRule()); err != nil {
		t.Fatalf("RegisterRule: %v", err)
	}
	return s
}

func upsert(id, key, ts string) Event {
	return Event{EntityID: id, Key: key, Op: OpUpsert, EventTime: at(ts)}
}

func del(id, ts string) Event {
	return Event{EntityID: id, Op: OpDelete, EventTime: at(ts)}
}

func TestDuplicateWithinWindow(t *testing.T) {
	s := newStore(t)
	o1, _ := s.Apply("customer", upsert("e1", "CUST-001", "2026-03-01T09:00"))
	if o1.Status != StatusAccepted {
		t.Fatalf("first claim: got %v, want accepted", o1.Status)
	}
	o2, _ := s.Apply("customer", upsert("e2", "cust 001", "2026-03-01T10:00"))
	if o2.Status != StatusDuplicate {
		t.Fatalf("second claim: got %v, want duplicate", o2.Status)
	}
	if o2.NormalizedKey != "cust001" {
		t.Fatalf("normalized key = %q, want cust001", o2.NormalizedKey)
	}
	if o2.Owner != "e1" {
		t.Fatalf("owner = %q, want e1 (earliest event time)", o2.Owner)
	}
	if !reflect.DeepEqual(o2.ConflictGroup, []string{"e1", "e2"}) {
		t.Fatalf("conflict group = %v, want [e1 e2]", o2.ConflictGroup)
	}
}

func TestWindowFollowsBusinessTimezone(t *testing.T) {
	s := newStore(t)
	// 23:30 and 00:30 next day in CST share a UTC day but not a CST day.
	if o, _ := s.Apply("customer", upsert("e1", "K1", "2026-03-01T23:30")); o.Status != StatusAccepted {
		t.Fatalf("e1: got %v", o.Status)
	}
	o2, _ := s.Apply("customer", upsert("e2", "K1", "2026-03-02T00:30"))
	if o2.Status != StatusAccepted {
		t.Fatalf("e2 in next CST day: got %v, want accepted", o2.Status)
	}
	if got, want := o2.WindowStart, at("2026-03-02T00:00"); !got.Equal(want) {
		t.Fatalf("window start = %v, want %v", got, want)
	}
	// Same CST day as e2 -> conflict with e2 only.
	o3, _ := s.Apply("customer", upsert("e3", "K1", "2026-03-02T01:00"))
	if o3.Status != StatusDuplicate {
		t.Fatalf("e3: got %v, want duplicate", o3.Status)
	}
	if !reflect.DeepEqual(o3.ConflictGroup, []string{"e2", "e3"}) {
		t.Fatalf("conflict group = %v, want [e2 e3]", o3.ConflictGroup)
	}
}

func TestUpdateRevokesOldKey(t *testing.T) {
	s := newStore(t)
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T09:00"))
	o, _ := s.Apply("customer", upsert("e1", "K2", "2026-03-01T10:00"))
	if o.RevokedKey != "k1" {
		t.Fatalf("revoked key = %q, want k1", o.RevokedKey)
	}
	if got, want := o.RevokedWindow, at("2026-03-01T00:00"); !got.Equal(want) {
		t.Fatalf("revoked window = %v, want %v", got, want)
	}
	// The old key is free again.
	if o, _ := s.Apply("customer", upsert("e2", "K1", "2026-03-01T11:00")); o.Status != StatusAccepted {
		t.Fatalf("e2 on freed key: got %v, want accepted", o.Status)
	}
}

func TestDeleteRevokesKey(t *testing.T) {
	s := newStore(t)
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T09:00"))
	o, _ := s.Apply("customer", del("e1", "2026-03-01T10:00"))
	if o.Status != StatusAccepted || o.RevokedKey != "k1" {
		t.Fatalf("delete outcome = %+v", o)
	}
	if o, _ := s.Apply("customer", upsert("e2", "K1", "2026-03-01T11:00")); o.Status != StatusAccepted {
		t.Fatalf("e2 after delete: got %v, want accepted", o.Status)
	}
}

func TestOccupancyEffectiveFromEventTime(t *testing.T) {
	s := newStore(t)
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T10:00"))
	// e2 arrives later but its event time is earlier, so it owns the key.
	o, _ := s.Apply("customer", upsert("e2", "K1", "2026-03-01T09:30"))
	if o.Status != StatusDuplicate {
		t.Fatalf("got %v, want duplicate", o.Status)
	}
	if o.Owner != "e2" {
		t.Fatalf("owner = %q, want e2 (earlier event time)", o.Owner)
	}
	if !reflect.DeepEqual(o.ConflictGroup, []string{"e2", "e1"}) {
		t.Fatalf("conflict group = %v, want [e2 e1]", o.ConflictGroup)
	}
}

func TestLateEventWithinLatenessRevisesConflictGroup(t *testing.T) {
	s := newStore(t)
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T09:00"))
	s.Apply("customer", upsert("e2", "K1", "2026-03-01T10:00")) // watermark = 10:00
	// Late delete at 08:30 is inside the 2h allowed lateness and dissolves
	// the conflict group.
	o, _ := s.Apply("customer", del("e1", "2026-03-01T08:30"))
	if o.Status != StatusAccepted {
		t.Fatalf("late delete: got %v, want accepted", o.Status)
	}
	if o.RevokedKey != "k1" {
		t.Fatalf("revoked key = %q, want k1", o.RevokedKey)
	}
	if len(o.ConflictGroup) != 0 {
		t.Fatalf("conflict group after revision = %v, want resolved", o.ConflictGroup)
	}
	conflicts, err := s.Conflicts("customer")
	if err != nil {
		t.Fatal(err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("conflicts = %v, want none", conflicts)
	}
}

func TestLateEventBeyondLatenessRejected(t *testing.T) {
	s := newStore(t)
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T12:00")) // watermark = 12:00
	o, _ := s.Apply("customer", upsert("e2", "K1", "2026-03-01T09:59"))
	if o.Status != StatusRejectedLate {
		t.Fatalf("got %v, want rejected-late", o.Status)
	}
	// Rejection must not mutate state: a fresh claim still conflicts with e1.
	o2, _ := s.Apply("customer", upsert("e3", "K1", "2026-03-01T12:30"))
	if o2.Status != StatusDuplicate || o2.Owner != "e1" {
		t.Fatalf("after rejection: %+v", o2)
	}
	// Boundary is inclusive: exactly watermark-lateness is accepted.
	o3, _ := s.Apply("customer", upsert("e4", "K2", "2026-03-01T10:30"))
	if o3.Status != StatusAccepted {
		t.Fatalf("boundary event: got %v, want accepted", o3.Status)
	}
}

func TestNormalizationVersionOpensNewGeneration(t *testing.T) {
	s := newStore(t)
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T09:00"))

	r := testRule()
	r.NormVersion = 2
	gen, err := s.RegisterRule(r)
	if err != nil {
		t.Fatal(err)
	}
	if gen != 1 {
		t.Fatalf("generation = %d, want 1", gen)
	}
	// Idempotent re-registration keeps the generation.
	if again, _ := s.RegisterRule(r); again != 1 {
		t.Fatalf("re-register generation = %d, want 1", again)
	}
	// The v1 occupancy is invisible to the new generation.
	o, _ := s.Apply("customer", upsert("e2", "K1", "2026-03-01T09:30"))
	if o.Status != StatusAccepted {
		t.Fatalf("cross-generation claim: got %v, want accepted", o.Status)
	}
	if o.Generation != 1 {
		t.Fatalf("outcome generation = %d, want 1", o.Generation)
	}
}

func TestNoCrossRuleComparison(t *testing.T) {
	s := newStore(t)
	other := testRule()
	other.ID = "order"
	if _, err := s.RegisterRule(other); err != nil {
		t.Fatal(err)
	}
	s.Apply("customer", upsert("e1", "K1", "2026-03-01T09:00"))
	o, _ := s.Apply("order", upsert("e2", "K1", "2026-03-01T09:30"))
	if o.Status != StatusAccepted {
		t.Fatalf("cross-rule claim: got %v, want accepted", o.Status)
	}
	if _, err := s.Apply("missing", upsert("e9", "K", "2026-03-01T09:00")); err == nil {
		t.Fatal("expected error for unregistered rule")
	}
}

func TestWindowSpecCalendarDays(t *testing.T) {
	w := WindowSpec{Size: 24 * time.Hour, Location: cst}
	start := w.Start(at("2026-03-05T13:45"))
	if !start.Equal(at("2026-03-05T00:00")) {
		t.Fatalf("start = %v", start)
	}
	if end := w.End(start); !end.Equal(at("2026-03-06T00:00")) {
		t.Fatalf("end = %v", end)
	}
	// Sub-day windows truncate from local midnight.
	h := WindowSpec{Size: 6 * time.Hour, Location: cst}
	if got := h.Start(at("2026-03-05T13:45")); !got.Equal(at("2026-03-05T12:00")) {
		t.Fatalf("6h window start = %v", got)
	}
}
