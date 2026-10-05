// Package logcompact implements a compacted log whose reclamation is
// bounded by persistent snapshots and reader leases. Records below every
// live retainer's needed offset may be dropped; reclamation must never
// pass a record that any snapshot or lease still needs.
package logcompact

import "sync"

// Record is a single entry in the log.
type Record struct {
	Offset uint64
	Key    string
	Value  []byte
}

// Snapshot is a persistent point-in-time view. While published it pins
// every record at or above From.
type Snapshot struct {
	ID   uint64
	From uint64
	UpTo uint64
}

// Lease grants a named reader the right to read records at or above From.
// Token uniquely identifies this generation of the lease for Name, so a
// stale lease handle cannot release or renew a newer same-name lease.
type Lease struct {
	Name  string
	Token uint64
	From  uint64
}

// Log is an append-only log with offset-based reclamation. It is safe for
// concurrent use.
type Log struct {
	mu      sync.Mutex
	records []Record // contiguous offsets starting at base
	base    uint64   // offset of records[0]; everything below is reclaimed
	next    uint64   // offset the next appended record will get

	snaps    map[uint64]Snapshot
	nextSnap uint64

	leases  map[string]Lease // current lease per reader name
	nextTok uint64
}

// New returns an empty Log.
func New() *Log {
	return &Log{
		snaps:  make(map[uint64]Snapshot),
		leases: make(map[string]Lease),
	}
}

// Append adds a record and returns its offset.
func (l *Log) Append(key string, value []byte) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	off := l.next
	l.next++
	l.records = append(l.records, Record{Offset: off, Key: key, Value: append([]byte(nil), value...)})
	return off
}

// PublishSnapshot persists a snapshot covering all records appended so far.
// The snapshot pins records at or above the current retention base.
func (l *Log) PublishSnapshot() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextSnap++
	s := Snapshot{ID: l.nextSnap, From: l.base, UpTo: l.next}
	l.snaps[s.ID] = s
	return s
}

// DiscardSnapshot removes a published snapshot.
func (l *Log) DiscardSnapshot(id uint64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.snaps[id]; !ok {
		return false
	}
	delete(l.snaps, id)
	return true
}

// Acquire takes a new lease for name, replacing any previous lease for the
// same name. The lease pins all currently retained records.
func (l *Log) Acquire(name string) Lease {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextTok++
	lease := Lease{Name: name, Token: l.nextTok, From: l.base}
	l.leases[name] = lease
	return lease
}

// Renew reports whether lease is still the current lease for its name.
func (l *Log) Renew(lease Lease) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, ok := l.leases[lease.Name]
	return ok && cur.Token == lease.Token
}

// Release drops lease only if it is still the current lease for its name.
// Releasing a stale lease handle must not release a newer same-name lease.
func (l *Log) Release(lease Lease) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, ok := l.leases[lease.Name]
	if !ok || cur.Token != lease.Token {
		return false
	}
	delete(l.leases, lease.Name)
	return true
}

// floorLocked is the lowest offset any live snapshot or lease still needs.
func (l *Log) floorLocked() uint64 {
	floor := l.next
	for _, s := range l.snaps {
		if s.From < floor {
			floor = s.From
		}
	}
	for _, lease := range l.leases {
		if lease.From < floor {
			floor = lease.From
		}
	}
	return floor
}

// Truncate drops records with offsets below upto, clamped to the retention
// floor imposed by live snapshots and leases. It returns the new base,
// i.e. the offset of the first retained record.
func (l *Log) Truncate(upto uint64) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if floor := l.floorLocked(); upto > floor {
		upto = floor
	}
	if upto <= l.base {
		return l.base
	}
	cut := 0
	for cut < len(l.records) && l.records[cut].Offset < upto {
		cut++
	}
	kept := make([]Record, len(l.records)-cut)
	copy(kept, l.records[cut:])
	l.records = kept
	l.base = upto
	return l.base
}

// ReadFrom returns copies of all retained records with offset >= from.
func (l *Log) ReadFrom(from uint64) []Record {
	l.mu.Lock()
	defer l.mu.Unlock()
	if from < l.base {
		from = l.base
	}
	var out []Record
	for _, r := range l.records {
		if r.Offset >= from {
			out = append(out, Record{Offset: r.Offset, Key: r.Key, Value: append([]byte(nil), r.Value...)})
		}
	}
	return out
}

// Base returns the offset of the first retained record.
func (l *Log) Base() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.base
}

// Next returns the offset the next appended record will get.
func (l *Log) Next() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.next
}

// Snapshots returns the currently published snapshots.
func (l *Log) Snapshots() []Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Snapshot, 0, len(l.snaps))
	for _, s := range l.snaps {
		out = append(out, s)
	}
	return out
}

// Leases returns the currently active leases.
func (l *Log) Leases() []Lease {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Lease, 0, len(l.leases))
	for _, lease := range l.leases {
		out = append(out, lease)
	}
	return out
}
