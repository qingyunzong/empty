package leasesim

import "fmt"

// EventKind identifies the type of a simulation event.
type EventKind int

const (
	// EvGrant asks the manager to grant a lease to Holder at Time.
	EvGrant EventKind = iota
	// EvRenew asks the manager to renew the lease of Holder at Time.
	EvRenew
	// EvTakeover performs an authoritative switch to Holder at Time.
	EvTakeover
	// EvWrite attempts a fenced write by Holder at Time. The holder uses
	// the fence it last learned; a partitioned holder may present a stale
	// fence and must be rejected.
	EvWrite
	// EvPartition cuts Holder off from the manager: it can no longer
	// renew and it stops learning new fence numbers, but it may keep
	// trying to write with the fence it already holds.
	EvPartition
	// EvHeal reconnects Holder to the manager.
	EvHeal
)

// Event is one deterministic step in a simulation log.
type Event struct {
	Kind   EventKind
	Time   int64
	Holder string
	TTL    int64 // grant/renew/takeover
	Key    string
	Value  string
}

// Result records the outcome of replaying one event.
type Result struct {
	Event Event
	Lease Lease
	Write Write
	Err   error
}

// Simulator replays an event log against a Manager and a Store. It models
// holders that cache their last known fence and may be partitioned from the
// manager while still attempting writes.
type Simulator struct {
	Mgr   *Manager
	Store *Store

	knownFence  map[string]uint64
	partitioned map[string]bool
}

// NewSimulator returns a Simulator with a fresh Manager and Store.
func NewSimulator() *Simulator {
	mgr := &Manager{}
	return &Simulator{
		Mgr:         mgr,
		Store:       NewStore(mgr),
		knownFence:  make(map[string]uint64),
		partitioned: make(map[string]bool),
	}
}

// Replay applies every event in order and returns one Result per event.
func (s *Simulator) Replay(events []Event) []Result {
	results := make([]Result, 0, len(events))
	for _, ev := range events {
		results = append(results, s.step(ev))
	}
	return results
}

func (s *Simulator) step(ev Event) Result {
	res := Result{Event: ev}
	switch ev.Kind {
	case EvGrant, EvRenew, EvTakeover:
		if s.partitioned[ev.Holder] {
			res.Err = fmt.Errorf("leasesim: holder %q is partitioned from the manager", ev.Holder)
			return res
		}
		var lease Lease
		var err error
		switch ev.Kind {
		case EvGrant:
			lease, err = s.Mgr.Grant(ev.Holder, ev.Time, ev.TTL)
		case EvRenew:
			lease, err = s.Mgr.Renew(ev.Holder, ev.Time, ev.TTL)
		case EvTakeover:
			lease, err = s.Mgr.Takeover(ev.Holder, ev.Time, ev.TTL)
		}
		if err != nil {
			res.Err = err
			return res
		}
		s.knownFence[ev.Holder] = lease.Fence
		res.Lease = lease
	case EvWrite:
		fence := s.knownFence[ev.Holder]
		err := s.Store.Write(ev.Holder, fence, ev.Key, ev.Value, ev.Time)
		if err != nil {
			res.Err = err
			return res
		}
		res.Write = Write{Holder: ev.Holder, Fence: fence, Key: ev.Key, Value: ev.Value, Time: ev.Time}
	case EvPartition:
		s.partitioned[ev.Holder] = true
	case EvHeal:
		delete(s.partitioned, ev.Holder)
		// On heal the holder learns the current fence, if any.
		if lease, ok := s.Mgr.Current(); ok {
			s.knownFence[ev.Holder] = lease.Fence
		}
	}
	return res
}
