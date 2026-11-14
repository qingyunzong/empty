// Package dataeng provides a temporal dimension table and lookup-join state
// for event-time pipelines.
//
// A dimension key owns a sequence of half-open versions:
//
//	[ValidFrom(i), ValidFrom(i+1))
//
// Every version carries ValidFrom and a SourceSequence for replay and
// provenance. Stored versions are ordered by ValidFrom; a second distinct
// version at the same ValidFrom is quarantined. A fact is joined with the last
// version whose ValidFrom is less than or equal to the fact's own EventTime. A
// dimension change may arrive after facts have already been emitted: the
// lookup-join state emits revised results while the affected facts are still
// open, and freezes them once the watermark closes their event time.
//
// Two different versions with the same ValidFrom would overlap. They are never
// merged silently: the incoming change is moved to the conflict/quarantine
// list and the committed version is left untouched.
package dataeng
