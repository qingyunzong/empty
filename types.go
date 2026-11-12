package dataeng

import (
	"fmt"
	"strconv"
	"strings"
)

// Message is a decoded SNMP version 1 or version 2c response.
//
// A Message is only returned when the complete input has been decoded and
// validated. A failed decode returns a nil Message.
type Message struct {
	Version     int
	Community   []byte
	RequestID   int64
	ErrorStatus int
	ErrorIndex  int
	Bindings    []Binding
}

// Binding is one variable binding in a response.
type Binding struct {
	OID   OID
	Value Value
}

// OID is an OBJECT IDENTIFIER represented as its object identifier arcs.
type OID []int

// String formats an OID using the usual dotted decimal notation.
func (o OID) String() string {
	parts := make([]string, len(o))
	for i, arc := range o {
		parts[i] = strconv.Itoa(arc)
	}
	return strings.Join(parts, ".")
}

// ValueType identifies the type of a decoded binding value.
type ValueType uint8

const (
	ValueInteger ValueType = iota + 1
	ValueOctetString
	ValueNull
	ValueOID
	ValueApplication
)

// Long names for the value kinds, for callers that prefer explicit names.
const (
	TypeInteger     = ValueInteger
	TypeOctetString = ValueOctetString
	TypeNull        = ValueNull
	TypeOID         = ValueOID
	TypeApplication = ValueApplication
)

// Application tags accepted for unsigned integer values.
const (
	ApplicationCounter32 uint8 = 1
	ApplicationGauge32   uint8 = 2
	ApplicationTimeTicks uint8 = 3
)

// String returns the name of the value type.
func (t ValueType) String() string {
	switch t {
	case ValueInteger:
		return "INTEGER"
	case ValueOctetString:
		return "OCTET STRING"
	case ValueNull:
		return "NULL"
	case ValueOID:
		return "OBJECT IDENTIFIER"
	case ValueApplication:
		return "application value"
	default:
		return fmt.Sprintf("ValueType(%d)", uint8(t))
	}
}

// Value is a decoded binding value. Type determines which of the other
// fields is populated:
//
//   - ValueInteger: Integer
//   - ValueOctetString: Octets
//   - ValueNull: no value field
//   - ValueOID: OID
//   - ValueApplication: Tag and Unsigned
type Value struct {
	Type ValueType

	Integer int64
	Octets  []byte
	OID     OID

	// Tag is the application tag (1, 2, or 3) for ValueApplication.
	Tag uint8

	// Unsigned is the value of an application unsigned integer.
	Unsigned uint32
}
