package formal

import (
	"fmt"
	"net/netip"
)

// IP protocol numbers used by the session table.  A five-tuple may carry any
// non-zero protocol number; the constants are provided for the common cases.
const (
	ProtocolTCP  uint8 = 6
	ProtocolUDP  uint8 = 17
	ProtocolICMP uint8 = 1
)

// Tuple is the direction-sensitive five-tuple of a packet leaving the
// internal network.  SrcIP and SrcPort identify the internal endpoint, while
// DstIP and DstPort identify the remote endpoint.
//
// Tuple is a value type and is safe to use as a map key.  IPv4-mapped IPv6
// addresses are canonicalized to IPv4 when a Tuple enters a Mapper.
type Tuple struct {
	SrcIP    netip.Addr
	DstIP    netip.Addr
	SrcPort  uint16
	DstPort  uint16
	Protocol uint8
}

// NewTuple builds a five-tuple from addresses and ports.
func NewTuple(srcIP netip.Addr, srcPort uint16, dstIP netip.Addr, dstPort uint16, protocol uint8) Tuple {
	return Tuple{
		SrcIP:    srcIP,
		DstIP:    dstIP,
		SrcPort:  srcPort,
		DstPort:  dstPort,
		Protocol: protocol,
	}
}

// Canonical returns a copy of t with IPv4-mapped IPv6 addresses converted to
// IPv4.  The boolean is false when t cannot name a session.
func (t Tuple) Canonical() (Tuple, bool) {
	if !t.SrcIP.IsValid() || !t.DstIP.IsValid() || t.Protocol == 0 {
		return Tuple{}, false
	}
	t.SrcIP = t.SrcIP.Unmap()
	t.DstIP = t.DstIP.Unmap()
	return t, true
}

// String implements fmt.Stringer.
func (t Tuple) String() string {
	return fmt.Sprintf("%s:%d > %s:%d proto=%d",
		t.SrcIP, t.SrcPort, t.DstIP, t.DstPort, t.Protocol)
}

func canonicalTuple(t Tuple) (Tuple, error) {
	c, ok := t.Canonical()
	if !ok {
		return Tuple{}, fmt.Errorf("%w: %s", ErrInvalidTuple, t)
	}
	return c, nil
}
