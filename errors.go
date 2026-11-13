package dataeng

import "errors"

var (
	// ErrInvalidSentence is returned when a fragment cannot be accepted.
	ErrInvalidSentence = errors.New("dataeng: invalid sentence")
	// ErrInconsistentTotal is returned when a message's fragments disagree
	// about the total number of sentences.
	ErrInconsistentTotal = errors.New("dataeng: inconsistent total sentence count")
	// ErrDuplicateNumber is returned when a sentence number is supplied
	// more than once for the same message.
	ErrDuplicateNumber = errors.New("dataeng: duplicate sentence number")
	// ErrFillBitsNotLast is returned when a non-final sentence carries fill bits.
	ErrFillBitsNotLast = errors.New("dataeng: fill bits are only allowed on the last sentence")
	// ErrFillExceedsPayload is returned when a sentence declares more fill
	// bits than its payload contains.
	ErrFillExceedsPayload = errors.New("dataeng: fill bits exceed payload bits")
	// ErrNonBitPayload is returned when a payload byte is not 0 or 1.
	ErrNonBitPayload = errors.New("dataeng: payload contains a non-bit value")
	// ErrBitCountNotMultipleOfSix is returned when the reassembled payload
	// does not have a bit count divisible by six after fill removal.
	ErrBitCountNotMultipleOfSix = errors.New("dataeng: bit count after fill removal is not a multiple of 6")
	// ErrMessageFailed is returned for fragments belonging to a message that
	// has already failed.
	ErrMessageFailed = errors.New("dataeng: message already failed")
	// ErrMessageExpired is returned when an incomplete message reaches its
	// caller-supplied deadline.
	ErrMessageExpired = errors.New("dataeng: message expired")

	// ErrChecksum is returned by ParseNMEA when the NMEA checksum is wrong.
	ErrChecksum = errors.New("dataeng: NMEA checksum mismatch")
	// ErrMalformedNMEA is returned when an NMEA sentence cannot be parsed.
	ErrMalformedNMEA = errors.New("dataeng: malformed NMEA sentence")
)
