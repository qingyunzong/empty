package formal

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"testing"
	"time"
)

func ipv4Packet(src, dst netip.Addr, protocol uint8, payload []byte) []byte {
	packet := make([]byte, 20+len(payload))
	packet[0] = 0x45
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	packet[8] = 64
	packet[9] = protocol
	src4 := src.As4()
	dst4 := dst.As4()
	copy(packet[12:16], src4[:])
	copy(packet[16:20], dst4[:])
	copy(packet[20:], payload)
	return packet
}

func ipv6Packet(src, dst netip.Addr, next uint8, payload []byte) []byte {
	packet := make([]byte, 40+len(payload))
	packet[0] = 0x60
	binary.BigEndian.PutUint16(packet[4:6], uint16(len(payload)))
	packet[6] = next
	packet[7] = 64
	src16 := src.As16()
	dst16 := dst.As16()
	copy(packet[8:24], src16[:])
	copy(packet[24:40], dst16[:])
	copy(packet[40:], payload)
	return packet
}

func transportHeader(srcPort, dstPort uint16) []byte {
	header := make([]byte, 8)
	binary.BigEndian.PutUint16(header[0:2], srcPort)
	binary.BigEndian.PutUint16(header[2:4], dstPort)
	return header
}

func icmpv4Error(inner []byte) []byte {
	icmp := make([]byte, 8, 8+len(inner))
	icmp[0] = 3 // destination unreachable
	icmp[1] = 3 // port unreachable
	return append(icmp, inner...)
}

func icmpv6Error(inner []byte) []byte {
	icmp := make([]byte, 8, 8+len(inner))
	icmp[0] = 1 // destination unreachable
	icmp[1] = 4 // port unreachable
	return append(icmp, inner...)
}

func TestParseICMPv4ErrorAndRemoveMatchingSession(t *testing.T) {
	innerSrc := addr("10.0.0.7")
	innerDst := addr("203.0.113.9")
	inner := ipv4Packet(innerSrc, innerDst, ProtocolUDP, transportHeader(12345, 53))
	packet := ipv4Packet(innerDst, addr("198.51.100.1"), ProtocolICMP, icmpv4Error(inner))

	got, err := ParseICMPError(packet)
	if err != nil {
		t.Fatal(err)
	}
	want := udp("10.0.0.7", "203.0.113.9", 12345, 53)
	if got != want {
		t.Fatalf("parsed tuple %s, want %s", got, want)
	}

	m := testMapper(t, Config{PortMin: 45000, PortMax: 45000, UDPTimeout: 30 * time.Second})
	if _, err := m.MapAt(want, t0); err != nil {
		t.Fatal(err)
	}
	removed, err := m.HandleICMPErrorPacket(packet)
	if err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Fatal("matching ICMP error did not remove mapping")
	}
	if _, ok := m.Lookup(want); ok {
		t.Fatal("mapping survived ICMP error")
	}
	checkInvariants(t, m)
}

func TestParseICMPv6ErrorAndRemoveMatchingSession(t *testing.T) {
	innerSrc := addr("2001:db8:1::7")
	innerDst := addr("2001:db8:2::9")
	inner := ipv6Packet(innerSrc, innerDst, ProtocolUDP, transportHeader(23456, 443))
	packet := ipv6Packet(innerDst, addr("2001:db8:ffff::1"), 58, icmpv6Error(inner))

	got, err := ParseICMPError(packet)
	if err != nil {
		t.Fatal(err)
	}
	want := NewTuple(innerSrc, 23456, innerDst, 443, ProtocolUDP)
	if got != want {
		t.Fatalf("parsed tuple %s, want %s", got, want)
	}

	m := testMapper(t, Config{PortMin: 45001, PortMax: 45001, UDPTimeout: 30 * time.Second})
	if _, err := m.MapAt(want, t0); err != nil {
		t.Fatal(err)
	}
	removed, err := m.HandleICMPErrorPacket(packet)
	if err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Fatal("matching ICMPv6 error did not remove mapping")
	}
}

func TestICMPPostNATMappingAndPortReuseIsolation(t *testing.T) {
	external := addr("198.51.100.10")
	m := testMapper(t, Config{
		PortMin:    45002,
		PortMax:    45002,
		UDPTimeout: 30 * time.Second,
		ExternalIP: external,
	})
	firstRemote := addr("192.0.2.1")
	secondRemote := addr("192.0.2.2")
	a := udp("10.0.0.1", firstRemote.String(), 1000, 53)
	c := udp("10.0.0.3", secondRemote.String(), 1003, 53)

	ma, err := m.MapAt(a, t0)
	if err != nil {
		t.Fatal(err)
	}
	postNAT := NewTuple(external, ma.Port, firstRemote, 53, ProtocolUDP)
	if !m.HandleICMPErrorAt(postNAT, t0) {
		t.Fatal("post-NAT ICMP tuple did not match")
	}
	if _, ok := m.LookupAt(a, t0); ok {
		t.Fatal("session survived matching post-NAT ICMP error")
	}

	mc, err := m.MapAt(c, t0)
	if err != nil {
		t.Fatal(err)
	}
	if mc.Port != ma.Port || mc.Generation <= ma.Generation {
		t.Fatal("port was not reused with a new generation")
	}

	stale := NewTuple(external, ma.Port, firstRemote, 53, ProtocolUDP)
	if m.HandleICMPErrorAt(stale, t0) {
		t.Fatal("stale ICMP tuple removed the new session")
	}
	if got, ok := m.LookupPortAt(mc.Port, t0); !ok || got.Generation != mc.Generation || got.Tuple != c {
		t.Fatal("new session changed owner after stale ICMP error")
	}

	wrongSource := NewTuple(addr("198.51.100.11"), ma.Port, secondRemote, 53, ProtocolUDP)
	if m.HandleICMPErrorAt(wrongSource, t0) {
		t.Fatal("post-NAT ICMP tuple with wrong external address matched")
	}
	active := NewTuple(external, mc.Port, secondRemote, 53, ProtocolUDP)
	if !m.HandleICMPErrorAt(active, t0) {
		t.Fatal("current post-NAT ICMP tuple did not match")
	}
	if s := m.Stats(); s.ICMPRemoved != 2 || s.ICMPIgnored != 2 {
		t.Fatalf("bad ICMP accounting: %+v", s)
	}
	checkInvariants(t, m)
}

func TestParseTupleIPv4OptionsAndIPv6Extensions(t *testing.T) {
	src := addr("10.0.0.1")
	dst := addr("192.0.2.1")
	payload := transportHeader(1111, 2222)
	packet := ipv4Packet(src, dst, ProtocolUDP, payload)
	packet[0] = 0x46 // 24-byte IPv4 header
	packet = append(packet[:20], append([]byte{0, 0, 0, 0}, packet[20:]...)...)
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	packet[9] = ProtocolUDP

	got, err := ParseTuple(packet)
	if err != nil {
		t.Fatal(err)
	}
	if want := udp("10.0.0.1", "192.0.2.1", 1111, 2222); got != want {
		t.Fatalf("IPv4 options: got %s want %s", got, want)
	}

	// Hop-by-hop extension header (8 bytes) followed by UDP.
	ip6 := ipv6Packet(addr("2001:db8::1"), addr("2001:db8::2"), 0, append([]byte{ProtocolUDP, 0, 0, 0, 0, 0, 0, 0}, payload...))
	got, err = ParseTuple(ip6)
	if err != nil {
		t.Fatal(err)
	}
	if want := NewTuple(addr("2001:db8::1"), 1111, addr("2001:db8::2"), 2222, ProtocolUDP); got != want {
		t.Fatalf("IPv6 extension: got %s want %s", got, want)
	}
}

func TestParseICMPRejectsNonErrorsAndShortPackets(t *testing.T) {
	plainUDP := ipv4Packet(addr("10.0.0.1"), addr("192.0.2.1"), ProtocolUDP, transportHeader(1, 2))
	if _, err := ParseICMPError(plainUDP); !errors.Is(err, ErrNotICMPError) {
		t.Fatalf("expected ErrNotICMPError, got %v", err)
	}

	echo := make([]byte, 8)
	echo[0] = 8 // echo request, not an error
	if _, err := ParseICMPError(ipv4Packet(addr("10.0.0.1"), addr("192.0.2.1"), ProtocolICMP, echo)); !errors.Is(err, ErrNotICMPError) {
		t.Fatalf("expected ErrNotICMPError for echo, got %v", err)
	}

	if _, err := ParseICMPError([]byte{0x45, 0}); !errors.Is(err, ErrMalformedPacket) {
		t.Fatalf("expected ErrMalformedPacket, got %v", err)
	}
	if _, err := ParseICMPError(nil); !errors.Is(err, ErrMalformedPacket) {
		t.Fatalf("expected ErrMalformedPacket for empty input, got %v", err)
	}
}
