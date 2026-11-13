package dataeng

import (
	"encoding/binary"
	"testing"
)

type msgBuilder struct {
	b []byte
}

func newMsg(typ byte) *msgBuilder { return &msgBuilder{b: []byte{typ}} }

func (m *msgBuilder) u8(v byte) *msgBuilder { m.b = append(m.b, v); return m }
func (m *msgBuilder) u16(v uint16) *msgBuilder {
	return m.raw(binary.BigEndian.AppendUint16(nil, v))
}
func (m *msgBuilder) u32(v uint32) *msgBuilder {
	return m.raw(binary.BigEndian.AppendUint32(nil, v))
}
func (m *msgBuilder) u64(v uint64) *msgBuilder {
	return m.raw(binary.BigEndian.AppendUint64(nil, v))
}
func (m *msgBuilder) cstr(s string) *msgBuilder { return m.raw(append([]byte(s), 0)) }
func (m *msgBuilder) raw(p []byte) *msgBuilder  { m.b = append(m.b, p...); return m }

func (m *msgBuilder) tupleText(vals ...string) *msgBuilder {
	m.u16(uint16(len(vals)))
	for _, v := range vals {
		m.u8('t').u32(uint32(len(v))).raw([]byte(v))
	}
	return m
}

func relMsg(id uint32, cols ...string) []byte {
	m := newMsg('R').u32(id).cstr("public").cstr("t").u8('d').u16(uint16(len(cols)))
	for i, c := range cols {
		key := byte(0)
		if i == 0 {
			key = 1
		}
		m.u8(key).cstr(c).u32(25).u32(0xFFFFFFFF)
	}
	return m.b
}

func beginMsg(xid uint32) []byte {
	return newMsg('B').u64(0).u64(0).u32(xid).b
}

func commitMsg(commitLSN, endLSN uint64) []byte {
	return newMsg('C').u8(0).u64(commitLSN).u64(endLSN).u64(0).b
}

func insertMsg(relID uint32, vals ...string) []byte {
	return newMsg('I').u32(relID).u8('N').tupleText(vals...).b
}

func mustApply(t *testing.T, s *State, data []byte) []Event {
	t.Helper()
	evs, err := s.Apply(data)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	return evs
}

func findEvent(evs []Event, kind EventKind) *Event {
	for i := range evs {
		if evs[i].Kind == kind {
			return &evs[i]
		}
	}
	return nil
}

func TestLSNRoundTrip(t *testing.T) {
	l, err := ParseLSN("1/16B6C50")
	if err != nil {
		t.Fatal(err)
	}
	if got := l.String(); got != "1/16B6C50" {
		t.Fatalf("got %s", got)
	}
	if _, err := ParseLSN("bogus"); err == nil {
		t.Fatal("expected error")
	}
}

func TestInsertCommitFlow(t *testing.T) {
	s := NewState()
	if evs := mustApply(t, s, relMsg(1, "id", "name")); len(evs) != 1 || evs[0].Kind != EventRelation {
		t.Fatalf("relation event: %+v", evs)
	}
	mustApply(t, s, beginMsg(10))
	// Changes are buffered until commit.
	if evs := mustApply(t, s, insertMsg(1, "1", "alice")); len(evs) != 0 {
		t.Fatalf("expected buffering, got %+v", evs)
	}
	evs := mustApply(t, s, commitMsg(90, 100))
	ins := findEvent(evs, EventInsert)
	if ins == nil {
		t.Fatalf("no insert event: %+v", evs)
	}
	if ins.XID != 10 || ins.Relation.Generation != 1 {
		t.Fatalf("insert: %+v", ins)
	}
	if v, ok := ins.New.Get("name"); !ok || v.Text() != "alice" {
		t.Fatalf("tuple decode: %+v", ins.New)
	}
	commit := findEvent(evs, EventCommit)
	if commit == nil || commit.EndLSN != 100 {
		t.Fatalf("commit: %+v", evs)
	}

	// Confirmed LSN cannot pass the persisted watermark.
	if got := s.ConfirmedLSN(); got != 0 {
		t.Fatalf("confirmed before persist: %v", got)
	}
	s.MarkPersisted(60)
	if got := s.ConfirmedLSN(); got != 60 {
		t.Fatalf("confirmed: %v", got)
	}
	s.MarkPersisted(150)
	if got := s.ConfirmedLSN(); got != 100 {
		t.Fatalf("confirmed must clamp to last complete commit: %v", got)
	}
}

func TestOldTransactionKeepsOldGeneration(t *testing.T) {
	s := NewState()
	mustApply(t, s, relMsg(1, "id", "name")) // generation 1, two columns

	// Streamed transaction starts while generation 1 is current.
	mustApply(t, s, newMsg('S').u32(7).u8(1).b)
	mustApply(t, s, insertMsg(1, "1", "alice"))
	mustApply(t, s, newMsg('E').b) // stream stop

	// Concurrent DDL commits: relation gains a column (generation 2).
	mustApply(t, s, beginMsg(8))
	mustApply(t, s, relMsg(1, "id", "name", "email"))
	mustApply(t, s, commitMsg(190, 200))

	// The old streamed transaction resumes and still decodes with gen 1.
	mustApply(t, s, newMsg('S').u32(7).u8(0).b)
	mustApply(t, s, insertMsg(1, "2", "bob"))
	mustApply(t, s, newMsg('E').b)
	evs := mustApply(t, s, newMsg('c').u32(7).u8(0).u64(290).u64(300).u64(0).b)

	var inserts []Event
	for _, ev := range evs {
		if ev.Kind == EventInsert {
			inserts = append(inserts, ev)
		}
	}
	if len(inserts) != 2 {
		t.Fatalf("inserts: %+v", evs)
	}
	for _, ins := range inserts {
		if ins.Relation.Generation != 1 {
			t.Fatalf("old transaction must use generation 1, got %d", ins.Relation.Generation)
		}
	}
	if v, _ := inserts[1].New.Get("name"); v.Text() != "bob" {
		t.Fatalf("tuple: %+v", inserts[1].New)
	}

	// A new transaction binds the new generation.
	mustApply(t, s, beginMsg(9))
	mustApply(t, s, insertMsg(1, "3", "carol", "c@example.com"))
	evs = mustApply(t, s, commitMsg(390, 400))
	ins := findEvent(evs, EventInsert)
	if ins == nil || ins.Relation.Generation != 2 {
		t.Fatalf("new transaction must use generation 2: %+v", evs)
	}
	if v, _ := ins.New.Get("email"); v.Text() != "c@example.com" {
		t.Fatalf("tuple: %+v", ins.New)
	}
}

func TestRelationDefinedInsideTransaction(t *testing.T) {
	s := NewState()
	mustApply(t, s, beginMsg(1))
	mustApply(t, s, relMsg(5, "id")) // CREATE TABLE in the same transaction
	mustApply(t, s, insertMsg(5, "1"))
	evs := mustApply(t, s, commitMsg(90, 100))
	ins := findEvent(evs, EventInsert)
	if ins == nil || ins.Relation.Generation != 1 {
		t.Fatalf("expected binding to first generation: %+v", evs)
	}
}

func TestStreamAbortDiscards(t *testing.T) {
	s := NewState()
	mustApply(t, s, relMsg(1, "id"))
	mustApply(t, s, newMsg('S').u32(7).u8(1).b)
	mustApply(t, s, insertMsg(1, "1"))
	mustApply(t, s, newMsg('E').b)
	evs := mustApply(t, s, newMsg('A').u32(7).u32(7).b)
	if len(evs) != 1 || evs[0].Kind != EventAbort {
		t.Fatalf("abort: %+v", evs)
	}
	if got := s.LastCommitEndLSN(); got != 0 {
		t.Fatalf("abort must not advance commit end: %v", got)
	}
}

func TestTruncate(t *testing.T) {
	s := NewState()
	mustApply(t, s, relMsg(1, "id"))
	mustApply(t, s, relMsg(2, "id"))
	mustApply(t, s, beginMsg(3))
	mustApply(t, s, newMsg('T').u32(2).u8(3).u32(1).u32(2).b) // cascade + restart identity
	evs := mustApply(t, s, commitMsg(90, 100))
	tr := findEvent(evs, EventTruncate)
	if tr == nil {
		t.Fatalf("no truncate: %+v", evs)
	}
	if !tr.Cascade || !tr.RestartIdentity {
		t.Fatalf("truncate options: %+v", tr)
	}
	if len(tr.Relations) != 2 || tr.Relations[0].ID != 1 || tr.Relations[1].ID != 2 {
		t.Fatalf("truncate relations: %+v", tr.Relations)
	}
}

func TestOrigin(t *testing.T) {
	s := NewState()
	mustApply(t, s, relMsg(1, "id"))
	mustApply(t, s, beginMsg(4))
	mustApply(t, s, insertMsg(1, "1"))
	mustApply(t, s, newMsg('O').u64(1234).cstr("upstream-a").b)
	evs := mustApply(t, s, commitMsg(90, 100))
	commit := findEvent(evs, EventCommit)
	if commit == nil || commit.Origin != "upstream-a" || commit.OriginCommitLSN != 1234 {
		t.Fatalf("commit origin: %+v", commit)
	}
}

func TestConfirmedLSNWaitsForCompleteCommit(t *testing.T) {
	s := NewState()
	mustApply(t, s, relMsg(1, "id"))
	mustApply(t, s, beginMsg(1))
	mustApply(t, s, insertMsg(1, "1"))
	mustApply(t, s, commitMsg(90, 100))
	s.MarkPersisted(100)
	if got := s.ConfirmedLSN(); got != 100 {
		t.Fatalf("confirmed: %v", got)
	}

	// An incomplete streamed transaction must hold the confirmed LSN back.
	mustApply(t, s, newMsg('S').u32(2).u8(1).b)
	mustApply(t, s, insertMsg(1, "2"))
	mustApply(t, s, newMsg('E').b)
	s.MarkPersisted(500)
	if got := s.ConfirmedLSN(); got != 100 {
		t.Fatalf("confirmed must not pass incomplete commit: %v", got)
	}

	// Stream Commit completes it; confirmed can advance once persisted.
	evs := mustApply(t, s, newMsg('c').u32(2).u8(0).u64(190).u64(200).u64(0).b)
	if findEvent(evs, EventInsert) == nil || findEvent(evs, EventCommit) == nil {
		t.Fatalf("stream commit events: %+v", evs)
	}
	if got := s.ConfirmedLSN(); got != 200 {
		t.Fatalf("confirmed: %v", got)
	}
}

func TestUpdateAndDelete(t *testing.T) {
	s := NewState()
	mustApply(t, s, relMsg(1, "id", "name"))
	mustApply(t, s, beginMsg(1))
	mustApply(t, s, newMsg('U').u32(1).u8('K').tupleText("1", "").u8('N').tupleText("1", "alice").b)
	mustApply(t, s, newMsg('D').u32(1).u8('O').tupleText("1", "alice").b)
	evs := mustApply(t, s, commitMsg(90, 100))
	upd := findEvent(evs, EventUpdate)
	if upd == nil || upd.Old.Relation == nil {
		t.Fatalf("update: %+v", evs)
	}
	if v, _ := upd.New.Get("name"); v.Text() != "alice" {
		t.Fatalf("update new: %+v", upd.New)
	}
	del := findEvent(evs, EventDelete)
	if del == nil {
		t.Fatalf("delete: %+v", evs)
	}
	if v, _ := del.Old.Get("id"); v.Text() != "1" {
		t.Fatalf("delete old: %+v", del.Old)
	}
}

func TestErrors(t *testing.T) {
	s := NewState()
	if _, err := s.Apply(insertMsg(1, "1")); err == nil {
		t.Fatal("expected error for change outside transaction")
	}
	if _, err := s.Apply(commitMsg(0, 1)); err == nil {
		t.Fatal("expected error for commit without begin")
	}
	s2 := NewState()
	mustApply(t, s2, beginMsg(1))
	if _, err := s2.Apply(insertMsg(99, "1")); err == nil {
		t.Fatal("expected error for unknown relation")
	}
	if _, err := s2.Apply([]byte{'?'}); err == nil {
		t.Fatal("expected error for unknown message type")
	}
	if _, err := s2.Apply([]byte{'I', 0}); err == nil {
		t.Fatal("expected error for truncated message")
	}
}
