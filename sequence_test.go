package formal

import (
	"errors"
	"testing"
	"time"
)

type modelBinding struct {
	tuple      Tuple
	port       uint16
	generation uint64
	created    time.Time
	updated    time.Time
	expires    time.Time
}

func (b *modelBinding) mapping() Mapping {
	return Mapping{
		Tuple:      b.tuple,
		Port:       b.port,
		Generation: b.generation,
		Created:    b.created,
		Updated:    b.updated,
		Expires:    b.expires,
	}
}

type modelTable struct {
	min, max uint16
	next     uint16
	used     map[uint16]bool
	everUsed map[uint16]bool

	byTuple map[Tuple]*modelBinding
	byPort  map[uint16]*modelBinding

	generation uint64
	timeout    time.Duration
	stats      Stats
}

func newModelTable(min, max uint16, timeout time.Duration) *modelTable {
	return &modelTable{
		min:      min,
		max:      max,
		next:     min,
		used:     make(map[uint16]bool),
		everUsed: make(map[uint16]bool),
		byTuple:  make(map[Tuple]*modelBinding),
		byPort:   make(map[uint16]*modelBinding),
		timeout:  timeout,
	}
}

func modelNext(port, min, max uint16) uint16 {
	if port == max {
		return min
	}
	return port + 1
}

func (m *modelTable) allocate() (uint16, bool) {
	port := m.next
	count := int(m.max-m.min) + 1
	for i := 0; i < count; i++ {
		if !m.used[port] {
			if m.everUsed[port] {
				m.stats.PortReuses++
			}
			m.used[port] = true
			m.everUsed[port] = true
			m.next = modelNext(port, m.min, m.max)
			return port, true
		}
		port = modelNext(port, m.min, m.max)
	}
	return 0, false
}

func (m *modelTable) remove(b *modelBinding, reason removalReason) {
	delete(m.byTuple, b.tuple)
	delete(m.byPort, b.port)
	delete(m.used, b.port)
	switch reason {
	case removalExpired:
		m.stats.Expired++
	case removalICMP:
		m.stats.ICMPRemoved++
	default:
		m.stats.Removed++
	}
}

func (m *modelTable) mapAt(t Tuple, now time.Time) (Mapping, error) {
	t, _ = t.Canonical()
	if b := m.byTuple[t]; b != nil {
		if now.Before(b.expires) {
			b.updated = now
			b.expires = now.Add(m.timeout)
			m.stats.Refreshed++
			return b.mapping(), nil
		}
		m.remove(b, removalExpired)
	}

	port, ok := m.allocate()
	if !ok {
		m.expire(now)
		port, ok = m.allocate()
	}
	if !ok {
		m.stats.AllocationFailures++
		return Mapping{}, ErrNoFreePort
	}
	m.generation++
	b := &modelBinding{
		tuple:      t,
		port:       port,
		generation: m.generation,
		created:    now,
		updated:    now,
		expires:    now.Add(m.timeout),
	}
	m.byTuple[t] = b
	m.byPort[port] = b
	m.stats.Created++
	return b.mapping(), nil
}

func (m *modelTable) lookupAt(t Tuple, now time.Time) (Mapping, bool) {
	t, _ = t.Canonical()
	b := m.byTuple[t]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.remove(b, removalExpired)
		return Mapping{}, false
	}
	return b.mapping(), true
}

func (m *modelTable) lookupPortAt(port uint16, now time.Time) (Mapping, bool) {
	b := m.byPort[port]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.remove(b, removalExpired)
		return Mapping{}, false
	}
	return b.mapping(), true
}

func (m *modelTable) refreshPortAt(port uint16, now time.Time) (Mapping, bool) {
	b := m.byPort[port]
	if b == nil {
		return Mapping{}, false
	}
	if !now.Before(b.expires) {
		m.remove(b, removalExpired)
		return Mapping{}, false
	}
	b.updated = now
	b.expires = now.Add(m.timeout)
	m.stats.Refreshed++
	return b.mapping(), true
}

func (m *modelTable) removeTuple(t Tuple) bool {
	t, _ = t.Canonical()
	b := m.byTuple[t]
	if b == nil {
		return false
	}
	m.remove(b, removalExplicit)
	return true
}

func (m *modelTable) expire(now time.Time) int {
	n := 0
	for _, b := range m.byPort {
		if !now.Before(b.expires) {
			m.remove(b, removalExpired)
			n++
		}
	}
	return n
}

func (m *modelTable) icmpAt(t Tuple, now time.Time) bool {
	t, _ = t.Canonical()
	m.stats.ICMPErrors++
	b := m.byTuple[t]
	if b == nil {
		m.stats.ICMPIgnored++
		return false
	}
	if !now.Before(b.expires) {
		m.remove(b, removalExpired)
		m.stats.ICMPIgnored++
		return false
	}
	m.remove(b, removalICMP)
	return true
}

func (m *modelTable) snapshotStats() Stats {
	s := m.stats
	s.Active = len(m.byPort)
	return s
}

type packetOp struct {
	name  string
	kind  uint8
	tuple Tuple
	port  uint16
	delay time.Duration
}

const (
	opMap = iota
	opLookup
	opLookupPort
	opRefreshPort
	opRemove
	opICMP
	opExpire
)

func TestExhaustivePacketSequencesAgainstNaiveModel(t *testing.T) {
	const (
		portMin = 300
		portMax = 301
		depth   = 5
	)
	timeout := 10 * time.Second
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)
	c := udp("10.0.0.3", "192.0.2.1", 1002, 53)

	ops := []packetOp{
		{name: "map(A)", kind: opMap, tuple: a},
		{name: "map(B)", kind: opMap, tuple: b},
		{name: "map(C)+5s", kind: opMap, tuple: c, delay: 5 * time.Second},
		{name: "lookup(A)", kind: opLookup, tuple: a},
		{name: "lookup(B)", kind: opLookup, tuple: b},
		{name: "lookupPort(300)", kind: opLookupPort, port: portMin},
		{name: "refreshPort(300)", kind: opRefreshPort, port: portMin},
		{name: "icmp(A)", kind: opICMP, tuple: a},
		{name: "icmp(C)", kind: opICMP, tuple: c},
		{name: "remove(B)", kind: opRemove, tuple: b},
		{name: "expire+5s", kind: opExpire, delay: 5 * time.Second},
		{name: "expire+15s", kind: opExpire, delay: 15 * time.Second},
	}

	trace := make([]int, 0, depth)
	var walk func(int)
	walk = func(step int) {
		if step == depth {
			runModelSequence(t, ops, trace, portMin, portMax, timeout)
			return
		}
		for i := range ops {
			trace = append(trace, i)
			walk(step + 1)
			trace = trace[:len(trace)-1]
		}
	}
	walk(0)
}

func runModelSequence(t *testing.T, ops []packetOp, trace []int, portMin, portMax uint16, timeout time.Duration) {
	t.Helper()
	m := testMapper(t, Config{PortMin: portMin, PortMax: portMax, UDPTimeout: timeout})
	model := newModelTable(portMin, portMax, timeout)
	now := t0

	fail := func(step int, detail string) {
		names := make([]string, len(trace))
		for i, index := range trace {
			names[i] = ops[index].name
		}
		t.Fatalf("sequence %v failed at step %d (%s): %s", names, step, ops[trace[step]].name, detail)
	}

	for step, index := range trace {
		op := ops[index]
		now = now.Add(op.delay)

		switch op.kind {
		case opMap:
			got, gotErr := m.MapAt(op.tuple, now)
			want, wantErr := model.mapAt(op.tuple, now)
			if (gotErr != nil) != (wantErr != nil) || (gotErr != nil && !errors.Is(gotErr, wantErr)) {
				fail(step, "Map error mismatch: got "+errString(gotErr)+", want "+errString(wantErr))
			}
			if !mappingsEqual(got, want) {
				fail(step, "Map mapping mismatch: got "+got.String()+" want "+want.String())
			}
		case opLookup:
			got, gotOK := m.LookupAt(op.tuple, now)
			want, wantOK := model.lookupAt(op.tuple, now)
			if gotOK != wantOK || !mappingsEqual(got, want) {
				fail(step, "Lookup mismatch")
			}
		case opLookupPort:
			got, gotOK := m.LookupPortAt(op.port, now)
			want, wantOK := model.lookupPortAt(op.port, now)
			if gotOK != wantOK || !mappingsEqual(got, want) {
				fail(step, "LookupPort mismatch")
			}
		case opRefreshPort:
			got, gotOK := m.RefreshPortAt(op.port, now)
			want, wantOK := model.refreshPortAt(op.port, now)
			if gotOK != wantOK || !mappingsEqual(got, want) {
				fail(step, "RefreshPort mismatch")
			}
		case opRemove:
			got := m.Remove(op.tuple)
			want := model.removeTuple(op.tuple)
			if got != want {
				fail(step, "Remove mismatch")
			}
		case opICMP:
			got := m.HandleICMPErrorAt(op.tuple, now)
			want := model.icmpAt(op.tuple, now)
			if got != want {
				fail(step, "ICMP result mismatch")
			}
		case opExpire:
			got := m.Expire(now)
			want := model.expire(now)
			if got != want {
				fail(step, "Expire count mismatch")
			}
		}

		gotStats := m.Stats()
		wantStats := model.snapshotStats()
		if gotStats != wantStats {
			fail(step, "stats mismatch")
		}

		gotMappings := m.Snapshot()
		wantMappings := modelSnapshot(model)
		if !slicesEqual(gotMappings, wantMappings) {
			fail(step, "snapshot mismatch")
		}
	}

	checkInvariants(t, m)
}

func errString(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

func mappingsEqual(a, b Mapping) bool {
	return a.Tuple == b.Tuple &&
		a.Port == b.Port &&
		a.Generation == b.Generation &&
		a.Created.Equal(b.Created) &&
		a.Updated.Equal(b.Updated) &&
		a.Expires.Equal(b.Expires)
}

func modelSnapshot(m *modelTable) []Mapping {
	out := make([]Mapping, 0, len(m.byPort))
	for _, b := range m.byPort {
		out = append(out, b.mapping())
	}
	sortMappings(out)
	return out
}

func slicesEqual(a, b []Mapping) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !mappingsEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

func sortMappings(m []Mapping) {
	for i := 1; i < len(m); i++ {
		for j := i; j > 0 && m[j].Port < m[j-1].Port; j-- {
			m[j], m[j-1] = m[j-1], m[j]
		}
	}
}
