// Package formal provides an embeddable, concurrency-safe connection table
// for software load balancers.
//
// A table pins every active five-tuple to one backend. Backend changes never
// rewrite an active binding; they only affect connections that are opened (or
// reused after being closed) later. New flows are placed with a weighted
// consistent-hash ring, so adding or removing a backend moves as few flows as
// possible while still honouring configured weights.
//
// Each successful Open receives a monotonically increasing generation. Close
// and Touch require that generation, which makes late FIN/RST handling safe
// when NAT reuses a source port for a new connection: a release for the old
// generation is rejected instead of removing the replacement connection.
//
// Draining a backend rebuilds the ring without that backend and migrates only
// closed table entries. Active flows stay pinned until they are closed or
// expire, at which point they are moved to an eligible backend.
package formal
