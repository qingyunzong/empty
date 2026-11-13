package dataeng

import "strings"

// ValueType describes the SNMP type of a VarBind value. It is intentionally
// small; callers that need the full ASN.1 tag space can keep their own type
// alongside VarBind.Value.
type ValueType uint8

const (
	TypeUnknown ValueType = iota
	TypeInteger
	TypeOctetString
	TypeNull
	TypeObjectIdentifier
	TypeIPAddress
	TypeCounter32
	TypeGauge32
	TypeTimeTicks
	TypeOpaque
	TypeCounter64
	TypeNoSuchObject
	TypeNoSuchInstance
	TypeEndOfMibView
)

func (t ValueType) String() string {
	switch t {
	case TypeInteger:
		return "integer"
	case TypeOctetString:
		return "octetString"
	case TypeNull:
		return "null"
	case TypeObjectIdentifier:
		return "objectIdentifier"
	case TypeIPAddress:
		return "ipAddress"
	case TypeCounter32:
		return "counter32"
	case TypeGauge32:
		return "gauge32"
	case TypeTimeTicks:
		return "timeTicks"
	case TypeOpaque:
		return "opaque"
	case TypeCounter64:
		return "counter64"
	case TypeNoSuchObject:
		return "noSuchObject"
	case TypeNoSuchInstance:
		return "noSuchInstance"
	case TypeEndOfMibView:
		return "endOfMibView"
	default:
		return "unknown"
	}
}

// SpecialValue represents an SNMP exception value in VarBind.Value.
type SpecialValue string

const (
	// EndOfMibView marks the end of the MIB view for a column.
	EndOfMibView SpecialValue = "endOfMibView"
	// NoSuchObject marks an object that does not exist.
	NoSuchObject SpecialValue = "noSuchObject"
	// NoSuchInstance marks an instance that does not exist.
	NoSuchInstance SpecialValue = "noSuchInstance"
)

// VarBind is one SNMP variable binding returned by a GetBulk request.
type VarBind struct {
	OID   OID
	Type  ValueType
	Value any
}

// IsEndOfMibView reports whether the binding signals the end of its column.
// Both the typed and value-based representations used by common SNMP stacks
// are recognised.
func (v VarBind) IsEndOfMibView() bool {
	return IsEndOfMibView(v)
}

// IsEndOfMibView reports whether v signals endOfMibView.
func IsEndOfMibView(v VarBind) bool {
	if v.Type == TypeEndOfMibView {
		return true
	}
	special, ok := asSpecialValue(v)
	return ok && special == EndOfMibView
}

// IsTerminal reports whether the binding ends the walk for its column.
func (v VarBind) IsTerminal() bool {
	return IsTerminal(v)
}

// IsTerminal reports whether v ends the walk for its column. Besides
// endOfMibView, the two SNMP exception values are treated as terminal so a
// malformed agent cannot cause an endless walk.
func IsTerminal(v VarBind) bool {
	switch v.Type {
	case TypeEndOfMibView, TypeNoSuchObject, TypeNoSuchInstance:
		return true
	}
	special, ok := asSpecialValue(v)
	if !ok {
		return false
	}
	return special == EndOfMibView || special == NoSuchObject || special == NoSuchInstance
}

func asSpecialValue(binding VarBind) (SpecialValue, bool) {
	switch value := binding.Value.(type) {
	case SpecialValue:
		return value, true
	case string:
		// A normal octet-string value is allowed to contain the literal text
		// "endOfMibView". Only untyped strings are interpreted as exception
		// markers.
		if binding.Type != TypeUnknown {
			return "", false
		}
		switch {
		case strings.EqualFold(value, string(EndOfMibView)):
			return EndOfMibView, true
		case strings.EqualFold(value, string(NoSuchObject)):
			return NoSuchObject, true
		case strings.EqualFold(value, string(NoSuchInstance)):
			return NoSuchInstance, true
		}
	}
	return "", false
}
