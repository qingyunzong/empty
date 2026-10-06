package comm

// Message is the unit of delivery. ID is the idempotency key: for a given
// ID the payload must never change.
type Message struct {
	ID      string
	Payload string
}

// AckStatus describes how the receiver handled a delivery.
type AckStatus string

const (
	AckApplied   AckStatus = "applied"   // effect written for the first time
	AckDuplicate AckStatus = "duplicate" // already applied, effect skipped
	AckRejected  AckStatus = "rejected"  // same ID, different payload
)

// Ack is the receiver's receipt. Acks may be lost in transit; the sender
// retries and the receiver must stay idempotent.
type Ack struct {
	ID     string
	Status AckStatus
}
