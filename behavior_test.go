package formal

import (
	"errors"
	"net/netip"
	"testing"
	"time"
)

func TestProtocolSpecificTimeouts(t *testing.T) {
	m := testMapper(t, Config{
		PortMin:         44000,
		PortMax:         44010,
		UDPTimeout:      10 * time.Second,
		TCPTimeout:      20 * time.Second,
		ProtocolTimeout: 30 * time.Second,
	})
	u := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	tcp := NewTuple(addr("10.0.0.2"), 1001, addr("192.0.2.1"), 443, ProtocolTCP)
	other := NewTuple(addr("10.0.0.3"), 1002, addr("192.0.2.1"), 3478, 132)

	if _, err := m.MapAt(u, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := m.MapAt(tcp, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := m.MapAt(other, t0); err != nil {
		t.Fatal(err)
	}

	if n := m.Expire(t0.Add(10 * time.Second)); n != 1 {
		t.Fatalf("expected only UDP to expire, got %d", n)
	}
	if _, ok := m.LookupAt(tcp, t0.Add(10*time.Second)); !ok {
		t.Fatal("TCP expired too early")
	}
	if n := m.Expire(t0.Add(20 * time.Second)); n != 1 {
		t.Fatalf("expected TCP to expire, got %d", n)
	}
	if n := m.Expire(t0.Add(30 * time.Second)); n != 1 {
		t.Fatalf("expected SCTP to expire, got %d", n)
	}
	checkInvariants(t, m)
}

func TestIPv4MappedAddressesAreCanonical(t *testing.T) {
	m := testMapper(t, Config{PortMin: 44100, PortMax: 44100})
	mapped := NewTuple(
		netip.MustParseAddr("::ffff:10.0.0.1"), 1000,
		netip.MustParseAddr("::ffff:192.0.2.1"), 53,
		ProtocolUDP,
	)
	plain := udp("10.0.0.1", "192.0.2.1", 1000, 53)

	first, err := m.MapAt(mapped, t0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.MapAt(plain, t0)
	if err != nil {
		t.Fatal(err)
	}
	if first.Port != second.Port || first.Generation != second.Generation {
		t.Fatal("IPv4-mapped and plain IPv4 tuples created separate mappings")
	}
	if first.Tuple.SrcIP.Is4() == false || first.Tuple.DstIP.Is4() == false {
		t.Fatal("tuple was not canonicalized")
	}
}

func TestMaxMappingsAndInvalidTuples(t *testing.T) {
	m := testMapper(t, Config{PortMin: 44200, PortMax: 44210, MaxMappings: 1})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	b := udp("10.0.0.2", "192.0.2.1", 1001, 53)

	if _, err := m.MapAt(a, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := m.MapAt(b, t0); !errors.Is(err, ErrTableFull) {
		t.Fatalf("expected ErrTableFull, got %v", err)
	}
	if !m.Remove(a) {
		t.Fatal("remove failed")
	}
	if _, err := m.MapAt(b, t0); err != nil {
		t.Fatalf("table did not recover after removal: %v", err)
	}
	if _, err := m.MapAt(Tuple{}, t0); !errors.Is(err, ErrInvalidTuple) {
		t.Fatalf("expected ErrInvalidTuple, got %v", err)
	}
	if s := m.Stats(); s.AllocationFailures != 1 {
		t.Fatalf("table-full failure not accounted: %+v", s)
	}
	checkInvariants(t, m)
}

func TestConfigurationValidationAndDefaults(t *testing.T) {
	if _, err := New(Config{PortMin: 5000, PortMax: 4000}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig, got %v", err)
	}
	if _, err := New(Config{UDPTimeout: -time.Second}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for negative timeout, got %v", err)
	}
	if _, err := New(Config{MaxMappings: -1}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("expected ErrInvalidConfig for negative max, got %v", err)
	}

	m, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	if m.portMin != DefaultPortMin || m.portMax != DefaultPortMax {
		t.Fatalf("bad default range: %d-%d", m.portMin, m.portMax)
	}
	if m.udpTimeout != DefaultUDPTimeout || m.tcpTimeout != DefaultTCPTimeout {
		t.Fatal("bad default timeouts")
	}
}

func TestRefreshPortKeepsGeneration(t *testing.T) {
	m := testMapper(t, Config{PortMin: 44300, PortMax: 44300, UDPTimeout: 10 * time.Second})
	a := udp("10.0.0.1", "192.0.2.1", 1000, 53)
	first, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	refreshed, ok := m.RefreshPortAt(first.Port, t0.Add(8*time.Second))
	if !ok {
		t.Fatal("RefreshPort failed")
	}
	if refreshed.Generation != first.Generation {
		t.Fatal("RefreshPort changed generation")
	}
	if n := m.Expire(t0.Add(10 * time.Second)); n != 0 {
		t.Fatal("inbound refresh did not extend deadline")
	}
	if n := m.Expire(t0.Add(18 * time.Second)); n != 1 {
		t.Fatalf("expected expiry at refreshed deadline, got %d", n)
	}
}
