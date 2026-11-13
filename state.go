package dataeng

import (
	"errors"
	"fmt"
	"time"
)

// EventKind classifies events emitted by State.
type EventKind int

const (
	EventRelation EventKind = iota
	EventInsert
	EventUpdate
	EventDelete
	EventTruncate
	EventMessage
	EventOrigin
	EventCommit
	EventAbort
)

func (k EventKind) String() string {
	switch k {
	case EventRelation:
		return "Relation"
	case EventInsert:
		return "Insert"
	case EventUpdate:
		return "Update"
	case EventDelete:
		return "Delete"
	case EventTruncate:
		return "Truncate"
	case EventMessage:
		return "Message"
	case EventOrigin:
		return "Origin"
	case EventCommit:
		return "Commit"
	case EventAbort:
		return "Abort"
	}
	return "Unknown"
}

// Event is a state change emitted by State. DML and truncate events are
// buffered per transaction and released together with the closing
// EventCommit; aborted transactions release nothing.
type Event struct {
	Kind EventKind
	XID  uint32

	// DML events: the relation generation the tuple was decoded against.
	Relation *Relation
	Old      Tuple
	New      Tuple

	// Truncate events.
	Relations       []*Relation
	Cascade         bool
	RestartIdentity bool

	// Commit events.
	CommitLSN       LSN
	EndLSN          LSN
	CommitTime      time.Time
	Origin          string
	OriginCommitLSN LSN

	// Logical decoding message events.
	LSN     LSN
	Prefix  string
	Content []byte
}

type transaction struct {
	xid       uint32
	beginSeq  uint64
	finalLSN  LSN
	beginTime time.Time
	streamed  bool
	bindings  map[uint32]*Relation
	changes   []Event
	origin    string
	originLSN LSN
	hasOrigin bool
}

// State tracks pgoutput replication state: relation schema generations,
// open (including streamed in-progress) transactions, and the confirmed
// flush position.
//
// Tuple decoding binds each transaction to the relation generation that
// was current when the transaction began, so a transaction that began
// before a DDL keeps decoding with the old generation even after the new
// Relation message arrives. Relations first defined after a transaction
// began (e.g. CREATE TABLE in the same transaction) bind to the earliest
// known generation.
//
// ConfirmedLSN only advances past complete commits (Commit or Stream
// Commit received) whose changes have been marked persisted via
// MarkPersisted.
type State struct {
	gens    map[uint32][]*Relation
	seq     uint64
	txns    map[uint32]*transaction
	current *transaction
	types   map[uint32][2]string

	lastCommitEnd LSN
	persisted     LSN
}

func NewState() *State {
	return &State{
		gens:  make(map[uint32][]*Relation),
		txns:  make(map[uint32]*transaction),
		types: make(map[uint32][2]string),
	}
}

// Apply parses and applies one raw pgoutput message, returning any events
// it releases.
func (s *State) Apply(data []byte) ([]Event, error) {
	m, err := ParseMessage(data)
	if err != nil {
		return nil, err
	}
	return s.ApplyMessage(m)
}

// ApplyMessage applies one already-parsed message, returning any events it
// releases.
func (s *State) ApplyMessage(m any) ([]Event, error) {
	switch msg := m.(type) {
	case *BeginMessage:
		txn := s.newTransaction(msg.XID, false)
		txn.finalLSN = msg.FinalLSN
		txn.beginTime = msg.CommitTime
		s.current = txn
		return nil, nil
	case *RelationMessage:
		s.seq++
		rel := msg.Relation
		rel.Generation = s.seq
		s.gens[rel.ID] = append(s.gens[rel.ID], rel)
		return []Event{{Kind: EventRelation, Relation: rel}}, nil
	case *TypeMessage:
		s.types[msg.ID] = [2]string{msg.Namespace, msg.Name}
		return nil, nil
	case *InsertMessage:
		return nil, s.bufferDML(msg.RelID, func(rel *Relation) (Event, error) {
			t, err := bindTuple(rel, msg.New)
			if err != nil {
				return Event{}, err
			}
			return Event{Kind: EventInsert, Relation: rel, New: t}, nil
		})
	case *UpdateMessage:
		return nil, s.bufferDML(msg.RelID, func(rel *Relation) (Event, error) {
			ev := Event{Kind: EventUpdate, Relation: rel}
			var err error
			if msg.Old != nil {
				if ev.Old, err = bindTuple(rel, msg.Old); err != nil {
					return Event{}, err
				}
			}
			if ev.New, err = bindTuple(rel, msg.New); err != nil {
				return Event{}, err
			}
			return ev, nil
		})
	case *DeleteMessage:
		return nil, s.bufferDML(msg.RelID, func(rel *Relation) (Event, error) {
			t, err := bindTuple(rel, msg.Old)
			if err != nil {
				return Event{}, err
			}
			return Event{Kind: EventDelete, Relation: rel, Old: t}, nil
		})
	case *TruncateMessage:
		txn := s.current
		if txn == nil {
			return nil, errors.New("dataeng: truncate outside transaction")
		}
		ev := Event{
			Kind:            EventTruncate,
			XID:             txn.xid,
			Cascade:         msg.Cascade,
			RestartIdentity: msg.RestartIdentity,
		}
		for _, id := range msg.RelIDs {
			rel, err := s.relationFor(txn, id)
			if err != nil {
				return nil, err
			}
			ev.Relations = append(ev.Relations, rel)
		}
		txn.changes = append(txn.changes, ev)
		return nil, nil
	case *CommitMessage:
		txn := s.current
		if txn == nil {
			return nil, errors.New("dataeng: commit without open transaction")
		}
		return s.commit(txn, msg.CommitLSN, msg.EndLSN, msg.CommitTime), nil
	case *OriginMessage:
		if s.current != nil {
			s.current.origin = msg.Name
			s.current.originLSN = msg.CommitLSN
			s.current.hasOrigin = true
			return nil, nil
		}
		return []Event{{Kind: EventOrigin, Origin: msg.Name, OriginCommitLSN: msg.CommitLSN}}, nil
	case *StreamStartMessage:
		txn := s.txns[msg.XID]
		if txn == nil {
			txn = s.newTransaction(msg.XID, true)
		}
		s.current = txn
		return nil, nil
	case *StreamStopMessage:
		s.current = nil
		return nil, nil
	case *StreamCommitMessage:
		txn := s.txns[msg.XID]
		if txn == nil {
			return nil, fmt.Errorf("dataeng: stream commit for unknown transaction %d", msg.XID)
		}
		return s.commit(txn, msg.CommitLSN, msg.EndLSN, msg.CommitTime), nil
	case *StreamAbortMessage:
		xid := msg.XID
		if msg.SubXID != msg.XID {
			if _, ok := s.txns[msg.SubXID]; ok {
				xid = msg.SubXID
			}
		}
		txn := s.txns[xid]
		if txn == nil {
			return nil, fmt.Errorf("dataeng: stream abort for unknown transaction %d", xid)
		}
		delete(s.txns, xid)
		if s.current == txn {
			s.current = nil
		}
		return []Event{{Kind: EventAbort, XID: xid}}, nil
	case *LogicalMessage:
		ev := Event{Kind: EventMessage, LSN: msg.LSN, Prefix: msg.Prefix, Content: msg.Content}
		if msg.Transactional {
			txn := s.current
			if txn == nil {
				return nil, errors.New("dataeng: transactional message outside transaction")
			}
			ev.XID = txn.xid
			txn.changes = append(txn.changes, ev)
			return nil, nil
		}
		return []Event{ev}, nil
	default:
		return nil, fmt.Errorf("dataeng: unsupported message %T", m)
	}
}

func (s *State) newTransaction(xid uint32, streamed bool) *transaction {
	txn := &transaction{
		xid:      xid,
		beginSeq: s.seq,
		streamed: streamed,
		bindings: make(map[uint32]*Relation),
	}
	s.txns[xid] = txn
	return txn
}

func (s *State) bufferDML(relID uint32, make func(rel *Relation) (Event, error)) error {
	txn := s.current
	if txn == nil {
		return errors.New("dataeng: change outside transaction")
	}
	rel, err := s.relationFor(txn, relID)
	if err != nil {
		return err
	}
	ev, err := make(rel)
	if err != nil {
		return err
	}
	ev.XID = txn.xid
	txn.changes = append(txn.changes, ev)
	return nil
}

// relationFor resolves the relation generation bound to txn: the newest
// generation that existed when the transaction began, falling back to the
// earliest known generation for relations defined afterwards.
func (s *State) relationFor(txn *transaction, relID uint32) (*Relation, error) {
	if rel, ok := txn.bindings[relID]; ok {
		return rel, nil
	}
	gens := s.gens[relID]
	if len(gens) == 0 {
		return nil, fmt.Errorf("dataeng: unknown relation %d", relID)
	}
	rel := gens[0]
	for _, g := range gens {
		if g.Generation > txn.beginSeq {
			break
		}
		rel = g
	}
	txn.bindings[relID] = rel
	return rel, nil
}

func bindTuple(rel *Relation, vals []TupleValue) (Tuple, error) {
	if len(vals) != len(rel.Columns) {
		return Tuple{}, fmt.Errorf("dataeng: relation %s generation %d has %d columns, tuple has %d",
			rel.Name, rel.Generation, len(rel.Columns), len(vals))
	}
	return Tuple{Relation: rel, Values: vals}, nil
}

func (s *State) commit(txn *transaction, commitLSN, endLSN LSN, commitTime time.Time) []Event {
	delete(s.txns, txn.xid)
	if s.current == txn {
		s.current = nil
	}
	events := make([]Event, 0, len(txn.changes)+1)
	events = append(events, txn.changes...)
	ev := Event{
		Kind:       EventCommit,
		XID:        txn.xid,
		CommitLSN:  commitLSN,
		EndLSN:     endLSN,
		CommitTime: commitTime,
	}
	if txn.hasOrigin {
		ev.Origin = txn.origin
		ev.OriginCommitLSN = txn.originLSN
	}
	events = append(events, ev)
	if endLSN > s.lastCommitEnd {
		s.lastCommitEnd = endLSN
	}
	return events
}

// MarkPersisted records that all changes up to lsn have been durably
// persisted by the collector. It only moves forward.
func (s *State) MarkPersisted(lsn LSN) {
	if lsn > s.persisted {
		s.persisted = lsn
	}
}

// LastCommitEndLSN is the end LSN of the most recent complete commit
// (Commit or Stream Commit message fully received).
func (s *State) LastCommitEndLSN() LSN {
	return s.lastCommitEnd
}

// ConfirmedLSN is the flush position safe to confirm upstream: it never
// advances past a complete commit that has not been persisted, and never
// past the end of the most recent complete commit (so incomplete streamed
// transactions hold it back).
func (s *State) ConfirmedLSN() LSN {
	c := s.lastCommitEnd
	if s.persisted < c {
		c = s.persisted
	}
	return c
}

// CurrentRelation returns the newest generation of the given relation, or
// nil if none is known.
func (s *State) CurrentRelation(relID uint32) *Relation {
	gens := s.gens[relID]
	if len(gens) == 0 {
		return nil
	}
	return gens[len(gens)-1]
}
