// Package formal implements a deterministic DNS stub-resolver routing engine.
//
// A Config maps stub suffixes to ordered forwarder lists, supplies a default
// forwarder list, search domains, and an ndots threshold. Resolve turns an
// input name into the ordered sequence of fully qualified names it would try,
// records every actual upstream exchange, and reports where the final answer
// came from.
//
// Resolution is deterministic: upstream behavior is supplied through a
// Transport whose Reply includes a simulated latency, and time is charged to a
// caller-provided virtual Clock. A cache hit short-circuits forwarding.
package formal
