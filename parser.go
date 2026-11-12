package dataeng

import (
	"errors"
	"strings"
)

// parser walks exactly one message inside a shared stream buffer. base is the
// message's first byte in buf. Cursor positions are absolute buffer indices;
// every wire offset (including compression pointer targets) is translated by
// base, so a pointer can never escape into a neighboring message.
type parser struct {
	buf        []byte
	base       int
	pos        int
	maxRdata   int
	nameStarts map[int]bool // absolute indices that may be pointer targets
}

func (p *parser) need(n int) error {
	if p.pos+n > len(p.buf) {
		return ErrTruncated
	}
	return nil
}

func (p *parser) u16() (uint16, error) {
	if err := p.need(2); err != nil {
		return 0, err
	}
	v := uint16(p.buf[p.pos])<<8 | uint16(p.buf[p.pos+1])
	p.pos += 2
	return v, nil
}

func (p *parser) u32() (uint32, error) {
	if err := p.need(4); err != nil {
		return 0, err
	}
	v := uint32(p.buf[p.pos])<<24 | uint32(p.buf[p.pos+1])<<16 |
		uint32(p.buf[p.pos+2])<<8 | uint32(p.buf[p.pos+3])
	p.pos += 4
	return v, nil
}

// parseOne parses one message starting at data[base]. It returns the parsed
// message and the absolute buffer index just past it.
func parseOne(data []byte, base, maxRdata int) (Message, int, error) {
	if base+headerLength > len(data) {
		return Message{}, base, ErrTruncated
	}
	h := Header{
		ID:      uint16(data[base])<<8 | uint16(data[base+1]),
		Flags:   uint16(data[base+2])<<8 | uint16(data[base+3]),
		QDCount: uint16(data[base+4])<<8 | uint16(data[base+5]),
		ANCount: uint16(data[base+6])<<8 | uint16(data[base+7]),
		NSCount: uint16(data[base+8])<<8 | uint16(data[base+9]),
		ARCount: uint16(data[base+10])<<8 | uint16(data[base+11]),
	}
	if h.Flags&qrMask == 0 {
		return Message{}, base, ErrNotResponse
	}

	p := &parser{
		buf:        data,
		base:       base,
		pos:        base + headerLength,
		maxRdata:   maxRdata,
		nameStarts: make(map[int]bool),
	}
	msg := Message{Header: h}

	var err error
	if msg.Questions, err = parseSection(h.QDCount, p.parseQuestion); err != nil {
		return Message{}, base, err
	}
	if msg.Answers, err = parseSection(h.ANCount, p.parseRecord); err != nil {
		return Message{}, base, err
	}
	if msg.Authority, err = parseSection(h.NSCount, p.parseRecord); err != nil {
		return Message{}, base, err
	}
	if msg.Additional, err = parseSection(h.ARCount, p.parseRecord); err != nil {
		return Message{}, base, err
	}
	return msg, p.pos, nil
}

func parseSection[T any](count uint16, parse func() (T, error)) ([]T, error) {
	items := make([]T, 0, count)
	for i := uint16(0); i < count; i++ {
		item, err := parse()
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (p *parser) parseQuestion() (Question, error) {
	name, err := p.parseName()
	if err != nil {
		return Question{}, err
	}
	typ, err := p.u16()
	if err != nil {
		return Question{}, err
	}
	class, err := p.u16()
	if err != nil {
		return Question{}, err
	}
	return Question{Name: name, Type: typ, Class: class}, nil
}

func (p *parser) parseRecord() (Record, error) {
	name, err := p.parseName()
	if err != nil {
		return Record{}, err
	}
	typ, err := p.u16()
	if err != nil {
		return Record{}, err
	}
	class, err := p.u16()
	if err != nil {
		return Record{}, err
	}
	ttl, err := p.u32()
	if err != nil {
		return Record{}, err
	}
	rdlen, err := p.u16()
	if err != nil {
		return Record{}, err
	}
	if int(rdlen) > p.maxRdata {
		return Record{}, ErrRdataTooLarge
	}
	start := p.pos
	end := start + int(rdlen)
	if end > len(p.buf) {
		return Record{}, ErrTruncated
	}
	var rdata []byte
	if rdlen > 0 {
		rdata = append([]byte(nil), p.buf[start:end]...)
	}
	p.pos = end

	rec := Record{
		Name:  name,
		Type:  typ,
		Class: class,
		TTL:   ttl,
		Rdata: rdata,
	}
	switch typ {
	case TypeA:
		if rdlen != 4 {
			return Record{}, ErrRdataLength
		}
	case TypeAAAA:
		if rdlen != 16 {
			return Record{}, ErrRdataLength
		}
	case TypeMX:
		if rdlen < 3 {
			return Record{}, ErrRdataLength
		}
		rec.Preference = uint16(rdata[0])<<8 | uint16(rdata[1])
		exch, err := p.parseBoundedName(start+2, end)
		if err != nil {
			return Record{}, err
		}
		rec.Exchange = exch
	}
	return rec, nil
}

// parseBoundedName parses a name inside an rdata window and requires it to end
// exactly at limit. Pointer targets may still reach earlier message bytes.
func (p *parser) parseBoundedName(start, limit int) (string, error) {
	saved := p.pos
	p.pos = start
	name, err := p.parseName()
	at := p.pos
	p.pos = saved
	if err != nil {
		if errors.Is(err, ErrTruncated) {
			return "", ErrMalformed
		}
		return "", err
	}
	if at != limit {
		return "", ErrMalformed
	}
	return name, nil
}

// parseName reads one possibly compressed name starting at p.pos. On return
// p.pos sits directly after the wire name; for a pointer-terminated name that
// is the byte after the two pointer octets, not at the target.
func (p *parser) parseName() (string, error) {
	wireStart := p.pos
	p.nameStarts[wireStart] = true

	var labels []string
	wireLen := 0
	jumps := 0
	seen := make(map[int]bool)
	// wireEnd is set once when the first compression pointer terminates the
	// on-wire name; walking the target must not move the caller's cursor.
	wireEnd := 0

	for {
		if p.pos >= len(p.buf) {
			return "", ErrTruncated
		}
		here := p.pos
		b := p.buf[here]

		if b == 0 {
			p.nameStarts[here] = true
			wireLen++
			if wireLen > maxNameWire {
				return "", ErrNameTooLong
			}
			if wireEnd != 0 {
				p.pos = wireEnd
			} else {
				p.pos = here + 1
			}
			return strings.Join(labels, "."), nil
		}

		switch b & pointerMask {
		case pointerValue:
			if p.pos+1 >= len(p.buf) {
				return "", ErrTruncated
			}
			pointerAt := p.pos
			offset := (int(b)&pointerLowBits)<<8 | int(p.buf[p.pos+1])
			target := p.base + offset
			// The target must strictly precede the pointer and stay inside
			// this message; base-relative translation forbids cross-message
			// references even though they share one buffer.
			if target >= pointerAt || target < p.base || target >= len(p.buf) {
				return "", ErrPointer
			}
			if !p.nameStarts[target] {
				return "", ErrPointer
			}
			jumps++
			if jumps > maxNameJumps || seen[target] {
				return "", ErrPointer
			}
			seen[target] = true
			if wireEnd == 0 {
				wireEnd = pointerAt + 2
			}
			p.pos = target
		case 0:
			length := int(b)
			if length == 0 || length > labelMaxLength {
				return "", ErrMalformed
			}
			p.nameStarts[here] = true
			labelEnd := here + 1 + length
			if labelEnd > len(p.buf) {
				return "", ErrTruncated
			}
			labels = append(labels, string(p.buf[here+1:labelEnd]))
			wireLen += 1 + length
			if wireLen > maxNameWire {
				return "", ErrNameTooLong
			}
			p.pos = labelEnd
		default:
			// Leading bits 01 or 10 are reserved and must fail.
			return "", ErrMalformed
		}
	}
}
