package dataeng

import (
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"strings"
)

var (
	ipv4FieldTypes = map[uint16]struct{}{
		8:  {}, // sourceIPv4Address
		12: {}, // destinationIPv4Address
		15: {}, // ipNextHopIPv4Address
		18: {}, // bgpNextHopIPv4Address
		44: {}, // mplsTopLabelIPv4Address (NetFlow v9)
	}
	ipv6FieldTypes = map[uint16]struct{}{
		27: {}, // sourceIPv6Address
		28: {}, // destinationIPv6Address
		62: {}, // ipNextHopIPv6Address
		63: {}, // bgpNextHopIPv6Address
	}
	stringFieldTypes = map[uint16]struct{}{
		82:  {}, // interfaceName
		83:  {}, // interfaceDescription
		84:  {}, // samplerName
		94:  {}, // applicationDescription
		96:  {}, // applicationName
		114: {}, // classifierName
		115: {}, // classifierDescription
	}
	macFieldTypes = map[uint16]struct{}{
		52: {}, // inSrcMac
		53: {}, // outDstMac
		54: {}, // sourceMacAddress
		55: {}, // destinationMacAddress
		56: {}, // sourceMacAddress (IPFIX)
		57: {}, // postDestinationMacAddress
		80: {}, // destinationMacAddress (IPFIX)
		81: {}, // postSourceMacAddress
	}
)

func decodeRecords(tmpl Template, data []byte) ([]Record, error) {
	if len(tmpl.Fields) == 0 {
		return nil, fmt.Errorf("%w: template %d has no fields", ErrInvalidTemplate, tmpl.ID)
	}

	minLength := tmpl.MinRecordLength()
	if minLength <= 0 {
		return nil, fmt.Errorf("%w: template %d has an empty record layout", ErrInvalidTemplate, tmpl.ID)
	}

	records := make([]Record, 0)
	for off := 0; off < len(data); {
		remaining := len(data) - off
		if remaining < minLength {
			if allZero(data[off:]) {
				break
			}
			return records, fmt.Errorf("trailing %d octets are shorter than the %d-octet record", remaining, minLength)
		}

		record, next, err := decodeRecord(tmpl, data, off)
		if err != nil {
			if allZero(data[off:]) {
				break
			}
			return records, err
		}
		records = append(records, record)
		off = next
	}
	return records, nil
}

func decodeRecord(tmpl Template, data []byte, off int) (Record, int, error) {
	record := Record{
		Fields: make([]FieldValue, len(tmpl.Fields)),
	}

	for i, field := range tmpl.Fields {
		if field.Variable() {
			if off >= len(data) {
				return Record{}, off, fmt.Errorf("truncated variable-length field %d", field.Type)
			}
			length := int(data[off])
			off++
			if length == 255 {
				if len(data)-off < 2 {
					return Record{}, off, fmt.Errorf("truncated variable-length field %d extended length", field.Type)
				}
				length = int(binary.BigEndian.Uint16(data[off : off+2]))
				off += 2
			}
			if len(data)-off < length {
				return Record{}, off, fmt.Errorf("variable-length field %d exceeds data set", field.Type)
			}
			raw := append([]byte(nil), data[off:off+length]...)
			off += length
			record.Fields[i] = FieldValue{
				Field: field,
				Raw:   raw,
				Value: decodeFieldValue(field, raw),
			}
			continue
		}

		length := int(field.Length)
		if len(data)-off < length {
			return Record{}, off, fmt.Errorf("field %d exceeds data set", field.Type)
		}
		raw := append([]byte(nil), data[off:off+length]...)
		off += length
		record.Fields[i] = FieldValue{
			Field: field,
			Raw:   raw,
			Value: decodeFieldValue(field, raw),
		}
	}
	return record, off, nil
}

func decodeFieldValue(field Field, raw []byte) any {
	if field.Enterprise != 0 {
		// Private enterprise fields do not share the IANA type registry.
		// Keep the bytes intact rather than guessing a representation.
		return append([]byte(nil), raw...)
	}

	if _, ok := ipv4FieldTypes[field.Type]; ok && len(raw) == net.IPv4len {
		addr, _ := netip.AddrFromSlice(raw)
		return addr
	}
	if _, ok := ipv6FieldTypes[field.Type]; ok && len(raw) == net.IPv6len {
		addr, _ := netip.AddrFromSlice(raw)
		return addr
	}
	if _, ok := stringFieldTypes[field.Type]; ok {
		return strings.TrimRight(string(raw), "\x00")
	}
	if _, ok := macFieldTypes[field.Type]; ok && len(raw) == 6 {
		return net.HardwareAddr(append([]byte(nil), raw...))
	}
	return decodeInteger(raw)
}

func decodeInteger(raw []byte) any {
	switch len(raw) {
	case 1:
		return uint64(raw[0])
	case 2:
		return uint64(binary.BigEndian.Uint16(raw))
	case 3:
		return uint64(raw[0])<<16 | uint64(raw[1])<<8 | uint64(raw[2])
	case 4:
		return uint64(binary.BigEndian.Uint32(raw))
	case 5, 6, 7:
		var n uint64
		for _, b := range raw {
			n = n<<8 | uint64(b)
		}
		return n
	case 8:
		return binary.BigEndian.Uint64(raw)
	default:
		return append([]byte(nil), raw...)
	}
}
