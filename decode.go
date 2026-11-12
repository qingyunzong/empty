package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// ErrMalformed reports an input that is not a valid response message.
var ErrMalformed = errors.New("dataeng: malformed message")

// ErrMessageTooLarge reports a declared content length larger than the
// host-provided maximum message size.
var ErrMessageTooLarge = errors.New("dataeng: message exceeds host limit")

const (
	classUniversal   = 0
	classApplication = 1
	classContext     = 2

	tagInteger           = 2
	tagOctetString       = 4
	tagNull              = 5
	tagObjectIdentifier  = 6
	tagSequence          = 16
	tagResponsePDU       = 2
	maxLengthOctets      = 4
	maxIntegerOctets     = 8
	applicationTagLast   = 3
	applicationOctetsMax = 5
)

// Decode decodes one complete SNMP version 1 or version 2c response message.
//
// maxMessage is the host's maximum accepted content length for any TLV in the
// message. Declared lengths larger than maxMessage are rejected before their
// contents are examined, and no buffer is allocated from a declared length.
// A negative maxMessage is invalid; zero permits only zero-length content.
//
// Decode returns nil on every error. It never returns a partially decoded
// message.
func Decode(data []byte, maxMessage int) (*Message, error) {
	if maxMessage < 0 {
		return nil, malformed("negative max message size %d", maxMessage)
	}

	r := newReader(data, maxMessage)
	root, err := r.readTLV()
	if err != nil {
		return nil, err
	}
	if !root.is(classUniversal, true, tagSequence) {
		return nil, malformed("message is not a constructed SEQUENCE")
	}
	if r.len() != 0 {
		return nil, malformed("%d bytes remain after message", r.len())
	}

	body := newReader(root.content, maxMessage)

	versionTLV, err := body.readExpected(classUniversal, false, tagInteger, "version")
	if err != nil {
		return nil, err
	}
	version, err := decodeSignedInteger(versionTLV.content)
	if err != nil {
		return nil, prefix("version INTEGER", err)
	}
	if version != 0 && version != 1 {
		return nil, malformed("unsupported version %d", version)
	}

	communityTLV, err := body.readExpected(classUniversal, false, tagOctetString, "community")
	if err != nil {
		return nil, err
	}

	responseTLV, err := body.readExpected(classContext, true, tagResponsePDU, "response")
	if err != nil {
		return nil, err
	}
	if err := body.requireEmpty("message"); err != nil {
		return nil, err
	}

	response := newReader(responseTLV.content, maxMessage)

	requestIDTLV, err := response.readExpected(classUniversal, false, tagInteger, "request ID")
	if err != nil {
		return nil, err
	}
	requestID, err := decodeSignedInteger(requestIDTLV.content)
	if err != nil {
		return nil, prefix("request ID INTEGER", err)
	}

	statusTLV, err := response.readExpected(classUniversal, false, tagInteger, "error status")
	if err != nil {
		return nil, err
	}
	status, err := decodeSignedInteger(statusTLV.content)
	if err != nil {
		return nil, prefix("error status INTEGER", err)
	}
	if status < 0 || status > 5 {
		return nil, malformed("error status %d is outside 0..5", status)
	}

	indexTLV, err := response.readExpected(classUniversal, false, tagInteger, "error index")
	if err != nil {
		return nil, err
	}
	index, err := decodeSignedInteger(indexTLV.content)
	if err != nil {
		return nil, prefix("error index INTEGER", err)
	}
	if index < 0 {
		return nil, malformed("negative error index %d", index)
	}
	if status == 0 && index != 0 {
		return nil, malformed("error index %d is not zero for error status 0", index)
	}

	bindingsTLV, err := response.readExpected(classUniversal, true, tagSequence, "bindings")
	if err != nil {
		return nil, err
	}
	if err := response.requireEmpty("response"); err != nil {
		return nil, err
	}

	bindings, err := decodeBindings(bindingsTLV.content, maxMessage)
	if err != nil {
		return nil, err
	}

	return &Message{
		Version:     int(version),
		Community:   cloneBytes(communityTLV.content),
		RequestID:   requestID,
		ErrorStatus: int(status),
		ErrorIndex:  int(index),
		Bindings:    bindings,
	}, nil
}

// DecodeMessage is an alias for Decode.
func DecodeMessage(data []byte, maxMessage int) (*Message, error) {
	return Decode(data, maxMessage)
}

type tlv struct {
	class       uint8
	constructed bool
	tag         uint64
	content     []byte
}

func (t tlv) is(class uint8, constructed bool, tag uint64) bool {
	return t.class == class && t.constructed == constructed && t.tag == tag
}

type reader struct {
	data       []byte
	off        int
	maxMessage int
}

func newReader(data []byte, maxMessage int) *reader {
	return &reader{data: data, maxMessage: maxMessage}
}

func (r *reader) len() int {
	return len(r.data) - r.off
}

func (r *reader) readExpected(class uint8, constructed bool, tag uint64, what string) (tlv, error) {
	t, err := r.readTLV()
	if err != nil {
		return tlv{}, prefix(what, err)
	}
	if !t.is(class, constructed, tag) {
		return tlv{}, malformed(
			"%s has identifier class %d, constructed=%t, tag %d; expected class %d, constructed=%t, tag %d",
			what, t.class, t.constructed, t.tag, class, constructed, tag,
		)
	}
	return t, nil
}

func (r *reader) requireEmpty(what string) error {
	if r.len() != 0 {
		return malformed("%d bytes remain after %s", r.len(), what)
	}
	return nil
}

// readTLV reads exactly one identifier/length/value. It validates the tag and
// length encodings and checks the declared content length against both the
// host limit and the bytes actually available before creating a content slice.
func (r *reader) readTLV() (tlv, error) {
	if r.len() == 0 {
		return tlv{}, malformed("truncated identifier")
	}

	id := r.data[r.off]
	r.off++

	t := tlv{
		class:       id >> 6,
		constructed: id&0x20 != 0,
		tag:         uint64(id & 0x1f),
	}

	if t.tag == 0x1f {
		tag, err := r.readLongTag()
		if err != nil {
			return tlv{}, err
		}
		t.tag = tag
	}

	contentLen, err := r.readLength()
	if err != nil {
		return tlv{}, err
	}

	remaining := uint64(r.len())
	if contentLen > remaining {
		return tlv{}, malformed(
			"declared content length %d exceeds %d remaining bytes", contentLen, remaining,
		)
	}

	start := r.off
	r.off += int(contentLen)
	t.content = r.data[start:r.off]
	return t, nil
}

// readLongTag parses the base-128 tag number used when the low five identifier
// bits are all ones. At least one following octet is required. The first
// seven-bit group may not be zero, and the resulting tag must not fit in the
// short form.
func (r *reader) readLongTag() (uint64, error) {
	if r.len() == 0 {
		return 0, malformed("truncated long-form tag")
	}

	var tag uint64
	groups := 0
	for {
		if r.len() == 0 {
			return 0, malformed("truncated long-form tag")
		}

		b := r.data[r.off]
		r.off++
		group := uint64(b & 0x7f)

		if groups == 0 {
			if group == 0 {
				return 0, malformed("long-form tag has a leading zero group")
			}
			tag = group
		} else {
			if tag > math.MaxUint64>>7 {
				return 0, malformed("long-form tag overflows")
			}
			tag = tag<<7 | group
		}
		groups++

		if b&0x80 == 0 {
			break
		}
	}

	if tag < 0x1f {
		return 0, malformed("long-form tag %d must use the short form", tag)
	}
	return tag, nil
}

// readLength parses a single length octet or the restricted long form. Only
// 0x81 through 0x84 may introduce long form. The encoded value must exceed
// 127, must not have a leading zero octet, and must not exceed maxMessage.
func (r *reader) readLength() (uint64, error) {
	if r.len() == 0 {
		return 0, malformed("truncated length")
	}

	first := r.data[r.off]
	r.off++

	if first < 0x80 {
		length := uint64(first)
		if length > uint64(r.maxMessage) {
			return 0, tooLarge(length, r.maxMessage)
		}
		return length, nil
	}
	if first == 0x80 {
		return 0, malformed("indefinite length 0x80 is not allowed")
	}
	if first > 0x80+maxLengthOctets {
		return 0, malformed(
			"length first octet 0x%02x is not in 0x81..0x84", first,
		)
	}

	n := int(first & 0x7f)
	if r.len() < n {
		return 0, malformed("truncated long-form length")
	}

	raw := r.data[r.off : r.off+n]
	r.off += n

	if raw[0] == 0 {
		return 0, malformed("long-form length has a leading zero octet")
	}

	var length uint64
	for _, b := range raw {
		length = length<<8 | uint64(b)
	}
	if length <= 127 {
		return 0, malformed("long-form length %d must use the short form", length)
	}
	if length > uint64(r.maxMessage) {
		return 0, tooLarge(length, r.maxMessage)
	}
	return length, nil
}

func decodeBindings(content []byte, maxMessage int) ([]Binding, error) {
	r := newReader(content, maxMessage)
	var bindings []Binding

	for r.len() > 0 {
		bindingTLV, err := r.readExpected(classUniversal, true, tagSequence, "binding")
		if err != nil {
			return nil, err
		}

		binding, err := decodeBinding(bindingTLV.content, maxMessage)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}

	return bindings, nil
}

func decodeBinding(content []byte, maxMessage int) (Binding, error) {
	r := newReader(content, maxMessage)

	oidTLV, err := r.readExpected(classUniversal, false, tagObjectIdentifier, "binding OID")
	if err != nil {
		return Binding{}, err
	}
	oid, err := decodeOID(oidTLV.content)
	if err != nil {
		return Binding{}, prefix("binding OID", err)
	}

	valueTLV, err := r.readTLV()
	if err != nil {
		return Binding{}, prefix("binding value", err)
	}
	value, err := decodeValue(valueTLV)
	if err != nil {
		return Binding{}, prefix("binding value", err)
	}

	if err := r.requireEmpty("binding"); err != nil {
		return Binding{}, err
	}
	return Binding{OID: oid, Value: value}, nil
}

func decodeValue(t tlv) (Value, error) {
	if t.class == classUniversal && !t.constructed {
		switch t.tag {
		case tagInteger:
			v, err := decodeSignedInteger(t.content)
			if err != nil {
				return Value{}, err
			}
			return Value{Type: ValueInteger, Integer: v}, nil
		case tagOctetString:
			return Value{Type: ValueOctetString, Octets: cloneBytes(t.content)}, nil
		case tagNull:
			if len(t.content) != 0 {
				return Value{}, malformed("NULL has %d content bytes", len(t.content))
			}
			return Value{Type: ValueNull}, nil
		case tagObjectIdentifier:
			oid, err := decodeOID(t.content)
			if err != nil {
				return Value{}, err
			}
			return Value{Type: ValueOID, OID: oid}, nil
		}
	}

	if t.class == classApplication && !t.constructed &&
		t.tag >= 1 && t.tag <= applicationTagLast {
		unsigned, err := decodeApplicationUnsigned(t.content)
		if err != nil {
			return Value{}, err
		}
		return Value{
			Type:     ValueApplication,
			Tag:      uint8(t.tag),
			Unsigned: unsigned,
		}, nil
	}

	return Value{}, malformed(
		"unsupported value class %d, constructed=%t, tag %d",
		t.class, t.constructed, t.tag,
	)
}

// decodeSignedInteger validates the minimal two's-complement encoding and
// returns its value. A host message can carry at most an eight-octet INTEGER.
func decodeSignedInteger(content []byte) (int64, error) {
	if len(content) == 0 {
		return 0, malformed("INTEGER has empty content")
	}
	if len(content) > maxIntegerOctets {
		return 0, malformed("INTEGER has %d octets; maximum is %d", len(content), maxIntegerOctets)
	}
	if len(content) > 1 {
		if content[0] == 0x00 && content[1]&0x80 == 0 {
			return 0, malformed("INTEGER has a redundant leading 0x00")
		}
		if content[0] == 0xff && content[1]&0x80 != 0 {
			return 0, malformed("INTEGER has a redundant leading 0xff")
		}
	}

	var value int64
	if content[0]&0x80 != 0 {
		value = -1
	}
	for _, b := range content {
		value = value<<8 | int64(b)
	}
	return value, nil
}

// decodeApplicationUnsigned decodes application tags 1..3 as a minimal,
// unsigned, big-endian integer. The host range is 0..4294967295.
func decodeApplicationUnsigned(content []byte) (uint32, error) {
	if len(content) < 1 || len(content) > applicationOctetsMax {
		return 0, malformed(
			"application integer has %d octets; expected 1..%d",
			len(content), applicationOctetsMax,
		)
	}
	if len(content) > 1 && content[0] == 0 {
		return 0, malformed("application integer has a leading zero octet")
	}

	var value uint64
	for _, b := range content {
		value = value<<8 | uint64(b)
	}
	if value > math.MaxUint32 {
		return 0, malformed("application integer %d exceeds 4294967295", value)
	}
	return uint32(value), nil
}

// decodeOID decodes the two arcs packed into the first octet and each following
// base-128 arc. The packed first octet may only encode first arc 0, 1, or 2;
// arcs 0 and 1 therefore have a second arc below 40. Every following arc must
// be minimal and terminated.
func decodeOID(content []byte) (OID, error) {
	if len(content) == 0 {
		return nil, malformed("OBJECT IDENTIFIER has empty content")
	}

	var first, second int
	switch b := content[0]; {
	case b < 40:
		first, second = 0, int(b)
	case b < 80:
		first, second = 1, int(b)-40
	default:
		first, second = 2, int(b)-80
	}

	oid := make(OID, 0, len(content)+1)
	oid = append(oid, first, second)

	for i := 1; i < len(content); {
		b := content[i]
		if b&0x80 == 0 {
			oid = append(oid, int(b))
			i++
			continue
		}
		if b&0x7f == 0 {
			return nil, malformed("OBJECT IDENTIFIER arc has a leading zero group")
		}

		var value uint64
		for {
			if i >= len(content) {
				return nil, malformed("truncated OBJECT IDENTIFIER arc")
			}
			b = content[i]
			i++
			if value > math.MaxUint64>>7 {
				return nil, malformed("OBJECT IDENTIFIER arc overflows")
			}
			value = value<<7 | uint64(b&0x7f)
			if b&0x80 == 0 {
				break
			}
		}
		if value > uint64(math.MaxInt) {
			return nil, malformed("OBJECT IDENTIFIER arc %d exceeds host range", value)
		}
		oid = append(oid, int(value))
	}

	return oid, nil
}

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

func malformed(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrMalformed, fmt.Sprintf(format, args...))
}

func tooLarge(length uint64, max int) error {
	return fmt.Errorf(
		"%w: declared content length %d exceeds maximum %d",
		ErrMessageTooLarge, length, max,
	)
}

func prefix(what string, err error) error {
	return fmt.Errorf("%s: %w", what, err)
}
