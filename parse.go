package dataeng

import (
	"encoding/binary"
	"fmt"
	"time"
)

const (
	netflowV9Version = 9
	ipfixVersion     = 10

	netflowV9TemplateSet        = 0
	netflowV9OptionsTemplateSet = 1

	ipfixTemplateSet        = 2
	ipfixOptionsTemplateSet = 3

	variableLengthField = 0xffff
	enterpriseBit       = 0x8000
)

type parsedPacket struct {
	version    uint16
	domain     uint32
	sequence   uint32
	exportTime time.Time
	sysUptime  uint32

	templates   []Template
	withdrawals []templateWithdrawal
	dataSets    []rawDataSet
}

type rawDataSet struct {
	id      uint16
	payload []byte
}

type templateWithdrawal struct {
	id   uint16
	kind TemplateKind
	all  bool
}

func parsePacket(packet []byte) (parsedPacket, error) {
	if len(packet) < 2 {
		return parsedPacket{}, parseErr(0, "packet is shorter than the version field")
	}
	switch binary.BigEndian.Uint16(packet[:2]) {
	case netflowV9Version:
		return parseNetFlowV9(packet)
	case ipfixVersion:
		return parseIPFIX(packet)
	default:
		return parsedPacket{}, fmt.Errorf("%w: %d", ErrUnsupportedVersion, binary.BigEndian.Uint16(packet[:2]))
	}
}

func parseNetFlowV9(packet []byte) (parsedPacket, error) {
	if len(packet) < 20 {
		return parsedPacket{}, parseErr(len(packet), "truncated NetFlow v9 header")
	}

	out := parsedPacket{
		version:    netflowV9Version,
		sysUptime:  binary.BigEndian.Uint32(packet[4:8]),
		exportTime: time.Unix(int64(binary.BigEndian.Uint32(packet[8:12])), 0),
		sequence:   binary.BigEndian.Uint32(packet[12:16]),
		domain:     binary.BigEndian.Uint32(packet[16:20]),
	}

	for off := 20; off < len(packet); {
		if len(packet)-off < 4 {
			if allZero(packet[off:]) {
				break
			}
			return parsedPacket{}, parseErr(off, "truncated flowset header")
		}
		setID := binary.BigEndian.Uint16(packet[off : off+2])
		length := int(binary.BigEndian.Uint16(packet[off+2 : off+4]))
		if length < 4 {
			return parsedPacket{}, parseErr(off+2, "flowset length is smaller than its header")
		}
		if length > len(packet)-off {
			return parsedPacket{}, parseErr(off, "flowset extends beyond packet")
		}
		body := packet[off+4 : off+length]

		switch setID {
		case netflowV9TemplateSet:
			templates, err := parseV9TemplateSet(body, off+4)
			if err != nil {
				return parsedPacket{}, err
			}
			out.templates = append(out.templates, templates...)
		case netflowV9OptionsTemplateSet:
			templates, err := parseV9OptionsTemplateSet(body, off+4)
			if err != nil {
				return parsedPacket{}, err
			}
			out.templates = append(out.templates, templates...)
		default:
			if setID >= 256 {
				out.dataSets = append(out.dataSets, rawDataSet{id: setID, payload: body})
			}
		}
		off += length
	}
	return out, nil
}

func parseIPFIX(packet []byte) (parsedPacket, error) {
	if len(packet) < 16 {
		return parsedPacket{}, parseErr(len(packet), "truncated IPFIX header")
	}
	length := int(binary.BigEndian.Uint16(packet[2:4]))
	if length < 16 {
		return parsedPacket{}, parseErr(2, "IPFIX message length is smaller than its header")
	}
	if length > len(packet) {
		return parsedPacket{}, parseErr(2, "IPFIX message length exceeds packet")
	}

	out := parsedPacket{
		version:    ipfixVersion,
		exportTime: time.Unix(int64(binary.BigEndian.Uint32(packet[4:8])), 0),
		sequence:   binary.BigEndian.Uint32(packet[8:12]),
		domain:     binary.BigEndian.Uint32(packet[12:16]),
	}

	for off := 16; off < length; {
		if length-off < 4 {
			if allZero(packet[off:length]) {
				break
			}
			return parsedPacket{}, parseErr(off, "truncated set header")
		}
		setID := binary.BigEndian.Uint16(packet[off : off+2])
		setLength := int(binary.BigEndian.Uint16(packet[off+2 : off+4]))
		if setLength < 4 {
			return parsedPacket{}, parseErr(off+2, "set length is smaller than its header")
		}
		if setLength > length-off {
			return parsedPacket{}, parseErr(off, "set extends beyond IPFIX message")
		}
		body := packet[off+4 : off+setLength]

		switch setID {
		case ipfixTemplateSet:
			templates, withdrawals, err := parseIPFIXTemplateSet(body, off+4, false)
			if err != nil {
				return parsedPacket{}, err
			}
			out.templates = append(out.templates, templates...)
			out.withdrawals = append(out.withdrawals, withdrawals...)
		case ipfixOptionsTemplateSet:
			templates, withdrawals, err := parseIPFIXTemplateSet(body, off+4, true)
			if err != nil {
				return parsedPacket{}, err
			}
			out.templates = append(out.templates, templates...)
			out.withdrawals = append(out.withdrawals, withdrawals...)
		default:
			if setID >= 256 {
				out.dataSets = append(out.dataSets, rawDataSet{id: setID, payload: body})
			}
		}
		off += setLength
	}
	return out, nil
}

func parseV9TemplateSet(body []byte, base int) ([]Template, error) {
	var out []Template
	for off := 0; off < len(body); {
		if len(body)-off < 4 {
			if allZero(body[off:]) {
				break
			}
			return nil, parseErr(base+off, "truncated v9 template record")
		}
		id := binary.BigEndian.Uint16(body[off : off+2])
		count := int(binary.BigEndian.Uint16(body[off+2 : off+4]))
		if id == 0 && count == 0 && allZero(body[off:]) {
			break
		}

		fieldBytes := count * 4
		if fieldBytes/4 != count || len(body)-off-4 < fieldBytes {
			return nil, parseErr(base+off, "template field list extends beyond flowset")
		}
		fields := make([]Field, count)
		for i := range fields {
			p := off + 4 + i*4
			fields[i] = Field{
				Type:   binary.BigEndian.Uint16(body[p : p+2]),
				Length: binary.BigEndian.Uint16(body[p+2 : p+4]),
			}
		}
		out = append(out, Template{
			ID:     id,
			Kind:   TemplateData,
			Fields: fields,
		})
		off += 4 + fieldBytes
	}
	return out, nil
}

func parseV9OptionsTemplateSet(body []byte, base int) ([]Template, error) {
	var out []Template
	for off := 0; off < len(body); {
		if allZero(body[off:]) {
			break
		}
		if len(body)-off < 6 {
			return nil, parseErr(base+off, "truncated v9 options template record")
		}
		id := binary.BigEndian.Uint16(body[off : off+2])
		scopeBytes := int(binary.BigEndian.Uint16(body[off+2 : off+4]))
		optionBytes := int(binary.BigEndian.Uint16(body[off+4 : off+6]))
		if scopeBytes%4 != 0 || optionBytes%4 != 0 {
			return nil, parseErr(base+off, "v9 options field lengths are not multiples of four")
		}
		total := scopeBytes + optionBytes
		if total < 0 || len(body)-off-6 < total {
			return nil, parseErr(base+off, "v9 options field list extends beyond flowset")
		}

		fieldCount := total / 4
		fields := make([]Field, fieldCount)
		for i := range fields {
			p := off + 6 + i*4
			fields[i] = Field{
				Type:   binary.BigEndian.Uint16(body[p : p+2]),
				Length: binary.BigEndian.Uint16(body[p+2 : p+4]),
			}
		}
		out = append(out, Template{
			ID:              id,
			Kind:            TemplateOptions,
			Fields:          fields,
			ScopeFieldCount: scopeBytes / 4,
		})
		off += 6 + total
	}
	return out, nil
}

func parseIPFIXTemplateSet(body []byte, base int, options bool) ([]Template, []templateWithdrawal, error) {
	var (
		templates  []Template
		withdrawal []templateWithdrawal
	)

	for off := 0; off < len(body); {
		if allZero(body[off:]) {
			break
		}
		if len(body)-off < 4 {
			return nil, nil, parseErr(base+off, "truncated IPFIX template record")
		}

		id := binary.BigEndian.Uint16(body[off : off+2])
		count := int(binary.BigEndian.Uint16(body[off+2 : off+4]))

		if count == 0 {
			kind := TemplateData
			all := id == ipfixTemplateSet
			if options {
				kind = TemplateOptions
				all = id == ipfixOptionsTemplateSet
			}
			withdrawal = append(withdrawal, templateWithdrawal{id: id, kind: kind, all: all})
			// A withdrawal has no field specifiers. An options withdrawal
			// normally carries a zero scope-field-count word, but some
			// exporters omit it. Consume the word only when it is present
			// and zero.
			advance := 4
			if options && len(body)-off >= 6 &&
				binary.BigEndian.Uint16(body[off+4:off+6]) == 0 {
				advance = 6
			}
			off += advance
			continue
		}

		headerLength := 4
		scopeCount := 0
		if options {
			headerLength = 6
			if len(body)-off < headerLength {
				return nil, nil, parseErr(base+off, "truncated IPFIX options template record")
			}
			scopeCount = int(binary.BigEndian.Uint16(body[off+4 : off+6]))
		}
		if options && scopeCount > count {
			return nil, nil, parseErr(base+off+4, "scope field count exceeds field count")
		}

		fields := make([]Field, 0, count)
		p := off + headerLength
		for i := 0; i < count; i++ {
			if len(body)-p < 4 {
				return nil, nil, parseErr(base+p, "truncated IPFIX field specifier")
			}
			fieldType := binary.BigEndian.Uint16(body[p : p+2])
			length := binary.BigEndian.Uint16(body[p+2 : p+4])
			p += 4

			var enterprise uint32
			if fieldType&enterpriseBit != 0 {
				fieldType &= ^uint16(enterpriseBit)
				if len(body)-p < 4 {
					return nil, nil, parseErr(base+p, "truncated IPFIX enterprise number")
				}
				enterprise = binary.BigEndian.Uint32(body[p : p+4])
				p += 4
			}
			fields = append(fields, Field{
				Type:       fieldType,
				Length:     length,
				Enterprise: enterprise,
			})
		}

		kind := TemplateData
		if options {
			kind = TemplateOptions
		}
		templates = append(templates, Template{
			ID:              id,
			Kind:            kind,
			Fields:          fields,
			ScopeFieldCount: scopeCount,
		})
		off = p
	}
	return templates, withdrawal, nil
}

func parseErr(offset int, reason string) error {
	return &ParseError{Offset: offset, Reason: reason}
}

func allZero(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}
