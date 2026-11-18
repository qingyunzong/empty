// Package formal implements a gateway session-mapping table that is safe to
// call from the packet receive path.
//
// A Mapper assigns an external port to each outbound five-tuple, refreshes
// idle UDP mappings, reclaims timed-out mappings atomically, and applies ICMP
// errors only to the session named by the embedded original packet.  Every
// allocation receives a monotonically increasing generation.  A stale Mapping
// or BindingKey can never release a newer session that reused the same port.
//
// The table maintains exact accounting: Created == Active + Removed + Expired
// + ICMPRemoved, and ICMPErrors == ICMPRemoved + ICMPIgnored at all times.
package formal
