// Package q190 implements the receiver side of the MQTT QoS 2 delivery flow.
//
// The package is deliberately transport agnostic: the caller supplies already
// decoded PUBLISH and PUBREL packets together with a persistent transactional
// store and a business sink. The component only enforces the QoS 2 state
// machine and the durability ordering required by MQTT:
//
//   - A PUBREC is produced only after the packet ID and payload are persisted.
//   - A PUBCOMP is produced only after the business effect and the completion
//     marker have been committed in the same store transaction, so a
//     retransmitted PUBREL can never apply the business effect twice.
//   - A PUBLISH reusing a packet ID whose exchange is complete starts a new
//     generation of that packet ID.
package q190

import (
	"bytes"
	"context"
	"errors"
)

// Sentinel errors returned by the receiver. Storage failures are returned
// unwrapped so callers can inspect their own error types with errors.Is/As.
var (
	// ErrInvalidPacketID means the caller supplied packet ID zero, which is not
	// a valid MQTT packet identifier.
	ErrInvalidPacketID = errors.New("q190: invalid packet id")

	// ErrPayloadMismatch means a retransmitted PUBLISH carried a different
	// payload than the one already persisted for the current generation. The
	// caller must treat this as an MQTT protocol error and disconnect.
	ErrPayloadMismatch = errors.New("q190: retransmitted PUBLISH payload mismatch")
)

// Phase is the durable state of a single QoS 2 exchange generation.
type Phase int

const (
	// PhaseUnknown means no state exists for the packet ID.
	PhaseUnknown Phase = iota
	// PhasePublished means the PUBLISH has been stored and PUBREC has been or
	// is about to be sent; PUBREL has not yet been durably completed.
	PhasePublished
	// PhaseComplete means the business effect and completion marker were
	// committed together and PUBCOMP has been or is about to be sent.
	PhaseComplete
)

func (p Phase) String() string {
	switch p {
	case PhasePublished:
		return "published"
	case PhaseComplete:
		return "complete"
	default:
		return "unknown"
	}
}

// Publish is an already decoded inbound QoS 2 PUBLISH packet.
type Publish struct {
	// PacketID is the MQTT packet identifier and must be between 1 and 65535.
	PacketID uint16
	// Payload is the already decoded application payload.
	Payload []byte
	// Dup is the DUP flag of the PUBLISH packet. It is advisory only: the
	// durable store, not the flag, decides whether a packet is a retransmission.
	Dup bool
}

// Pubrel is an already decoded inbound PUBREL packet.
type Pubrel struct {
	// PacketID is the MQTT packet identifier and must be between 1 and 65535.
	PacketID uint16
}

// Record is the durable state of one packet ID generation.
type Record struct {
	// PacketID is the MQTT packet identifier.
	PacketID uint16
	// Generation distinguishes successive exchanges that reuse the same packet
	// ID. It starts at one and increases by one for every new exchange.
	Generation int64
	// Phase is the current durable phase of the generation.
	Phase Phase
	// Payload is the payload persisted with the PUBLISH.
	Payload []byte
}

// Tx is a store transaction. Implementations must make the transaction
// serializable with respect to other transactions and make Rollback a no-op
// after a successful Commit.
type Tx interface {
	// Record returns the record staged inside the transaction, or the state
	// visible from the store when the transaction has not touched the packet ID.
	// A nil record means the packet ID currently has no durable state.
	Record(packetID uint16) (*Record, error)

	// PutPublish durably stages a PUBLISH for the given generation.
	PutPublish(rec Record) error

	// PutComplete durably stages the completion marker for the record. The
	// staged record must keep its packet ID, generation and payload while its
	// phase becomes PhaseComplete.
	PutComplete(rec Record) error

	// Underlying exposes the native transaction object to the business sink.
	Underlying() any

	// Commit commits every staged mutation and the business effect together.
	Commit() error

	// Rollback discards the transaction. It must be a no-op after Commit.
	Rollback() error
}

// Store is the persistent boundary that owns QoS 2 protocol state.
type Store interface {
	// Begin opens a serializable transaction.
	Begin(ctx context.Context) (Tx, error)

	// Load returns the latest record for a packet ID. A nil record means the
	// packet ID currently has no durable state.
	Load(ctx context.Context, packetID uint16) (*Record, error)

	// Clear removes every persisted record. It is used to implement MQTT clean
	// start, which must erase all protocol state.
	Clear(ctx context.Context) error
}

// Sink applies the business effect of a PUBLISH.
//
// Apply runs inside the same transaction that records completion. It must
// enlist its effect into tx (for example by writing through the native
// transaction returned by tx.Underlying) and must not commit or roll back tx
// itself. A returned error aborts the exchange and nothing is committed.
type Sink interface {
	Apply(ctx context.Context, tx Tx, rec Record) error
}

// SinkFunc adapts a plain function to the Sink interface.
type SinkFunc func(ctx context.Context, tx Tx, rec Record) error

// Apply implements Sink.
func (f SinkFunc) Apply(ctx context.Context, tx Tx, rec Record) error {
	return f(ctx, tx, rec)
}

// Action is the result of handling one decoded packet.
type Action interface {
	isAction()
}

// PubrecAction instructs the caller to send PUBREC for the packet ID.
type PubrecAction struct {
	PacketID   uint16
	Generation int64
	// Stored is true when this call created a new generation, and false when
	// it acknowledged a retransmitted PUBLISH whose payload already matched.
	Stored bool
}

func (PubrecAction) isAction() {}

// RejectAction instructs the caller to reject the PUBLISH. Err is always one
// of the package's sentinel errors.
type RejectAction struct {
	PacketID   uint16
	Generation int64
	Err        error
}

func (RejectAction) isAction() {}

// PubcompAction instructs the caller to send PUBCOMP for the packet ID.
type PubcompAction struct {
	PacketID   uint16
	Generation int64
	// Applied is true when this call committed the business effect, and false
	// when it acknowledged a retransmitted PUBREL after completion.
	Applied bool
	// Unknown is true when no state exists for the packet ID. MQTT requires
	// answering an unknown PUBREL with PUBCOMP without any business effect.
	Unknown bool
}

func (PubcompAction) isAction() {}

// Receiver runs the QoS 2 inbound state machine over a persistent store.
//
// A Receiver is safe for concurrent use. All state decisions are made inside
// serializable store transactions, so the same packet ID can be handled from
// multiple goroutines without corrupting generations or applying a sink twice.
type Receiver struct {
	store Store
	sink  Sink
}

// NewReceiver builds a Receiver backed by store and delivering business
// effects through sink. Both arguments are required.
func NewReceiver(store Store, sink Sink) *Receiver {
	if store == nil {
		panic("q190: NewReceiver requires a non-nil store")
	}
	if sink == nil {
		panic("q190: NewReceiver requires a non-nil sink")
	}
	return &Receiver{store: store, sink: sink}
}

// HandlePublish processes a decoded QoS 2 PUBLISH.
//
// The returned action is either a PubrecAction or a RejectAction unless the
// store fails, in which case the underlying storage error is returned and the
// caller may retry the PUBLISH.
func (r *Receiver) HandlePublish(ctx context.Context, p Publish) (Action, error) {
	if p.PacketID == 0 {
		return RejectAction{PacketID: 0, Generation: 0, Err: ErrInvalidPacketID}, nil
	}

	tx, err := r.store.Begin(ctx)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	existing, err := tx.Record(p.PacketID)
	if err != nil {
		return nil, err
	}

	switch {
	case existing == nil:
		rec := Record{
			PacketID:   p.PacketID,
			Generation: 1,
			Phase:      PhasePublished,
			Payload:    append([]byte(nil), p.Payload...),
		}
		if err := tx.PutPublish(rec); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return PubrecAction{PacketID: p.PacketID, Generation: 1, Stored: true}, nil

	case existing.Phase == PhasePublished:
		if !bytes.Equal(existing.Payload, p.Payload) {
			return RejectAction{
				PacketID:   p.PacketID,
				Generation: existing.Generation,
				Err:        ErrPayloadMismatch,
			}, nil
		}
		return PubrecAction{
			PacketID:   p.PacketID,
			Generation: existing.Generation,
			Stored:     false,
		}, nil

	default: // PhaseComplete: the packet ID is reused for a new exchange.
		rec := Record{
			PacketID:   p.PacketID,
			Generation: existing.Generation + 1,
			Phase:      PhasePublished,
			Payload:    append([]byte(nil), p.Payload...),
		}
		if err := tx.PutPublish(rec); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true
		return PubrecAction{
			PacketID:   p.PacketID,
			Generation: rec.Generation,
			Stored:     true,
		}, nil
	}
}

// HandlePubrel processes a decoded PUBREL.
//
// When a matching PhasePublished record exists, the sink effect and the
// completion marker are staged in one transaction and the caller receives a
// PubcompAction only after that transaction commits. A retransmitted PUBREL
// finds PhaseComplete and is answered without invoking the sink again. An
// unknown packet ID is answered with PUBCOMP without any business effect.
func (r *Receiver) HandlePubrel(ctx context.Context, pr Pubrel) (PubcompAction, error) {
	if pr.PacketID == 0 {
		return PubcompAction{}, ErrInvalidPacketID
	}

	tx, err := r.store.Begin(ctx)
	if err != nil {
		return PubcompAction{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	existing, err := tx.Record(pr.PacketID)
	if err != nil {
		return PubcompAction{}, err
	}

	switch {
	case existing == nil:
		// MQTT 5.0 §3.6.2-2: an unknown PUBREL is still acknowledged with PUBCOMP.
		return PubcompAction{PacketID: pr.PacketID, Unknown: true}, nil

	case existing.Phase == PhaseComplete:
		return PubcompAction{
			PacketID:   pr.PacketID,
			Generation: existing.Generation,
			Applied:    false,
		}, nil

	default: // PhasePublished
		rec := *existing
		rec.Phase = PhaseComplete
		if err := r.sink.Apply(ctx, tx, rec); err != nil {
			return PubcompAction{}, err
		}
		if err := tx.PutComplete(rec); err != nil {
			return PubcompAction{}, err
		}
		if err := tx.Commit(); err != nil {
			return PubcompAction{}, err
		}
		committed = true
		return PubcompAction{
			PacketID:   pr.PacketID,
			Generation: rec.Generation,
			Applied:    true,
		}, nil
	}
}

// CleanStart erases every persisted record. A new MQTT connection with clean
// start enabled must call this before handling packets. A durable session
// connection must not call it, which leaves the persisted state available for
// automatic recovery through Load and the Handle* methods.
func (r *Receiver) CleanStart(ctx context.Context) error {
	return r.store.Clear(ctx)
}

// Load returns the persisted record for a packet ID. A nil record means no
// state exists. Callers can use it to inspect recovered session state.
func (r *Receiver) Load(ctx context.Context, packetID uint16) (*Record, error) {
	return r.store.Load(ctx, packetID)
}
