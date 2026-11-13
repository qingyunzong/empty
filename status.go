package dataeng

import "fmt"

// StatusCode is an OPC UA status code.
//
// Only the severity bits are interpreted by the subscription state machine.
// A republish response with a non-good status that describes a missing
// notification confirms that the sequence number can no longer be recovered.
type StatusCode uint32

// Status is an alias for StatusCode.
type Status = StatusCode

const (
	StatusGood                      StatusCode = 0x00000000
	StatusBad                       StatusCode = 0x80000000
	StatusBadUnexpectedError        StatusCode = 0x80010000
	StatusBadCommunicationError     StatusCode = 0x80050000
	StatusBadTimeout                StatusCode = 0x800A0000
	StatusBadShutdown               StatusCode = 0x800C0000
	StatusBadServerNotConnected     StatusCode = 0x800D0000
	StatusBadSessionIDInvalid       StatusCode = 0x80250000
	StatusBadSessionClosed          StatusCode = 0x80260000
	StatusBadSubscriptionIDInvalid  StatusCode = 0x80280000
	StatusBadSecureChannelIDInvalid StatusCode = 0x80220000
	StatusBadTooManyPublishRequests StatusCode = 0x80780000
	StatusBadNoSubscription         StatusCode = 0x80790000
	StatusBadSequenceNumberUnknown  StatusCode = 0x807A0000
	StatusBadMessageNotAvailable    StatusCode = 0x807B0000
	StatusBadNoData                 StatusCode = 0x809B0000
	StatusBadDataLost               StatusCode = 0x809D0000
	StatusBadDataUnavailable        StatusCode = 0x809E0000
)

// Compatibility aliases with the spelling used by several OPC UA stacks.
const (
	Good                      = StatusGood
	Bad                       = StatusBad
	BadCommunicationError     = StatusBadCommunicationError
	BadTimeout                = StatusBadTimeout
	BadSessionIDInvalid       = StatusBadSessionIDInvalid
	BadSessionIdInvalid       = StatusBadSessionIDInvalid
	BadSessionClosed          = StatusBadSessionClosed
	BadSubscriptionIDInvalid  = StatusBadSubscriptionIDInvalid
	BadSubscriptionIdInvalid  = StatusBadSubscriptionIDInvalid
	BadSecureChannelIDInvalid = StatusBadSecureChannelIDInvalid
	BadSecureChannelIdInvalid = StatusBadSecureChannelIDInvalid
	BadTooManyPublishRequests = StatusBadTooManyPublishRequests
	BadNoSubscription         = StatusBadNoSubscription
	BadSequenceNumberUnknown  = StatusBadSequenceNumberUnknown
	BadMessageNotAvailable    = StatusBadMessageNotAvailable
	BadNoData                 = StatusBadNoData
	BadDataLost               = StatusBadDataLost
	BadDataUnavailable        = StatusBadDataUnavailable
)

// Good reports whether the status has good severity. Uncertain and bad
// statuses are not considered good for the purpose of accepting a message.
func (s StatusCode) Good() bool { return s&0x80000000 == 0 && s&0x40000000 == 0 }

// IsGood is an alias for Good.
func (s StatusCode) IsGood() bool { return s.Good() }

// Bad reports whether the status has bad severity.
func (s StatusCode) Bad() bool { return s&0x80000000 != 0 }

// IsBad is an alias for Bad.
func (s StatusCode) IsBad() bool { return s.Bad() }

// ConfirmsUnavailable reports whether the status is a service-level answer
// that the requested notification is no longer available. Transport and
// session failures are deliberately excluded: they do not prove that the
// notification was discarded and must not turn a recoverable gap into a
// permanent one.
func (s StatusCode) ConfirmsUnavailable() bool {
	if !s.Bad() {
		return false
	}
	switch s {
	case StatusBadCommunicationError,
		StatusBadTimeout,
		StatusBadShutdown,
		StatusBadServerNotConnected,
		StatusBadSessionIDInvalid,
		StatusBadSessionClosed,
		StatusBadSubscriptionIDInvalid,
		StatusBadSecureChannelIDInvalid,
		StatusBadTooManyPublishRequests:
		return false
	}
	return true
}

func (s StatusCode) String() string {
	switch s {
	case StatusGood:
		return "Good"
	case StatusBadMessageNotAvailable:
		return "BadMessageNotAvailable"
	case StatusBadNoData:
		return "BadNoData"
	case StatusBadDataLost:
		return "BadDataLost"
	case StatusBadDataUnavailable:
		return "BadDataUnavailable"
	case StatusBadSequenceNumberUnknown:
		return "BadSequenceNumberUnknown"
	case StatusBadSessionIDInvalid:
		return "BadSessionIDInvalid"
	case StatusBadSubscriptionIDInvalid:
		return "BadSubscriptionIDInvalid"
	default:
		return fmt.Sprintf("StatusCode(0x%08X)", uint32(s))
	}
}
