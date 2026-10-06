package commlib

// Message is the unit of reliable delivery. ID is the dedup key and must be
// stable across retransmissions.
type Message struct {
	ID      string
	Payload []byte
}

// AckStatus is the receiver's verdict for a delivered message.
type AckStatus int

const (
	// AckOK means the message was applied exactly now.
	AckOK AckStatus = iota
	// AckDuplicate means the message was already applied earlier; the ack is
	// idempotent so the sender can safely retire the outbox record.
	AckDuplicate
	// AckConflict means a different payload was already recorded under the
	// same ID. The delivery is rejected.
	AckConflict
)

type Ack struct {
	Status AckStatus
}
