package telemcodec

import "errors"

var (
	// ErrTruncated is returned when the stream does not contain enough bits.
	ErrTruncated = errors.New("telemcodec: truncated stream")
	// ErrOverflow is returned when a value does not fit the declared width
	// or a varint exceeds 64 bits.
	ErrOverflow = errors.New("telemcodec: value overflow")
	// ErrOverlong is returned when a varint uses a non-minimal encoding.
	ErrOverlong = errors.New("telemcodec: overlong varint encoding")
	// ErrInvalid is returned for malformed descriptors or states.
	ErrInvalid = errors.New("telemcodec: invalid argument")
)
