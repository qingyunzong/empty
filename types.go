package dataeng

import "time"

// SequenceNumber is the OPC UA publish sequence number. It is an alias rather
// than a distinct type so callers can use ordinary uint32 values.
type SequenceNumber = uint32

// PublishSequence is an alias for the OPC UA publish sequence number.
type PublishSequence = uint32

// NotificationData is one notification carried by a NotificationMessage.
// The subscription state machine treats Payload and Value as opaque data.
type NotificationData struct {
	Payload []byte
	Value   any
}

// Notification is an alias for NotificationData.
type Notification = NotificationData

// NotificationMessage mirrors the parts of the OPC UA NotificationMessage that
// are relevant to sequence tracking.
type NotificationMessage struct {
	SequenceNumber   uint32
	PublishTime      time.Time
	NotificationData []NotificationData
	Persisted        bool
}

// PublishResponse is the input to Subscription.HandlePublish.
//
// SessionID, SubscriptionID, SequenceNumber and NotificationData are the
// canonical fields. The alternative spellings are accepted as a convenience
// for callers that map generated OPC UA structures directly into this type.
// NotificationMessage is also accepted; direct fields take precedence.
type PublishResponse struct {
	SessionID      string
	SessionId      string
	SubscriptionID uint32
	SubscriptionId uint32

	SequenceNumber uint32
	Sequence       uint32

	AvailableSequenceNumbers []uint32
	Available                []uint32
	NotificationMessage      NotificationMessage
	NotificationData         []NotificationData
	Notifications            []NotificationData
	MoreNotifications        bool
	KeepAlive                bool
	Keepalive                bool
	Status                   StatusCode
	StatusCode               StatusCode
	Persisted                bool
	Stored                   bool

	// SessionGeneration is optional. When non-zero and a transfer has already
	// occurred, it must match the subscription's current generation.
	SessionGeneration uint64
}

// RepublishResponse is the input to Subscription.HandleRepublish.
type RepublishResponse struct {
	SessionID      string
	SessionId      string
	SubscriptionID uint32
	SubscriptionId uint32

	SequenceNumber uint32
	Sequence       uint32

	AvailableSequenceNumbers []uint32
	Available                []uint32
	NotificationMessage      NotificationMessage
	NotificationData         []NotificationData
	Notifications            []NotificationData
	Status                   StatusCode
	StatusCode               StatusCode
	Persisted                bool
	Stored                   bool
	SessionGeneration        uint64
}

// RepublishRequest identifies a batch of messages the client should ask the
// server to retransmit.
type RepublishRequest struct {
	SessionID       string
	SubscriptionID  uint32
	SequenceNumbers []uint32
}

// PublishResult describes how a PublishResponse changed the subscription.
type PublishResult struct {
	// Accepted is true when the response carried a new notification message.
	Accepted bool
	// Duplicate is true when the sequence number was already seen.
	Duplicate bool
	// Stale is true when the response belongs to an old session or another
	// subscription and was ignored.
	Stale bool
	// KeepAlive is true for a keep-alive response. Such a response never
	// advances the notification sequence.
	KeepAlive bool

	SequenceNumber           uint32
	Status                   StatusCode
	AvailableSequenceNumbers []uint32
	AcceptedSequenceNumbers  []uint32
	PendingRepublish         []uint32
	// Republish is kept as an alias of PendingRepublish.
	Republish        []uint32
	PermanentMissing []uint32
	// Missing is kept as an alias of PermanentMissing.
	Missing     []uint32
	AckSequence uint32
	Err         error
}

// PublishOutcome is an alias for PublishResult.
type PublishOutcome = PublishResult

// RepublishResult describes how a RepublishResponse changed the subscription.
type RepublishResult struct {
	Accepted  bool
	Duplicate bool
	Stale     bool
	// Permanent is true when the server confirmed the requested message is
	// no longer available.
	Permanent bool

	SequenceNumber           uint32
	Status                   StatusCode
	AvailableSequenceNumbers []uint32
	AcceptedSequenceNumbers  []uint32
	PendingRepublish         []uint32
	Republish                []uint32
	PermanentMissing         []uint32
	Missing                  []uint32
	AckSequence              uint32
	Err                      error
}

// RepublishOutcome is an alias for RepublishResult.
type RepublishOutcome = RepublishResult

// Config holds the optional constructor settings for a Subscription.
type Config struct {
	SessionID      string
	SubscriptionID uint32
	// MaxGap limits how many sequence numbers may be materialized for one
	// newly observed gap. It protects the process from a malicious or corrupt
	// sequence number. The default is 1<<20.
	MaxGap uint32
}

// Options is an alias for Config.
type Options = Config

// SubscriptionConfig is an alias for Config.
type SubscriptionConfig = Config

// Option configures a Subscription at construction time.
type Option func(*Config)

// WithSessionID sets the initial OPC UA session identifier.
func WithSessionID(id string) Option {
	return func(c *Config) { c.SessionID = id }
}

// WithSession is an alias for WithSessionID.
func WithSession(id string) Option { return WithSessionID(id) }

// WithSubscriptionID sets the OPC UA subscription identifier.
func WithSubscriptionID(id uint32) Option {
	return func(c *Config) { c.SubscriptionID = id }
}

// WithSubscription is an alias for WithSubscriptionID.
func WithSubscription(id uint32) Option { return WithSubscriptionID(id) }

// WithMaxGap sets the maximum number of sequence numbers materialized for one
// gap.
func WithMaxGap(n uint32) Option {
	return func(c *Config) {
		if n > 0 {
			c.MaxGap = n
		}
	}
}

// Snapshot is a consistent copy of the subscription state.
type Snapshot struct {
	SessionID                string
	SubscriptionID           uint32
	Generation               uint64
	NextSequenceNumber       uint32
	LastSequenceNumber       uint32
	AckSequenceNumber        uint32
	AvailableSequenceNumbers []uint32
	PendingRepublish         []uint32
	PermanentlyMissing       []uint32
	KeepAliveCount           uint64
}

// SubscriptionSnapshot is an alias for Snapshot.
type SubscriptionSnapshot = Snapshot

func (r PublishResponse) sessionID() string {
	if r.SessionID != "" {
		return r.SessionID
	}
	return r.SessionId
}

func (r PublishResponse) subscriptionID() uint32 {
	if r.SubscriptionID != 0 {
		return r.SubscriptionID
	}
	return r.SubscriptionId
}

func (r PublishResponse) sequenceNumber() uint32 {
	if r.SequenceNumber != 0 {
		return r.SequenceNumber
	}
	if r.Sequence != 0 {
		return r.Sequence
	}
	return r.NotificationMessage.SequenceNumber
}

func (r PublishResponse) notificationData() []NotificationData {
	if r.NotificationData != nil {
		return r.NotificationData
	}
	if r.Notifications != nil {
		return r.Notifications
	}
	return r.NotificationMessage.NotificationData
}

func (r PublishResponse) availableSequenceNumbers() []uint32 {
	if r.AvailableSequenceNumbers != nil {
		return r.AvailableSequenceNumbers
	}
	return r.Available
}

func (r PublishResponse) statusCode() StatusCode {
	if r.Status != 0 {
		return r.Status
	}
	return r.StatusCode
}

func (r PublishResponse) persisted() bool {
	return r.Persisted || r.Stored || r.NotificationMessage.Persisted
}

func (r PublishResponse) keepAlive() bool {
	if r.KeepAlive || r.Keepalive {
		return true
	}
	// A NotificationMessage with an explicitly empty notification list is a
	// keep-alive. A bare direct SequenceNumber with no payload is still
	// treated as a notification message so callers can use the sequence
	// fields without constructing dummy payloads.
	nm := r.NotificationMessage
	if nm.SequenceNumber != 0 || nm.NotificationData != nil || !nm.PublishTime.IsZero() {
		return len(r.notificationData()) == 0
	}
	if r.NotificationData != nil && len(r.NotificationData) == 0 {
		return true
	}
	return r.Notifications != nil && len(r.Notifications) == 0
}

func (r RepublishResponse) sessionID() string {
	if r.SessionID != "" {
		return r.SessionID
	}
	return r.SessionId
}

func (r RepublishResponse) subscriptionID() uint32 {
	if r.SubscriptionID != 0 {
		return r.SubscriptionID
	}
	return r.SubscriptionId
}

func (r RepublishResponse) sequenceNumber() uint32 {
	if r.SequenceNumber != 0 {
		return r.SequenceNumber
	}
	if r.Sequence != 0 {
		return r.Sequence
	}
	return r.NotificationMessage.SequenceNumber
}

func (r RepublishResponse) notificationData() []NotificationData {
	if r.NotificationData != nil {
		return r.NotificationData
	}
	if r.Notifications != nil {
		return r.Notifications
	}
	return r.NotificationMessage.NotificationData
}

func (r RepublishResponse) availableSequenceNumbers() []uint32 {
	if r.AvailableSequenceNumbers != nil {
		return r.AvailableSequenceNumbers
	}
	return r.Available
}

func (r RepublishResponse) statusCode() StatusCode {
	if r.Status != 0 {
		return r.Status
	}
	return r.StatusCode
}

func (r RepublishResponse) persisted() bool {
	return r.Persisted || r.Stored || r.NotificationMessage.Persisted
}
