/*
Package formal implements datagram reassembly for tunnel endpoints.

The reassembler is intentionally caller-driven: it starts no goroutines and
does not own a timer. The receive path calls Add (or AddAt for a caller-supplied
clock) and periodically calls Expire to release timed-out datagrams. All state
is protected by one mutex, so one reassembler may be shared by multiple receive
workers.

Fragments are isolated by the (TunnelID, PacketID) pair. A datagram completes
when the last fragment has established its total length and the received byte
ranges cover [0, total) without gaps. Exact duplicates and byte-identical
overlaps are accepted without being charged twice; any conflicting overlap
discards the whole partially reassembled datagram.

Memory accounting counts fragment payload bytes. Every path that removes a
datagram (completion, timeout, explicit removal, conflict, or capacity
eviction) releases exactly the bytes charged for that datagram.
*/
package formal
