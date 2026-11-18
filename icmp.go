package formal

import (
	"encoding/binary"
	"fmt"
	"net/netip"
	"time"
)

// ParseTuple extracts the five-tuple from an IPv4 or IPv6 packet.  The packet
// must begin at the IP header.  For protocols without ports, both port fields
// are zero.
func ParseTuple(packet []byte) (Tuple, error) {
	return parseIPPacket(packet)
}

// ParseICMPError extracts the five-tuple of the original outbound packet from
// an ICMPv4 or ICMPv6 error.  The returned tuple can be passed directly to
// Mapper.HandleICMPError.
//
// The packet must begin at the outer IP header (an Ethernet header is not
// expected).  Only ICMP error messages are accepted: types 3, 4, 5, 11, and 12
// for ICMPv4, and types 1 through 4 for ICMPv6.
func ParseICMPError(packet []byte) (Tuple, error) {
	if len(packet) == 0 {
		return Tuple{}, fmt.Errorf("%w: empty packet", ErrMalformedPacket)
	}

	switch packet[0] >> 4 {
	case 4:
		return parseICMPv4Error(packet)
	case 6:
		return parseICMPv6Error(packet)
	default:
		return Tuple{}, fmt.Errorf("%w: IP version %d", ErrMalformedPacket, packet[0]>>4)
	}
}

// HandleICMPErrorPacket parses an ICMP error and removes the single session
// identified by its embedded original five-tuple.  Unrelated sessions, and
// sessions that reused the old external port, are left untouched.
func (m *Mapper) HandleICMPErrorPacket(packet []byte) (bool, error) {
	t, err := ParseICMPError(packet)
	if err != nil {
		return false, err
	}
	return m.HandleICMPError(t), nil
}

// HandleICMPError removes the live mapping matching the embedded original
// five-tuple.  Both common embedded directions are accepted:
//
//   - pre-NAT: the internal source address and source port, or
//   - post-NAT: the external address and allocated source port.
//
// A post-NAT tuple matches only when its protocol, destination address, and
// destination port also match the mapping.  Consequently an ICMP error for an
// old session cannot target another session that merely reused the same
// external port for a different remote endpoint.
func (m *Mapper) HandleICMPError(inner Tuple) bool {
	return m.HandleICMPErrorAt(inner, m.now())
}

// HandleICMPErrorAt is HandleICMPError with an explicit timestamp.
func (m *Mapper) HandleICMPErrorAt(inner Tuple, now time.Time) bool {
	t, err := canonicalTuple(inner)
	if err != nil {
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.stats.ICMPErrors++
	b := m.matchICMPLocked(t)
	if b == nil {
		m.stats.ICMPIgnored++
		return false
	}
	if !now.Before(b.expires) {
		m.removeLocked(b, removalExpired)
		m.stats.ICMPIgnored++
		return false
	}
	m.removeLocked(b, removalICMP)
	return true
}

func (m *Mapper) matchICMPLocked(t Tuple) *binding {
	if b := m.byTuple[t]; b != nil {
		return b
	}

	// A remote ICMP error embeds the packet after NAT, so its source is the
	// mapped external endpoint and its destination is still the remote peer.
	if m.externalIP.IsValid() && t.SrcIP != m.externalIP {
		return nil
	}
	b := m.byPort[t.SrcPort]
	if b == nil || b.tuple.Protocol != t.Protocol {
		return nil
	}
	if b.tuple.DstIP != t.DstIP || b.tuple.DstPort != t.DstPort {
		return nil
	}
	return b
}

func parseICMPv4Error(packet []byte) (Tuple, error) {
	if len(packet) < 20 {
		return Tuple{}, fmt.Errorf("%w: short IPv4 header", ErrMalformedPacket)
	}
	ihl := int(packet[0]&0x0f) * 4
	if ihl < 20 || len(packet) < ihl+8 {
		return Tuple{}, fmt.Errorf("%w: short ICMPv4 error", ErrMalformedPacket)
	}
	if packet[9] != ProtocolICMP {
		return Tuple{}, fmt.Errorf("%w: IPv4 protocol %d", ErrNotICMPError, packet[9])
	}

	end := len(packet)
	if total := int(binary.BigEndian.Uint16(packet[2:4])); total >= ihl+8 && total < end {
		end = total
	}

	typ := packet[ihl]
	switch typ {
	case 3, 4, 5, 11, 12:
	default:
		return Tuple{}, fmt.Errorf("%w: ICMPv4 type %d", ErrNotICMPError, typ)
	}

	return parseIPPacket(packet[ihl+8 : end])
}

func parseICMPv6Error(packet []byte) (Tuple, error) {
	if len(packet) < 40 {
		return Tuple{}, fmt.Errorf("%w: short IPv6 header", ErrMalformedPacket)
	}
	next, offset, err := skipIPv6Extensions(packet, 40, packet[6])
	if err != nil {
		return Tuple{}, err
	}
	if next != 58 {
		return Tuple{}, fmt.Errorf("%w: IPv6 next header %d", ErrNotICMPError, next)
	}
	if len(packet) < offset+8 {
		return Tuple{}, fmt.Errorf("%w: short ICMPv6 error", ErrMalformedPacket)
	}

	typ := packet[offset]
	switch typ {
	case 1, 2, 3, 4:
	default:
		return Tuple{}, fmt.Errorf("%w: ICMPv6 type %d", ErrNotICMPError, typ)
	}

	return parseIPPacket(packet[offset+8:])
}

func parseIPPacket(packet []byte) (Tuple, error) {
	if len(packet) == 0 {
		return Tuple{}, fmt.Errorf("%w: empty IP packet", ErrMalformedPacket)
	}
	switch packet[0] >> 4 {
	case 4:
		return parseIPv4Packet(packet)
	case 6:
		return parseIPv6Packet(packet)
	default:
		return Tuple{}, fmt.Errorf("%w: IP version %d", ErrMalformedPacket, packet[0]>>4)
	}
}

func parseIPv4Packet(packet []byte) (Tuple, error) {
	if len(packet) < 20 {
		return Tuple{}, fmt.Errorf("%w: short IPv4 header", ErrMalformedPacket)
	}
	ihl := int(packet[0]&0x0f) * 4
	if ihl < 20 || len(packet) < ihl {
		return Tuple{}, fmt.Errorf("%w: invalid IPv4 header length", ErrMalformedPacket)
	}

	end := len(packet)
	total := int(binary.BigEndian.Uint16(packet[2:4]))
	if total != 0 && total < ihl {
		return Tuple{}, fmt.Errorf("%w: invalid IPv4 total length", ErrMalformedPacket)
	}
	if total >= ihl && total < end {
		end = total
	}
	if binary.BigEndian.Uint16(packet[6:8])&0x1fff != 0 {
		return Tuple{}, fmt.Errorf("%w: non-initial IPv4 fragment", ErrMalformedPacket)
	}

	var srcBytes, dstBytes [4]byte
	copy(srcBytes[:], packet[12:16])
	copy(dstBytes[:], packet[16:20])

	t := Tuple{
		SrcIP:    netip.AddrFrom4(srcBytes),
		DstIP:    netip.AddrFrom4(dstBytes),
		Protocol: packet[9],
	}
	if protocolHasPorts(t.Protocol) {
		if end < ihl+4 {
			return Tuple{}, fmt.Errorf("%w: missing transport ports", ErrMalformedPacket)
		}
		t.SrcPort = binary.BigEndian.Uint16(packet[ihl : ihl+2])
		t.DstPort = binary.BigEndian.Uint16(packet[ihl+2 : ihl+4])
	}
	return t, nil
}

func parseIPv6Packet(packet []byte) (Tuple, error) {
	if len(packet) < 40 {
		return Tuple{}, fmt.Errorf("%w: short IPv6 header", ErrMalformedPacket)
	}

	end := len(packet)
	if payload := int(binary.BigEndian.Uint16(packet[4:6])); payload > 0 && 40+payload < end {
		end = 40 + payload
	}

	next, offset, err := skipIPv6Extensions(packet[:end], 40, packet[6])
	if err != nil {
		return Tuple{}, err
	}

	var srcBytes, dstBytes [16]byte
	copy(srcBytes[:], packet[8:24])
	copy(dstBytes[:], packet[24:40])

	t := Tuple{
		SrcIP:    netip.AddrFrom16(srcBytes),
		DstIP:    netip.AddrFrom16(dstBytes),
		Protocol: next,
	}
	if protocolHasPorts(next) {
		if end < offset+4 {
			return Tuple{}, fmt.Errorf("%w: missing transport ports", ErrMalformedPacket)
		}
		t.SrcPort = binary.BigEndian.Uint16(packet[offset : offset+2])
		t.DstPort = binary.BigEndian.Uint16(packet[offset+2 : offset+4])
	}
	return t, nil
}

func skipIPv6Extensions(packet []byte, offset int, next uint8) (uint8, int, error) {
	for {
		switch next {
		case 0, 43, 60: // hop-by-hop, routing, destination options
			if len(packet) < offset+2 {
				return 0, 0, fmt.Errorf("%w: short IPv6 extension", ErrMalformedPacket)
			}
			length := (int(packet[offset+1]) + 1) * 8
			next = packet[offset]
			offset += length
		case 44: // fragment
			if len(packet) < offset+8 {
				return 0, 0, fmt.Errorf("%w: short IPv6 fragment header", ErrMalformedPacket)
			}
			if binary.BigEndian.Uint16(packet[offset+2:offset+4])&0xfff8 != 0 {
				return 0, 0, fmt.Errorf("%w: non-initial IPv6 fragment", ErrMalformedPacket)
			}
			next = packet[offset]
			offset += 8
		case 51: // authentication header
			if len(packet) < offset+2 {
				return 0, 0, fmt.Errorf("%w: short IPv6 authentication header", ErrMalformedPacket)
			}
			length := (int(packet[offset+1]) + 2) * 4
			next = packet[offset]
			offset += length
		case 50: // ESP payload is encrypted
			return 0, 0, fmt.Errorf("%w: encrypted IPv6 payload", ErrMalformedPacket)
		default:
			if offset > len(packet) {
				return 0, 0, fmt.Errorf("%w: IPv6 extension exceeds packet", ErrMalformedPacket)
			}
			return next, offset, nil
		}
	}
}

func protocolHasPorts(protocol uint8) bool {
	switch protocol {
	case 6, 17, 33, 132, 136: // TCP, UDP, DCCP, SCTP, UDP-Lite
		return true
	default:
		return false
	}
}
