// Package formal implements an embeddable, concurrency-safe configuration
// hot-reload store.
//
// A revision is a complete set of named parts. Apply builds and validates a
// candidate revision entirely off to the side. Only when every part validator
// and every whole-configuration validator succeeds does it publish the
// candidate by swapping a single atomic pointer. If any validation fails, the
// candidate is discarded and the currently published version is retained
// unchanged; this all-or-nothing publish is the rollback behaviour.
//
// Requests pin the version they entered with:
//
//	snapshot := manager.Acquire()
//	defer snapshot.Release()
//	version := snapshot.Version
//
// The snapshot remains readable after any number of later switches. Because
// readers never take the writer lock and published Version values are
// immutable, switching versions does not interrupt in-flight requests and no
// request can observe a mixture of parts from different revisions.
//
// Sources can push candidates through Watch, or FileSource can poll a JSON
// file. Rejected updates never stop the watch loop, so a corrected
// configuration can be published later.
package formal
