// Package ipfix implements an incremental, ordered-TCP receiver for a small
// subset of IPFIX (version 10).
//
// A Receiver consumes a TCP byte stream incrementally: feed every Read result
// into Append and call EndInput when the connection reaches a real EOF.
// Complete messages are decoded only once all their bytes have arrived; a
// malformed message puts the receiver into a permanent failed state instead of
// scanning for a later frame.
//
// Templates are scoped to the caller-supplied TCP connection identity plus the
// observation domain carried in each message, take effect in set order inside
// a message, and are committed together with sequence numbers and records only
// after the whole message validates.
package ipfix

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Set identifiers reserved by the IPFIX protocol.
const (
	TemplateSetID uint16 = 2
	OptionSetID   uint16 = 3
)

// MinDataTemplateID is the first identifier that may name a data template or
// a data set.
const MinDataTemplateID uint16 = 256

const (
	headerLength       = 16
	setHeaderLength    = 4
	templateHeadLength = 4
	fieldHeadLength    = 4
	enterpriseHead     = 4
	enterpriseFlag     = uint16(1 << 15)
	fieldIDMask        = uint16(1<<15 - 1)
	varLength          = uint16(65535)
	maxPadding         = 3
)

// Default budgets. They bound work performed in response to a single stream or
// message so that hostile length declarations cannot drive allocation.
const (
	DefaultMaxMessageBytes   = 65535
	DefaultMaxTemplateFields = 256
	DefaultMaxTotalTemplates = 4096
	DefaultMaxMessageRecords = 65535
)

// Limits configures receiver resource budgets. The zero value of any field
// selects its corresponding Default budget.
type Limits struct {
	// MaxMessageBytes bounds the Length declared by an IPFIX message and the
	// amount of buffered stream data.
	MaxMessageBytes int
	// MaxTemplateFields bounds the field count of one template record.
	MaxTemplateFields int
	// MaxTotalTemplates bounds the number of installed templates across all
	// observation domains of one connection.
	MaxTotalTemplates int
	// MaxMessageRecords bounds the data records decoded from one message.
	MaxMessageRecords int
}

// FieldSpec describes one information element of a template.
type FieldSpec struct {
	// Enterprise is zero for an IANA information element and nonzero when the
	// enterprise bit was present on the wire.
	Enterprise uint32
	// ID is the 15-bit information element identifier with the enterprise bit
	// removed.
	ID uint16
	// Length is the fixed wire length in 1..65534, or 65535 for variable
	// length.
	Length uint16
}

// Template is the installed, ordered list of field specifications.
type Template struct {
	ID     uint16
	Fields []FieldSpec
}

// Field is one decoded field of a data record. Index is the zero-based field
// position in the template.
type Field struct {
	Index      int
	Enterprise uint32
	ID         uint16
	// Value holds the raw field bytes. Variable-length values omit their
	// one- or three-byte length prefix and may be empty.
	Value []byte
}

// Record is one data set record decoded with the template version current at
// its position in the message.
type Record struct {
	TemplateID uint16
	Fields     []Field
}

// Set is one decoded set inside a message. Template sets do not appear here;
// their effects are exposed through receiver state after commit.
type Set struct {
	ID      uint16
	Records []Record
}

// Message is one fully validated IPFIX message.
type Message struct {
	Version           uint16
	ExportTime        uint32
	Sequence          uint32
	ObservationDomain uint32
	Sets              []Set
}

// ConnIdentity identifies one ordered TCP connection to the host. Reconnecting
// peers must supply a distinct identity so that templates never leak across
// connections. The value is compared by value, so it must not contain slices,
// maps, or other uncomparable fields.
type ConnIdentity struct {
	LocalAddr  string
	RemoteAddr string
	VLAN       uint16
	IngressID  uint32
}

// domainState is the committed state for one observation domain.
type domainState struct {
	templates map[uint16]*Template
	seen      bool
	lastSeq   uint32
	lastCount uint32
}

// Receiver incrementally parses one TCP connection.
type Receiver struct {
	identity ConnIdentity
	limits   Limits

	buf           []byte
	domains       map[uint32]*domainState
	templateCount int
	failed        bool
}

// NewReceiver creates a receiver for one TCP connection. A rebuilt connection
// needs a new receiver (or at minimum a new identity); templates are never
// inherited from a prior identity.
func NewReceiver(identity ConnIdentity, limits Limits) *Receiver {
	if limits.MaxMessageBytes <= 0 {
		limits.MaxMessageBytes = DefaultMaxMessageBytes
	}
	if limits.MaxTemplateFields <= 0 {
		limits.MaxTemplateFields = DefaultMaxTemplateFields
	}
	if limits.MaxTotalTemplates <= 0 {
		limits.MaxTotalTemplates = DefaultMaxTotalTemplates
	}
	if limits.MaxMessageRecords <= 0 {
		limits.MaxMessageRecords = DefaultMaxMessageRecords
	}
	return &Receiver{
		identity: identity,
		limits:   limits,
		domains:  make(map[uint32]*domainState),
	}
}

// Identity returns the connection identity bound to this receiver.
func (r *Receiver) Identity() ConnIdentity { return r.identity }

// Failed reports whether the receiver has entered its terminal failure state.
func (r *Receiver) Failed() bool { return r.failed }

// TemplateCount returns the number of currently installed templates across
// every observation domain of this connection.
func (r *Receiver) TemplateCount() int { return r.templateCount }

// Template returns the committed template for a domain, or nil when absent.
func (r *Receiver) Template(domain uint32, templateID uint16) *Template {
	state := r.domains[domain]
	if state == nil {
		return nil
	}
	return state.templates[templateID]
}

// ErrReceiverFailed is returned after a receiver has entered terminal failure.
var ErrReceiverFailed = errors.New("ipfix: receiver has failed")

// Append consumes bytes read from the ordered TCP stream. Every complete
// message contained in chunk is decoded before return; messages already
// committed remain available when a later message fails. After any error the
// receiver is failed forever and subsequent calls return the same terminal
// error without inspecting new input.
func (r *Receiver) Append(chunk []byte) ([]Message, error) {
	if r.failed {
		return nil, ErrReceiverFailed
	}

	// Reject a stream that would exceed the message-size budget before growing
	// the buffer, even while the length field itself has not fully arrived.
	if len(chunk) > r.limits.MaxMessageBytes || len(r.buf)+len(chunk) > r.limits.MaxMessageBytes {
		return nil, r.fail(fmt.Errorf("ipfix: input exceeds message budget of %d bytes", r.limits.MaxMessageBytes))
	}
	r.buf = append(r.buf, chunk...)

	var messages []Message
	for len(r.buf) >= headerLength {
		declared := int(binary.BigEndian.Uint16(r.buf[2:4]))
		if declared < headerLength {
			return messages, r.fail(fmt.Errorf("ipfix: message length %d is shorter than header", declared))
		}
		if declared > r.limits.MaxMessageBytes {
			return messages, r.fail(fmt.Errorf("ipfix: message length %d exceeds budget %d", declared, r.limits.MaxMessageBytes))
		}
		if len(r.buf) < declared {
			// Wait for the rest of this message. Nothing is committed yet.
			return messages, nil
		}

		parsed, err := r.parseMessage(r.buf[:declared])
		if err != nil {
			return messages, r.fail(err)
		}
		r.commit(parsed)
		messages = append(messages, parsed.public())

		remaining := r.buf[declared:]
		if len(remaining) == 0 {
			// Drop the backing array so the next chunk cannot overwrite a
			// frame that has already been parsed or retained.
			r.buf = nil
		} else {
			r.buf = append(make([]byte, 0, len(remaining)), remaining...)
		}
	}
	return messages, nil
}

// EndInput marks the real EOF of the stream. A non-empty residual means the
// final frame was truncated: already committed messages stay published and the
// receiver enters its failed state.
func (r *Receiver) EndInput() error {
	if r.failed {
		return ErrReceiverFailed
	}
	if len(r.buf) > 0 {
		return r.fail(fmt.Errorf("ipfix: truncated stream with %d residual byte(s)", len(r.buf)))
	}
	return nil
}

func (r *Receiver) fail(err error) error {
	r.failed = true
	return err
}

// parsedMessage carries commit-internal state alongside the public message.
type parsedMessage struct {
	Message
	domain          uint32
	dataRecordCount uint32
	workTemplates   map[uint16]*Template
	workCount       int
	committedCount  int
	domainSeen      bool
	lastSeq         uint32
	lastCount       uint32
}

func (r *Receiver) parseMessage(frame []byte) (*parsedMessage, error) {
	version := binary.BigEndian.Uint16(frame[0:2])
	if version != 10 {
		return nil, fmt.Errorf("ipfix: unsupported version %d", version)
	}
	length := int(binary.BigEndian.Uint16(frame[2:4]))
	if length < headerLength || length != len(frame) {
		return nil, fmt.Errorf("ipfix: invalid message length %d for %d available byte(s)", length, len(frame))
	}

	out := &parsedMessage{
		Message: Message{
			Version:           version,
			ExportTime:        binary.BigEndian.Uint32(frame[4:8]),
			Sequence:          binary.BigEndian.Uint32(frame[8:12]),
			ObservationDomain: binary.BigEndian.Uint32(frame[12:16]),
		},
		domain: binary.BigEndian.Uint32(frame[12:16]),
	}

	if state := r.domains[out.domain]; state != nil {
		out.domainSeen = state.seen
		out.lastSeq = state.lastSeq
		out.lastCount = state.lastCount
		out.workTemplates = cloneTemplates(state.templates)
		out.workCount = len(state.templates)
		out.committedCount = len(state.templates)
	} else {
		out.workTemplates = make(map[uint16]*Template)
	}

	body := frame[headerLength:]
	for len(body) > 0 {
		if len(body) < setHeaderLength {
			if len(body) <= maxPadding && allZero(body) {
				break
			}
			return nil, fmt.Errorf("ipfix: %d trailing byte(s) cannot form a set header", len(body))
		}

		setID := binary.BigEndian.Uint16(body[0:2])
		setLen := int(binary.BigEndian.Uint16(body[2:4]))
		if setLen < setHeaderLength {
			return nil, fmt.Errorf("ipfix: set %d length %d is shorter than header", setID, setLen)
		}
		if setLen > len(body) {
			return nil, fmt.Errorf("ipfix: set %d length %d crosses message boundary (%d byte(s) remain)", setID, setLen, len(body))
		}

		payload := body[setHeaderLength:setLen]
		switch {
		case setID == TemplateSetID:
			if err := r.parseTemplateSet(payload, out); err != nil {
				return nil, err
			}
		case setID >= MinDataTemplateID:
			if err := r.parseDataSet(setID, payload, out); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("ipfix: unsupported set id %d", setID)
		}
		body = body[setLen:]
	}

	if out.domainSeen {
		want := out.lastSeq + out.lastCount
		if out.Sequence != want {
			return nil, fmt.Errorf("ipfix: sequence %d does not match expected %d", out.Sequence, want)
		}
	}
	return out, nil
}

func (r *Receiver) parseTemplateSet(payload []byte, out *parsedMessage) error {
	for len(payload) > 0 {
		if len(payload) < templateHeadLength {
			if len(payload) <= maxPadding && allZero(payload) {
				return nil
			}
			return fmt.Errorf("ipfix: template set has %d unparseable trailing byte(s)", len(payload))
		}

		templateID := binary.BigEndian.Uint16(payload[0:2])
		fieldCount := int(binary.BigEndian.Uint16(payload[2:4]))
		payload = payload[templateHeadLength:]

		if fieldCount == 0 {
			switch templateID {
			case TemplateSetID:
				out.workTemplates = make(map[uint16]*Template)
				out.workCount = 0
			default:
				if templateID < MinDataTemplateID {
					return fmt.Errorf("ipfix: template id %d is below minimum %d", templateID, MinDataTemplateID)
				}
				if _, ok := out.workTemplates[templateID]; ok {
					delete(out.workTemplates, templateID)
					out.workCount--
				}
			}
			continue
		}

		if templateID < MinDataTemplateID {
			return fmt.Errorf("ipfix: template id %d is below minimum %d", templateID, MinDataTemplateID)
		}
		if fieldCount > r.limits.MaxTemplateFields {
			return fmt.Errorf("ipfix: template %d field count %d exceeds budget %d", templateID, fieldCount, r.limits.MaxTemplateFields)
		}

		fields := make([]FieldSpec, 0, fieldCount)
		for index := 0; index < fieldCount; index++ {
			if len(payload) < fieldHeadLength {
				return fmt.Errorf("ipfix: truncated field spec %d in template %d", index, templateID)
			}
			rawID := binary.BigEndian.Uint16(payload[0:2])
			fieldLen := binary.BigEndian.Uint16(payload[2:4])
			payload = payload[fieldHeadLength:]

			spec := FieldSpec{
				ID:     rawID & fieldIDMask,
				Length: fieldLen,
			}
			if rawID&enterpriseFlag != 0 {
				if len(payload) < enterpriseHead {
					return fmt.Errorf("ipfix: truncated enterprise number in template %d", templateID)
				}
				spec.Enterprise = binary.BigEndian.Uint32(payload[0:4])
				payload = payload[enterpriseHead:]
			}
			if fieldLen == 0 {
				return fmt.Errorf("ipfix: field %d of template %d has zero length", index, templateID)
			}
			fields = append(fields, spec)
		}

		if _, exists := out.workTemplates[templateID]; !exists {
			projected := r.templateCount - out.committedCount + out.workCount
			if projected >= r.limits.MaxTotalTemplates {
				return fmt.Errorf("ipfix: total template budget %d exhausted", r.limits.MaxTotalTemplates)
			}
			out.workCount++
		}
		out.workTemplates[templateID] = &Template{ID: templateID, Fields: fields}
	}
	return nil
}

func (r *Receiver) parseDataSet(setID uint16, payload []byte, out *parsedMessage) error {
	template := out.workTemplates[setID]
	if template == nil {
		return fmt.Errorf("ipfix: data set %d references unknown template", setID)
	}

	fixedLen := 0
	variableCount := 0
	for _, field := range template.Fields {
		if field.Length == varLength {
			variableCount++
		} else {
			fixedLen += int(field.Length)
		}
	}
	minRecordLen := fixedLen + variableCount

	records := make([]Record, 0)
	for len(payload) > 0 {
		if len(payload) < minRecordLen {
			if len(payload) <= maxPadding && allZero(payload) {
				break
			}
			return fmt.Errorf("ipfix: data set %d has %d unparseable trailing byte(s)", setID, len(payload))
		}

		if len(records) >= r.limits.MaxMessageRecords {
			return fmt.Errorf("ipfix: message record budget %d exhausted", r.limits.MaxMessageRecords)
		}

		record := Record{TemplateID: setID, Fields: make([]Field, 0, len(template.Fields))}
		remaining := payload
		for index, spec := range template.Fields {
			var value []byte
			if spec.Length == varLength {
				consumed, decoded, err := decodeVariable(remaining)
				if err != nil {
					return fmt.Errorf("ipfix: data set %d variable field %d: %w", setID, index, err)
				}
				value = decoded
				remaining = remaining[consumed:]
			} else {
				if len(remaining) < int(spec.Length) {
					return fmt.Errorf("ipfix: data set %d fixed field %d is truncated", setID, index)
				}
				value = append([]byte(nil), remaining[:spec.Length]...)
				remaining = remaining[spec.Length:]
			}
			record.Fields = append(record.Fields, Field{
				Index:      index,
				Enterprise: spec.Enterprise,
				ID:         spec.ID,
				Value:      value,
			})
		}

		consumed := len(payload) - len(remaining)
		payload = payload[consumed:]
		records = append(records, record)
	}

	out.dataRecordCount += uint32(len(records))
	out.Sets = append(out.Sets, Set{ID: setID, Records: records})
	return nil
}

func decodeVariable(data []byte) (int, []byte, error) {
	if len(data) == 0 {
		return 0, nil, errors.New("missing length byte")
	}
	first := data[0]
	if first < 255 {
		n := int(first)
		if len(data) < 1+n {
			return 0, nil, fmt.Errorf("declared %d byte(s) but only %d remain", n, len(data)-1)
		}
		return 1 + n, append([]byte(nil), data[1:1+n]...), nil
	}

	if len(data) < 3 {
		return 0, nil, errors.New("missing uint16 long-form length")
	}
	n := int(binary.BigEndian.Uint16(data[1:3]))
	if len(data) < 3+n {
		return 0, nil, fmt.Errorf("declared %d byte(s) but only %d remain", n, len(data)-3)
	}
	return 3 + n, append([]byte(nil), data[3:3+n]...), nil
}

// commit publishes a fully validated message atomically.
func (r *Receiver) commit(out *parsedMessage) {
	state := r.domains[out.domain]
	if state == nil {
		state = &domainState{}
		r.domains[out.domain] = state
	}
	state.templates = out.workTemplates
	state.seen = true
	state.lastSeq = out.Sequence
	state.lastCount = out.dataRecordCount

	total := 0
	for _, domain := range r.domains {
		total += len(domain.templates)
	}
	r.templateCount = total
}

func (out *parsedMessage) public() Message {
	return out.Message
}

func cloneTemplates(source map[uint16]*Template) map[uint16]*Template {
	clone := make(map[uint16]*Template, len(source))
	for id, template := range source {
		fields := append([]FieldSpec(nil), template.Fields...)
		clone[id] = &Template{ID: template.ID, Fields: fields}
	}
	return clone
}

func allZero(data []byte) bool {
	for _, b := range data {
		if b != 0 {
			return false
		}
	}
	return true
}
