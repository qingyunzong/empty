package formal

import (
	"errors"
	"net/netip"
	"sync"
	"testing"
	"time"
)

var t0 = time.Unix(1_700_000_000, 0)

func addr(s string) netip.Addr {
	a, err := netip.ParseAddr(s)
	if err != nil {
		panic(err)
	}
	return a
}

func udp(src, dst string, srcPort, dstPort uint16) Tuple {
	return NewTuple(addr(src), srcPort, addr(dst), dstPort, ProtocolUDP)
}

func testMapper(t *testing.T, cfg Config) *Mapper {
	t.Helper()
	if cfg.Clock == nil {
		cfg.Clock = func() time.Time { return t0 }
	}
	m, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m
}

func checkInvariants(t *testing.T, m *Mapper) {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.byTuple) != len(m.byPort) {
		t.Fatalf("index size mismatch: byTuple=%d byPort=%d", len(m.byTuple), len(m.byPort))
	}
	used := 0
	for _, b := range m.byPort {
		if !m.used[m.portIndex(b.port)] {
			t.Fatalf("port %d is occupied but marked free", b.port)
		}
		if m.byTuple[b.tuple] != b {
			t.Fatalf("tuple reverse index does not point at port %d", b.port)
		}
		used++
	}
	for _, b := range m.byTuple {
		if m.byPort[b.port] != b {
			t.Fatalf("port %d does not point back at tuple %s", b.port, b.tuple)
		}
	}
	for _, inUse := range m.used {
		if inUse {
			used--
		}
	}
	if used != 0 {
		t.Fatalf("allocator bitmap disagrees with port map by %d entries", used)
	}

	if got, want := m.stats.Created, uint64(len(m.byPort))+m.stats.Removed+m.stats.Expired+m.stats.ICMPRemoved; got != want {
		t.Fatalf("billing invariant: Created=%d, want Active+Removed+Expired+ICMPRemoved=%d (%+v)", got, want, m.stats)
	}
	if got, want := m.stats.ICMPErrors, m.stats.ICMPRemoved+m.stats.ICMPIgnored; got != want {
		t.Fatalf("ICMP accounting invariant: %d != %d", got, want)
	}

	generations := make(map[uint64]struct{}, len(m.byPort))
	for _, b := range m.byPort {
		if b.generation == 0 {
			t.Fatalf("zero generation assigned to port %d", b.port)
		}
		if _, dup := generations[b.generation]; dup {
			t.Fatalf("duplicate generation %d", b.generation)
		}
		generations[b.generation] = struct{}{}
		if b.port < m.portMin || b.port > m.portMax {
			t.Fatalf("port %d outside configured range", b.port)
		}
		if b.expires.Before(b.created) {
			t.Fatalf("mapping expires before it was created")
		}
	}
	if m.next < m.portMin || m.next > m.portMax {
		t.Fatalf("allocation cursor %d outside port range", m.next)
	}
}

func TestAllocateNoConflictAndReuseGeneration(t *testing.T) {
	m := testMapper(t, Config{PortMin: 20000, PortMax: 20002, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)
	c := udp("10.0.0.3", "192.0.2.1", 1002, 53)
	d := udp("10.0.0.4", "192.0.2.1", 1003, 53)

	ma, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	mb, err := m.MapAt(b, t0)
	if err != nil {
		t.Fatal(err)
	}
	mc, err := m.MapAt(c, t0)
	if err != nil {
		t.Fatal(err)
	}
	if ma.Port == mb.Port || mb.Port == mc.Port || ma.Port == mc.Port {
		t.Fatalf("ports collide: %d %d %d", ma.Port, mb.Port, mc.Port)
	}
	if ma.Port != 20000 || mb.Port != 20001 || mc.Port != 20002 {
		t.Fatalf("unexpected allocation order: %d %d %d", ma.Port, mb.Port, mc.Port)
	}

	if _, err := m.MapAt(d, t0); !errors.Is(err, ErrNoFreePort) {
		t.Fatalf("expected ErrNoFreePort, got %v", err)
	}
	if s := m.Stats(); s.AllocationFailures != 1 {
		t.Fatalf("allocation failure not counted: %+v", s)
	}

	if !m.Remove(b) {
		t.Fatal("Remove should release b")
	}
	md, err := m.MapAt(d, t0)
	if err != nil {
		t.Fatal(err)
	}
	if md.Port != mb.Port {
		t.Fatalf("expected b's port %d to be reused, got %d", mb.Port, md.Port)
	}
	if md.Generation <= mb.Generation {
		t.Fatalf("reused port did not advance generation: old=%d new=%d", mb.Generation, md.Generation)
	}
	if s := m.Stats(); s.PortReuses != 1 {
		t.Fatalf("port reuse not counted: %+v", s)
	}

	if m.RemoveBinding(mb.Key()) {
		t.Fatal("stale handle must not release a newer mapping")
	}
	if got, ok := m.LookupPort(md.Port); !ok || got.Tuple != d {
		t.Fatalf("port now belongs to %s, want %s", got.Tuple, d)
	}
	if s := m.Stats(); s.StaleReleases != 1 {
		t.Fatalf("stale release not counted: %+v", s)
	}
	checkInvariants(t, m)
}

func TestAllocationWrapsAtMaximumPort(t *testing.T) {
	m := testMapper(t, Config{PortMin: 65534, PortMax: 65535, UDPTimeout: time.Minute})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)
	c := udp("10.0.0.3", "192.0.2.1", 1002, 53)
	d := udp("10.0.0.4", "192.0.2.1", 1003, 53)

	ma, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	mb, err := m.MapAt(b, t0)
	if err != nil {
		t.Fatal(err)
	}
	if ma.Port != 65534 || mb.Port != 65535 {
		t.Fatalf("unexpected ports: %d %d", ma.Port, mb.Port)
	}
	if _, err := m.MapAt(c, t0); !errors.Is(err, ErrNoFreePort) {
		t.Fatalf("expected exhaustion, got %v", err)
	}
	if !m.Remove(a) {
		t.Fatal("remove failed")
	}
	md, err := m.MapAt(d, t0)
	if err != nil {
		t.Fatal(err)
	}
	if md.Port != 65534 {
		t.Fatalf("cursor did not wrap to 65534, got %d", md.Port)
	}
	checkInvariants(t, m)
}

func TestUDPTimeoutRefreshAndExpiry(t *testing.T) {
	m := testMapper(t, Config{PortMin: 40000, PortMax: 40000, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)

	first, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Expires.Equal(t0.Add(10 * time.Second)) {
		t.Fatalf("unexpected deadline %v", first.Expires)
	}

	refreshed, ok := m.RefreshAt(a, t0.Add(5*time.Second))
	if !ok {
		t.Fatal("refresh failed")
	}
	if refreshed.Generation != first.Generation {
		t.Fatal("refresh must not change generation")
	}
	if !refreshed.Expires.Equal(t0.Add(15 * time.Second)) {
		t.Fatalf("unexpected refreshed deadline %v", refreshed.Expires)
	}

	if n := m.Expire(t0.Add(10 * time.Second)); n != 0 {
		t.Fatalf("refreshed mapping expired early: %d", n)
	}
	if got, ok := m.LookupAt(a, t0.Add(9*time.Second)); !ok || got.Generation != first.Generation {
		t.Fatal("lookup should find refreshed mapping")
	}
	if n := m.Expire(t0.Add(15 * time.Second)); n != 1 {
		t.Fatalf("expected one expiry, got %d", n)
	}
	if _, ok := m.Lookup(a); ok {
		t.Fatal("expired mapping still visible")
	}
	if s := m.Stats(); s.Expired != 1 || s.Created != 1 || s.Active != 0 {
		t.Fatalf("bad expiry accounting: %+v", s)
	}
	checkInvariants(t, m)
}

func TestLookupDoesNotRefresh(t *testing.T) {
	m := testMapper(t, Config{PortMin: 40001, PortMax: 40001, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	first, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := m.LookupAt(a, t0.Add(9*time.Second)); !ok || got.Generation != first.Generation {
		t.Fatal("lookup failed")
	}
	if n := m.Expire(t0.Add(10 * time.Second)); n != 1 {
		t.Fatalf("plain lookup must not extend the timeout: %d", n)
	}
}

func TestExpiredMapIsReplacedWithNewGeneration(t *testing.T) {
	m := testMapper(t, Config{PortMin: 40002, PortMax: 40002, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	first, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.MapAt(a, t0.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if second.Port != first.Port {
		t.Fatalf("single-port pool changed port: %d -> %d", first.Port, second.Port)
	}
	if second.Generation != first.Generation+1 {
		t.Fatalf("generation did not advance: %d -> %d", first.Generation, second.Generation)
	}
	if m.RemoveBinding(first.Key()) {
		t.Fatal("stale binding released replacement")
	}
	if got, ok := m.LookupPort(first.Port); !ok || got.Generation != second.Generation {
		t.Fatal("replacement is not the current port owner")
	}
	if s := m.Stats(); s.Expired != 1 || s.Created != 2 || s.PortReuses != 1 {
		t.Fatalf("bad accounting: %+v", s)
	}
	checkInvariants(t, m)
}

func TestAllocationPressureReclaimsExpiredMappings(t *testing.T) {
	m := testMapper(t, Config{PortMin: 40003, PortMax: 40003, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)
	first, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.MapAt(b, t0.Add(10*time.Second))
	if err != nil {
		t.Fatalf("expired binding was not reclaimed under pressure: %v", err)
	}
	if second.Port != first.Port || second.Generation <= first.Generation {
		t.Fatalf("bad reuse: first=%+v second=%+v", first, second)
	}
	if _, ok := m.LookupAt(a, t0.Add(10*time.Second)); ok {
		t.Fatal("expired tuple still present")
	}
	if s := m.Stats(); s.Expired != 1 || s.Created != 2 || s.PortReuses != 1 {
		t.Fatalf("bad pressure accounting: %+v", s)
	}
	checkInvariants(t, m)
}

func TestICMPErrorTargetsOnlyMatchingTuple(t *testing.T) {
	m := testMapper(t, Config{PortMin: 41000, PortMax: 41001, UDPTimeout: time.Minute})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)
	c := udp("10.0.0.3", "192.0.2.1", 1002, 53)
	unknown := udp("10.0.0.9", "192.0.2.1", 9999, 53)

	ma, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	mb, err := m.MapAt(b, t0)
	if err != nil {
		t.Fatal(err)
	}

	if m.HandleICMPErrorAt(unknown, t0) {
		t.Fatal("unknown ICMP error removed a session")
	}
	if !m.HandleICMPErrorAt(a, t0) {
		t.Fatal("matching ICMP error did not remove a")
	}
	if _, ok := m.LookupAt(a, t0); ok {
		t.Fatal("a still present")
	}
	if got, ok := m.LookupAt(b, t0); !ok || got.Generation != mb.Generation {
		t.Fatal("b was disturbed by a's ICMP error")
	}

	mc, err := m.MapAt(c, t0)
	if err != nil {
		t.Fatal(err)
	}
	if mc.Port != ma.Port {
		t.Fatalf("expected a's port to be reusable, got %d want %d", mc.Port, ma.Port)
	}
	if mc.Generation <= ma.Generation {
		t.Fatal("reused port kept old generation")
	}
	if m.HandleICMPErrorAt(a, t0) {
		t.Fatal("stale ICMP error matched reused port")
	}
	if got, ok := m.LookupPort(mc.Port); !ok || got.Tuple != c || got.Generation != mc.Generation {
		t.Fatal("stale ICMP error changed current owner")
	}

	if !m.HandleICMPErrorAt(b, t0) {
		t.Fatal("matching ICMP error did not remove b")
	}
	if s := m.Stats(); s.ICMPErrors != 4 || s.ICMPRemoved != 2 || s.ICMPIgnored != 2 {
		t.Fatalf("bad ICMP accounting: %+v", s)
	}
	checkInvariants(t, m)
}

func TestICMPForExpiredSessionIsNotChargedAsRemoval(t *testing.T) {
	m := testMapper(t, Config{PortMin: 41002, PortMax: 41002, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	if _, err := m.MapAt(a, t0); err != nil {
		t.Fatal(err)
	}
	if m.HandleICMPErrorAt(a, t0.Add(10*time.Second)) {
		t.Fatal("expired mapping reported as ICMP-removed")
	}
	if s := m.Stats(); s.Expired != 1 || s.ICMPRemoved != 0 || s.ICMPIgnored != 1 {
		t.Fatalf("bad accounting: %+v", s)
	}
	checkInvariants(t, m)
}

func TestConcurrentCreateAndExpireSameDeadline(t *testing.T) {
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)

	for i := 0; i < 500; i++ {
		m := testMapper(t, Config{PortMin: 42000, PortMax: 42000, UDPTimeout: 10 * time.Second})
		first, err := m.MapAt(a, t0)
		if err != nil {
			t.Fatal(err)
		}
		at := t0.Add(10 * time.Second)

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			m.Expire(at)
		}()
		go func() {
			defer wg.Done()
			if _, err := m.MapAt(b, at); err != nil {
				t.Errorf("MapAt: %v", err)
			}
		}()
		wg.Wait()

		current, ok := m.LookupAt(b, at)
		if !ok {
			t.Fatal("new mapping disappeared")
		}
		if current.Port != first.Port {
			t.Fatalf("single-port pool returned %d", current.Port)
		}
		if current.Generation != first.Generation+1 {
			t.Fatalf("interleaving produced generation %d, want %d", current.Generation, first.Generation+1)
		}
		if _, ok := m.LookupAt(a, at); ok {
			t.Fatal("old tuple still owns the port")
		}
		if m.RemoveBinding(first.Key()) {
			t.Fatal("stale handle removed the new owner")
		}
		if got, ok := m.LookupPort(current.Port); !ok || got.Tuple != b {
			t.Fatalf("port owner is %s, want %s", got.Tuple, b)
		}
		if s := m.Stats(); s.Created != 2 || s.Expired != 1 || s.PortReuses != 1 {
			t.Fatalf("bad accounting: %+v", s)
		}
		checkInvariants(t, m)
	}
}

func TestConcurrentStressPreservesOwnership(t *testing.T) {
	m := testMapper(t, Config{PortMin: 43000, PortMax: 43007, UDPTimeout: time.Second})
	tuples := make([]Tuple, 32)
	for i := range tuples {
		tuples[i] = udp("10.1.0.1", "192.0.2.1", uint16(1000+i), 53)
	}

	var wg sync.WaitGroup
	for worker := 0; worker < 16; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 400; i++ {
				tuple := tuples[(worker*7+i)%len(tuples)]
				now := t0.Add(time.Duration(i%20) * 100 * time.Millisecond)
				got, err := m.MapAt(tuple, now)
				if err == nil {
					if owner, ok := m.LookupPortAt(got.Port, now); ok && owner.Generation == got.Generation && owner.Tuple != got.Tuple {
						t.Errorf("port %d owned by %s and %s", got.Port, owner.Tuple, got.Tuple)
						return
					}
				}
				if i%3 == 0 {
					m.Expire(now)
				}
				if i%5 == 0 {
					m.RemoveBinding(got.Key())
				}
			}
		}(worker)
	}
	wg.Wait()
	m.Expire(t0.Add(time.Hour))
	if got := m.Len(); got != 0 {
		t.Fatalf("%d mappings survived a sweep past every deadline", got)
	}
	checkInvariants(t, m)
}
