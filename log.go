// Package logcompact implements a versioned, compacted log whose
// reclamation is gated by two kinds of pins: persistent snapshots and
// leases held by active readers.
//
// Reclamation never passes a record that any live pin still needs:
// Truncate computes a horizon equal to the oldest pinned version and
// only compacts entries below it (keeping the latest value per key in
// that prefix). Entries at or above the horizon are retained verbatim.
//
// Pins are named, but every AcquireLease/PublishSnapshot/Renew issues a
// new generation token. Operations on a pin validate the generation, so
// releasing or renewing with an old token can never disturb a newer pin
// that reused the same name.
package logcompact

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrStaleToken is returned when a token no longer refers to the
	// current generation of its named pin.
	ErrStaleToken = errors.New("logcompact: stale token")
	// ErrCompacted is returned when a read asks for a version that
	// reclamation has already compacted away.
	ErrCompacted = errors.New("logcompact: version already compacted")
)

// Entry is a single record in the log.
type Entry struct {
	Seq   uint64
	Key   string
	Value string
}

// Kind distinguishes the two pin families.
type Kind int

const (
	Lease Kind = iota
	Snapshot
)

func (k Kind) String() string {
	if k == Snapshot {
		return "snapshot"
	}
	return "lease"
}

// Token identifies one generation of a named pin. A token only ever
// refers to the generation that issued it.
type Token struct {
	name string
	gen  uint64
	kind Kind
}

func (t Token) String() string {
	return fmt.Sprintf("%s/%s#%d", t.kind, t.name, t.gen)
}

// Pin describes a live pin for inspection.
type Pin struct {
	Name string
	Kind Kind
	Gen  uint64
	Ver  uint64
}

type pin struct {
	token Token
	ver   uint64
}

// Log is an append-only, versioned log with pin-gated compaction.
// The zero value is not ready for use; call New.
type Log struct {
	mu      sync.Mutex
	entries []Entry // retained entries, ascending Seq
	nextSeq uint64
	genSeq  uint64
	pins    map[string]pin // keyed by kind+name
	floor   uint64         // horizon of the deepest truncation so far
}

// New returns an empty log.
func New() *Log {
	return &Log{pins: make(map[string]pin)}
}

func pinKey(kind Kind, name string) string {
	return fmt.Sprintf("%d:%s", kind, name)
}

// Append adds a record and returns its sequence number.
func (l *Log) Append(key, value string) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextSeq++
	l.entries = append(l.entries, Entry{Seq: l.nextSeq, Key: key, Value: value})
	return l.nextSeq
}

// Head returns the sequence number of the newest entry.
func (l *Log) Head() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.nextSeq
}

// Len returns the number of retained entries.
func (l *Log) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

// Horizon returns the first version that must be retained in full: the
// oldest pinned version, or Head()+1 when nothing is pinned.
func (l *Log) Horizon() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.horizonLocked()
}

func (l *Log) horizonLocked() uint64 {
	h := l.nextSeq + 1
	for _, p := range l.pins {
		if p.ver < h {
			h = p.ver
		}
	}
	return h
}

// AcquireLease pins the current head for an active reader. Acquiring a
// lease under an already-used name replaces the old pin; the old token
// becomes stale immediately.
func (l *Log) AcquireLease(name string) Token {
	return l.addPin(Lease, name)
}

// PublishSnapshot pins the current head as a persistent snapshot.
// Publishing under an already-used name replaces the old snapshot.
func (l *Log) PublishSnapshot(name string) Token {
	return l.addPin(Snapshot, name)
}

func (l *Log) addPin(kind Kind, name string) Token {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.genSeq++
	tok := Token{name: name, gen: l.genSeq, kind: kind}
	l.pins[pinKey(kind, name)] = pin{token: tok, ver: l.nextSeq}
	return tok
}

// Renew advances the pin identified by tok to the current head and
// returns a fresh token. A stale token renews nothing.
func (l *Log) Renew(tok Token) (Token, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	p, ok := l.pins[pinKey(tok.kind, tok.name)]
	if !ok || p.token.gen != tok.gen {
		return Token{}, ErrStaleToken
	}
	l.genSeq++
	next := Token{name: tok.name, gen: l.genSeq, kind: tok.kind}
	l.pins[pinKey(tok.kind, tok.name)] = pin{token: next, ver: l.nextSeq}
	return next, nil
}

// Release drops the pin identified by tok. Releasing an old generation
// is a no-op for any newer pin that reused the same name: it returns
// ErrStaleToken and leaves the newer pin untouched.
func (l *Log) Release(tok Token) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := pinKey(tok.kind, tok.name)
	p, ok := l.pins[key]
	if !ok || p.token.gen != tok.gen {
		return ErrStaleToken
	}
	delete(l.pins, key)
	return nil
}

// PinVersion reports the pinned version for a currently valid token.
func (l *Log) PinVersion(tok Token) (uint64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	p, ok := l.pins[pinKey(tok.kind, tok.name)]
	if !ok || p.token.gen != tok.gen {
		return 0, false
	}
	return p.ver, true
}

// Pins returns a deterministic snapshot of all live pins.
func (l *Log) Pins() []Pin {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Pin, 0, len(l.pins))
	for _, p := range l.pins {
		out = append(out, Pin{
			Name: p.token.name,
			Kind: p.token.kind,
			Gen:  p.token.gen,
			Ver:  p.ver,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// Truncate compacts every entry below the current horizon to the latest
// value per key and returns the number of dropped entries. Entries at
// or above the horizon are never touched, so every live lease and
// snapshot keeps full access to the records it still needs.
func (l *Log) Truncate() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	h := l.horizonLocked()
	cut := 0
	for cut < len(l.entries) && l.entries[cut].Seq < h {
		cut++
	}
	latest := make(map[string]int, cut)
	for i := 0; i < cut; i++ {
		latest[l.entries[i].Key] = i
	}
	kept := make([]Entry, 0, len(l.entries))
	dropped := 0
	for i := 0; i < cut; i++ {
		if latest[l.entries[i].Key] == i {
			kept = append(kept, l.entries[i])
		} else {
			dropped++
		}
	}
	l.entries = append(kept, l.entries[cut:]...)
	if h > l.floor {
		l.floor = h
	}
	return dropped
}

// ScanFrom returns every retained entry with Seq >= seq. It fails with
// ErrCompacted if part of that range has already been reclaimed.
func (l *Log) ScanFrom(seq uint64) ([]Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if seq < l.floor {
		return nil, ErrCompacted
	}
	var out []Entry
	for _, e := range l.entries {
		if e.Seq >= seq {
			out = append(out, e)
		}
	}
	return out, nil
}

// StateAt returns the latest value per key as of version ver. It fails
// with ErrCompacted if ver is older than the reclamation floor.
func (l *Log) StateAt(ver uint64) (map[string]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if ver+1 < l.floor {
		return nil, ErrCompacted
	}
	out := make(map[string]string)
	for _, e := range l.entries {
		if e.Seq <= ver {
			out[e.Key] = e.Value
		}
	}
	return out, nil
}
