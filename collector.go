// Package dataeng parses metric collection groups made of typed binary parts.
//
// The component never touches the network: callers feed raw bytes through
// Push and receive fully assembled records via a callback. Push may deliver a
// stream of arbitrary chunks, including pieces split in the middle of a part.
// Once the component fails it stays stopped; records already delivered remain
// with the caller.
package dataeng

import (
	"encoding/binary"
	"errors"
	"math"
	"time"
	"unicode/utf8"
)

// Part type tags carried in the first big-endian uint16 of every part.
const (
	partHost           uint16 = 0
	partTime           uint16 = 1
	partPlugin         uint16 = 2
	partPluginInstance uint16 = 3
	partTypeName       uint16 = 4
	partTypeInstance   uint16 = 5
	partValues         uint16 = 6
	partInterval       uint16 = 7
)

// ValueKind identifies how a single metric value is encoded.
type ValueKind uint8

const (
	// KindCounter is a big-endian uint64 monotonically increasing counter.
	KindCounter ValueKind = 0
	// KindGauge is a little-endian binary64 (IEEE 754 double) finite float.
	KindGauge ValueKind = 1
	// KindDerive is a big-endian int64 rate of change.
	KindDerive ValueKind = 2
	// KindAbsolute is a big-endian uint64 absolute value.
	KindAbsolute ValueKind = 3
)

// Value is one metric measurement inside a values part.
type Value struct {
	Kind  ValueKind
	U64   uint64
	I64   int64
	Float float64
}

// Record is one assembled metric delivered when a values part is accepted.
// PluginInstance and TypeInstance are empty when the context never named one.
// Interval is nil when the context never named one.
type Record struct {
	Host           string
	Time           time.Time
	Plugin         string
	PluginInstance string
	TypeName       string
	TypeInstance   string
	Interval       *time.Duration
	Values         []Value
}

// Collector assembles parts from one or more groups into records.
//
// A Collector is not safe for concurrent use. It allocates at most maxPart
// bytes for a single part: an overlong part is rejected as soon as its length
// header is readable, before the declared length is used for any allocation.
type Collector struct {
	maxPart int
	deliver func(Record) error

	buf       []byte
	failed    bool
	stopped   bool
	err       error
	delivered []Record

	host           string
	haveHost       bool
	when           time.Time
	haveTime       bool
	plugin         string
	havePlugin     bool
	pluginInstance string
	typeName       string
	haveTypeName   bool
	typeInstance   string
	interval       *time.Duration
}

// NewCollector builds a component that rejects any part whose declared length
// exceeds maxPart and hands each accepted record to deliver. A nil deliver
// callback discards records.
func NewCollector(maxPart int, deliver func(Record) error) *Collector {
	return &Collector{
		maxPart: maxPart,
		deliver: deliver,
	}
}

// Push consumes raw bytes, retaining any partial part for the next Push. It
// processes every complete part available and returns the first error. After
// an error, or after Finish, the component is stopped permanently.
func (c *Collector) Push(p []byte) error {
	if c.failed || c.stopped {
		return c.err
	}
	c.buf = append(c.buf, p...)
	for len(c.buf) >= 4 {
		partLen := int(binary.BigEndian.Uint16(c.buf[2:4]))
		if partLen < 4 {
			return c.fail(errPartTooShort)
		}
		if partLen > c.maxPart {
			return c.fail(errPartTooLong)
		}
		if len(c.buf) < partLen {
			break
		}
		partType := binary.BigEndian.Uint16(c.buf[0:2])
		body := c.buf[4:partLen]
		if err := c.handle(partType, body); err != nil {
			return c.fail(err)
		}
		c.buf = c.buf[partLen:]
	}
	return nil
}

// Finish reports whether every pushed byte formed a complete part. A part left
// unfinished, like every other failure, stops the component.
func (c *Collector) Finish() error {
	if c.failed || c.stopped {
		return c.err
	}
	c.stopped = true
	if len(c.buf) != 0 {
		c.failed = true
		c.err = errUnfinishedPart
		return c.err
	}
	return nil
}

// Err returns the failure that stopped the component, or nil while it is alive.
func (c *Collector) Err() error {
	return c.err
}

// Delivered returns the records accepted so far. The slice is retained even
// after the component fails.
func (c *Collector) Delivered() []Record {
	return c.delivered
}

func (c *Collector) handle(partType uint16, body []byte) error {
	switch partType {
	case partHost:
		name, err := decodeString(body)
		if err != nil {
			return err
		}
		c.host = name
		c.haveHost = true
	case partPlugin:
		name, err := decodeString(body)
		if err != nil {
			return err
		}
		if !c.havePlugin || c.plugin != name {
			c.pluginInstance = ""
		}
		c.plugin = name
		c.havePlugin = true
	case partPluginInstance:
		name, err := decodeString(body)
		if err != nil {
			return err
		}
		c.pluginInstance = name
	case partTypeName:
		name, err := decodeString(body)
		if err != nil {
			return err
		}
		if !c.haveTypeName || c.typeName != name {
			c.typeInstance = ""
		}
		c.typeName = name
		c.haveTypeName = true
	case partTypeInstance:
		name, err := decodeString(body)
		if err != nil {
			return err
		}
		c.typeInstance = name
	case partTime:
		if len(body) != 8 {
			return errBadTimeLength
		}
		c.when = time.Unix(int64(binary.BigEndian.Uint64(body)), 0).UTC()
		c.haveTime = true
	case partInterval:
		if len(body) != 8 {
			return errBadIntervalLength
		}
		interval := time.Duration(binary.BigEndian.Uint64(body)) * time.Second
		c.interval = &interval
	case partValues:
		return c.handleValues(body)
	default:
		return errUnknownPart
	}
	return nil
}

func decodeString(body []byte) (string, error) {
	if len(body) == 0 || body[len(body)-1] != 0x00 {
		return "", errStringTerminator
	}
	content := body[:len(body)-1]
	for _, b := range content {
		if b == 0x00 {
			return "", errStringNUL
		}
	}
	if !utf8.Valid(content) {
		return "", errStringUTF8
	}
	return string(content), nil
}

func (c *Collector) handleValues(body []byte) error {
	if len(body) < 2 {
		return errBadValuesLength
	}
	count := int(binary.BigEndian.Uint16(body[:2]))
	if count < 1 {
		return errEmptyValues
	}
	if len(body) != 2+count*9 {
		return errBadValuesLength
	}

	values := make([]Value, count)
	offset := 2
	for index := range values {
		kind := ValueKind(body[offset])
		raw := body[offset+1 : offset+9]
		offset += 9

		value := Value{Kind: kind}
		switch kind {
		case KindCounter:
			value.U64 = binary.BigEndian.Uint64(raw)
		case KindGauge:
			number := math.Float64frombits(binary.LittleEndian.Uint64(raw))
			if math.IsInf(number, 0) || math.IsNaN(number) {
				return errNonFiniteGauge
			}
			value.Float = number
		case KindDerive:
			value.I64 = int64(binary.BigEndian.Uint64(raw))
		case KindAbsolute:
			value.U64 = binary.BigEndian.Uint64(raw)
		default:
			return errUnknownKind
		}
		values[index] = value
	}

	if !c.haveHost || !c.haveTime || !c.havePlugin || !c.haveTypeName {
		return errMissingContext
	}

	record := Record{
		Host:           c.host,
		Time:           c.when,
		Plugin:         c.plugin,
		PluginInstance: c.pluginInstance,
		TypeName:       c.typeName,
		TypeInstance:   c.typeInstance,
		Values:         values,
	}
	if c.interval != nil {
		interval := *c.interval
		record.Interval = &interval
	}
	if c.deliver != nil {
		if err := c.deliver(record); err != nil {
			return err
		}
	}
	c.delivered = append(c.delivered, record)
	return nil
}

func (c *Collector) fail(err error) error {
	c.failed = true
	c.err = err
	return err
}

var (
	errPartTooShort      = errors.New("part length must include the 4-byte header and be at least 4")
	errPartTooLong       = errors.New("part length exceeds collector maxPart")
	errUnknownPart       = errors.New("unknown part type")
	errStringTerminator  = errors.New("string part must end with a 0x00 byte")
	errStringNUL         = errors.New("string content must not contain 0x00")
	errStringUTF8        = errors.New("string content must be strict UTF-8")
	errBadTimeLength     = errors.New("time part length must be 12")
	errBadIntervalLength = errors.New("interval part length must be 12")
	errBadValuesLength   = errors.New("values part length must equal 6 plus 9 times the value count")
	errEmptyValues       = errors.New("values part must contain at least one value")
	errUnknownKind       = errors.New("unknown metric value kind")
	errNonFiniteGauge    = errors.New("gauge value must be finite")
	errMissingContext    = errors.New("values part requires host, time, plugin and type name")
	errUnfinishedPart    = errors.New("Finish called with an unfinished part buffered")
)
