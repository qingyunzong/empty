package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

// pgoutput logical replication message types.
const (
	msgRelation     = 'R'
	msgType         = 'Y'
	msgInsert       = 'I'
	msgUpdate       = 'U'
	msgDelete       = 'D'
	msgTruncate     = 'T'
	msgBegin        = 'B'
	msgCommit       = 'C'
	msgOrigin       = 'O'
	msgMessage      = 'M'
	msgStreamStart  = 'S'
	msgStreamStop   = 'E'
	msgStreamCommit = 'c'
	msgStreamAbort  = 'A'
)

var pgEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

func pgTime(micros int64) time.Time {
	return pgEpoch.Add(time.Duration(micros) * time.Microsecond)
}

// BeginMessage starts a transaction.
type BeginMessage struct {
	FinalLSN   LSN
	CommitTime time.Time
	XID        uint32
}

// CommitMessage commits the current transaction.
type CommitMessage struct {
	Flags      byte
	CommitLSN  LSN
	EndLSN     LSN
	CommitTime time.Time
}

// OriginMessage identifies the upstream origin of the current transaction.
type OriginMessage struct {
	CommitLSN LSN
	Name      string
}

// RelationMessage describes (a new generation of) a relation schema.
type RelationMessage struct {
	Relation *Relation
}

// TypeMessage describes a custom data type.
type TypeMessage struct {
	ID        uint32
	Namespace string
	Name      string
}

// InsertMessage carries a new tuple.
type InsertMessage struct {
	RelID uint32
	New   []TupleValue
}

// UpdateMessage carries an optional old tuple ('K' key or 'O' full old row)
// and the new tuple.
type UpdateMessage struct {
	RelID   uint32
	OldType byte
	Old     []TupleValue
	New     []TupleValue
}

// DeleteMessage carries the old tuple ('K' key or 'O' full old row).
type DeleteMessage struct {
	RelID   uint32
	OldType byte
	Old     []TupleValue
}

// TruncateMessage truncates one or more relations.
type TruncateMessage struct {
	RelIDs          []uint32
	Cascade         bool
	RestartIdentity bool
}

// StreamStartMessage opens a segment of an in-progress streamed transaction.
type StreamStartMessage struct {
	XID          uint32
	FirstSegment bool
}

// StreamStopMessage ends the current stream segment.
type StreamStopMessage struct{}

// StreamCommitMessage commits a streamed transaction.
type StreamCommitMessage struct {
	XID        uint32
	Flags      byte
	CommitLSN  LSN
	EndLSN     LSN
	CommitTime time.Time
}

// StreamAbortMessage aborts a streamed (sub)transaction.
type StreamAbortMessage struct {
	XID    uint32
	SubXID uint32
}

// LogicalMessage is a logical decoding message written via pg_logical_emit_message.
type LogicalMessage struct {
	Transactional bool
	LSN           LSN
	Prefix        string
	Content       []byte
}

type reader struct {
	b   []byte
	off int
	err error
}

func (r *reader) take(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || len(r.b)-r.off < n {
		r.err = errors.New("dataeng: truncated message")
		return nil
	}
	p := r.b[r.off : r.off+n]
	r.off += n
	return p
}

func (r *reader) u8() byte {
	p := r.take(1)
	if p == nil {
		return 0
	}
	return p[0]
}

func (r *reader) u16() uint16 {
	p := r.take(2)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint16(p)
}

func (r *reader) u32() uint32 {
	p := r.take(4)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint32(p)
}

func (r *reader) u64() uint64 {
	p := r.take(8)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint64(p)
}

func (r *reader) cstr() string {
	if r.err != nil {
		return ""
	}
	idx := bytes.IndexByte(r.b[r.off:], 0)
	if idx < 0 {
		r.err = errors.New("dataeng: unterminated string")
		return ""
	}
	s := string(r.b[r.off : r.off+idx])
	r.off += idx + 1
	return s
}

func parseTuple(r *reader) []TupleValue {
	n := int(r.u16())
	vals := make([]TupleValue, 0, n)
	for i := 0; i < n; i++ {
		v := TupleValue{Kind: TupleValueKind(r.u8())}
		switch v.Kind {
		case TupleNull, TupleUnchanged:
		case TupleText, TupleBinary:
			l := int(r.u32())
			if p := r.take(l); p != nil {
				v.Data = append([]byte(nil), p...)
			}
		default:
			if r.err == nil {
				r.err = fmt.Errorf("dataeng: unknown tuple value kind %q", byte(v.Kind))
			}
			return nil
		}
		vals = append(vals, v)
	}
	return vals
}

// ParseMessage decodes one pgoutput protocol message.
func ParseMessage(data []byte) (any, error) {
	if len(data) == 0 {
		return nil, errors.New("dataeng: empty message")
	}
	r := &reader{b: data}
	var m any
	switch typ := r.u8(); typ {
	case msgBegin:
		m = &BeginMessage{
			FinalLSN:   LSN(r.u64()),
			CommitTime: pgTime(int64(r.u64())),
			XID:        r.u32(),
		}
	case msgCommit:
		m = &CommitMessage{
			Flags:      r.u8(),
			CommitLSN:  LSN(r.u64()),
			EndLSN:     LSN(r.u64()),
			CommitTime: pgTime(int64(r.u64())),
		}
	case msgOrigin:
		m = &OriginMessage{
			CommitLSN: LSN(r.u64()),
			Name:      r.cstr(),
		}
	case msgRelation:
		rel := &Relation{
			ID:              r.u32(),
			Namespace:       r.cstr(),
			Name:            r.cstr(),
			ReplicaIdentity: r.u8(),
		}
		ncol := int(r.u16())
		rel.Columns = make([]Column, 0, ncol)
		for i := 0; i < ncol; i++ {
			flags := r.u8()
			rel.Columns = append(rel.Columns, Column{
				Key:     flags&1 != 0,
				Name:    r.cstr(),
				TypeOID: r.u32(),
				TypeMod: int32(r.u32()),
			})
		}
		m = &RelationMessage{Relation: rel}
	case msgType:
		m = &TypeMessage{
			ID:        r.u32(),
			Namespace: r.cstr(),
			Name:      r.cstr(),
		}
	case msgInsert:
		im := &InsertMessage{RelID: r.u32()}
		if t := r.u8(); t != 'N' {
			return nil, fmt.Errorf("dataeng: insert: expected 'N' tuple, got %q", t)
		}
		im.New = parseTuple(r)
		m = im
	case msgUpdate:
		um := &UpdateMessage{RelID: r.u32()}
		t := r.u8()
		if t == 'K' || t == 'O' {
			um.OldType = t
			um.Old = parseTuple(r)
			t = r.u8()
		}
		if t != 'N' {
			return nil, fmt.Errorf("dataeng: update: expected 'N' tuple, got %q", t)
		}
		um.New = parseTuple(r)
		m = um
	case msgDelete:
		dm := &DeleteMessage{RelID: r.u32()}
		t := r.u8()
		if t != 'K' && t != 'O' {
			return nil, fmt.Errorf("dataeng: delete: expected 'K' or 'O' tuple, got %q", t)
		}
		dm.OldType = t
		dm.Old = parseTuple(r)
		m = dm
	case msgTruncate:
		n := int(r.u32())
		opts := r.u8()
		tm := &TruncateMessage{
			Cascade:         opts&1 != 0,
			RestartIdentity: opts&2 != 0,
		}
		for i := 0; i < n; i++ {
			tm.RelIDs = append(tm.RelIDs, r.u32())
		}
		m = tm
	case msgStreamStart:
		m = &StreamStartMessage{
			XID:          r.u32(),
			FirstSegment: r.u8() != 0,
		}
	case msgStreamStop:
		m = &StreamStopMessage{}
	case msgStreamCommit:
		m = &StreamCommitMessage{
			XID:        r.u32(),
			Flags:      r.u8(),
			CommitLSN:  LSN(r.u64()),
			EndLSN:     LSN(r.u64()),
			CommitTime: pgTime(int64(r.u64())),
		}
	case msgStreamAbort:
		m = &StreamAbortMessage{
			XID:    r.u32(),
			SubXID: r.u32(),
		}
	case msgMessage:
		lm := &LogicalMessage{
			Transactional: r.u8() != 0,
			LSN:           LSN(r.u64()),
			Prefix:        r.cstr(),
		}
		l := int(r.u32())
		if p := r.take(l); p != nil {
			lm.Content = append([]byte(nil), p...)
		}
		m = lm
	default:
		return nil, fmt.Errorf("dataeng: unknown message type %q", typ)
	}
	if r.err != nil {
		return nil, r.err
	}
	if r.off != len(r.b) {
		return nil, fmt.Errorf("dataeng: %d trailing bytes in message", len(r.b)-r.off)
	}
	return m, nil
}
