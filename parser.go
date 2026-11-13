package dataeng

import (
	"fmt"
	"io"
)

const undefinedLength uint32 = 0xFFFFFFFF

type frame struct {
	// end is the absolute offset at which a defined-length frame ends.
	// It is -1 for a frame that ends at stop or at limit.
	end   int64
	limit int64
	stop  Tag
}

type parser struct {
	data []byte
	pos  int64
	opts Options
}

// Parse reads an implicit-VR data set from data. It never renders an image;
// it returns only the element/sequence tree represented by the stream.
//
// Sequences with undefined length are recognized by their 0xFFFFFFFF length.
// Items may have either defined or undefined length. Delimiter tags are
// consumed as structure and never appear in the returned data.
func Parse(data []byte) (*DataSet, error) {
	return ParseWithOptions(data, Options{})
}

// ParseImplicitVR is an explicit alias for Parse.
func ParseImplicitVR(data []byte) (*DataSet, error) {
	return Parse(data)
}

// ParseWithLimit parses data with a host-imposed total byte limit.
func ParseWithLimit(data []byte, maxBytes int64) (*DataSet, error) {
	return ParseWithOptions(data, Options{MaxBytes: maxBytes})
}

// ParseWithOptions parses an implicit-VR data set using opts.
func ParseWithOptions(data []byte, opts Options) (*DataSet, error) {
	opts = opts.withDefaults()
	if int64(len(data)) > opts.MaxBytes {
		return nil, &ParseError{
			Offset: opts.MaxBytes,
			Err:    ErrTooLarge,
			Detail: fmt.Sprintf("encoded data is %d bytes, host limit is %d bytes", len(data), opts.MaxBytes),
		}
	}

	p := &parser{data: data, opts: opts}
	elements, err := p.parseElements(
		frame{end: int64(len(data)), limit: int64(len(data))},
		0,
		newPrivateScope(),
	)
	if err != nil {
		return nil, err
	}
	return &DataSet{Elements: elements}, nil
}

// ReadDataSet reads at most the host limit and parses the resulting implicit-VR
// data set. Reading more than the default limit returns ErrTooLarge.
func ReadDataSet(r io.Reader) (*DataSet, error) {
	return ReadDataSetWithOptions(r, Options{})
}

// ReadImplicitVR is an explicit alias for ReadDataSet.
func ReadImplicitVR(r io.Reader) (*DataSet, error) {
	return ReadDataSet(r)
}

// ReadDataSetWithOptions reads and parses an implicit-VR data set using opts.
func ReadDataSetWithOptions(r io.Reader, opts Options) (*DataSet, error) {
	if r == nil {
		return nil, &ParseError{Offset: 0, Err: ErrTruncated, Detail: "nil reader"}
	}
	opts = opts.withDefaults()
	data, err := io.ReadAll(io.LimitReader(r, opts.MaxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > opts.MaxBytes {
		return nil, &ParseError{
			Offset: opts.MaxBytes,
			Err:    ErrTooLarge,
			Detail: fmt.Sprintf("input exceeds host limit of %d bytes", opts.MaxBytes),
		}
	}
	return ParseWithOptions(data, opts)
}

// parseElements parses an element list. A defined frame ends exactly at
// f.end. An undefined frame ends when f.stop is read, and is bounded by
// f.limit so that it cannot escape its enclosing item or sequence.
func (p *parser) parseElements(f frame, depth int, scope *privateScope) ([]*Element, error) {
	if depth > p.opts.MaxDepth {
		return nil, p.errAt(p.pos, ErrMaxDepth, fmt.Sprintf("nesting deeper than %d", p.opts.MaxDepth))
	}

	elements := make([]*Element, 0, 4)
	for {
		boundary := f.limit
		if f.end >= 0 {
			boundary = f.end
		}

		if p.pos > boundary {
			return nil, p.errAt(p.pos, ErrInvalidLength, "element extends past its enclosing container")
		}
		if p.pos == boundary {
			if f.end >= 0 {
				return elements, nil
			}
			return nil, p.errAt(p.pos, ErrMissingDelimiter, "missing "+f.stop.String())
		}
		if boundary-p.pos < 8 {
			return nil, p.errAt(p.pos, ErrTruncated, fmt.Sprintf("%d byte(s) are too short for an element header", boundary-p.pos))
		}

		start := p.pos
		tag, length, err := p.readHeader(boundary)
		if err != nil {
			return nil, err
		}

		if f.end < 0 && tag == f.stop {
			if length != 0 {
				return nil, p.errAt(start, ErrInvalidDelimiterValue, fmt.Sprintf("%s has length %d", tag, length))
			}
			return elements, nil
		}

		if tag.Group == 0xFFFE {
			detail := "structural tag " + tag.String() + " is not valid here"
			return nil, p.errAt(start, ErrUnexpectedDelimiter, detail)
		}

		if !p.opts.AllowUnorderedPrivate {
			if err := scope.observe(tag); err != nil {
				block := uint8(tag.Element >> 8)
				return nil, p.errAt(start, err,
					fmt.Sprintf("private element %s needs creator (%04X,00%02X) earlier in the same layer", tag, tag.Group, block))
			}
		}

		elem := &Element{Tag: tag, Length: int64(length)}
		switch {
		case length == undefinedLength:
			elem.Sequence = true
			elem.Length = -1
			if err := p.parseSequence(elem, boundary, false, depth+1); err != nil {
				return nil, err
			}
		case p.opts.isSequenceTag(tag):
			elem.Sequence = true
			seqEnd := p.pos + int64(length)
			if seqEnd > boundary {
				return nil, p.errAt(start, ErrInvalidLength, "defined-length sequence extends past its enclosing container")
			}
			if err := p.parseSequence(elem, seqEnd, true, depth+1); err != nil {
				return nil, err
			}
			if p.pos != seqEnd {
				return nil, p.errAt(p.pos, ErrInvalidLength, "defined-length sequence did not end at its declared boundary")
			}
		default:
			valueEnd := p.pos + int64(length)
			if valueEnd > boundary {
				return nil, p.errAt(start, ErrInvalidLength,
					fmt.Sprintf("value length %d crosses container boundary at %d", length, boundary))
			}
			elem.Value = p.data[p.pos:valueEnd]
			p.pos = valueEnd
		}
		elements = append(elements, elem)
	}
}

// parseSequence parses items until boundary. For an undefined-length sequence
// the boundary is the enclosing limit and the sequence delimiter is required.
// For a defined-length sequence the boundary is its declared end and no
// sequence delimiter is expected.
func (p *parser) parseSequence(elem *Element, boundary int64, defined bool, depth int) error {
	if depth > p.opts.MaxDepth {
		return p.errAt(p.pos, ErrMaxDepth, fmt.Sprintf("nesting deeper than %d", p.opts.MaxDepth))
	}

	for {
		if p.pos > boundary {
			return p.errAt(p.pos, ErrInvalidLength, "sequence extends past its enclosing container")
		}
		if p.pos == boundary {
			if defined {
				return nil
			}
			return p.errAt(p.pos, ErrMissingDelimiter, "missing "+SequenceDelimiterTag.String())
		}
		if boundary-p.pos < 8 {
			return p.errAt(p.pos, ErrTruncated, fmt.Sprintf("%d byte(s) are too short for an item header", boundary-p.pos))
		}

		start := p.pos
		tag, length, err := p.readHeader(boundary)
		if err != nil {
			return err
		}

		switch tag {
		case SequenceDelimiterTag:
			if defined {
				return p.errAt(start, ErrUnexpectedDelimiter, "defined-length sequence contains a sequence delimiter")
			}
			if length != 0 {
				return p.errAt(start, ErrInvalidDelimiterValue, fmt.Sprintf("%s has length %d", tag, length))
			}
			return nil
		case ItemDelimiterTag:
			return p.errAt(start, ErrUnexpectedDelimiter, "item delimiter outside an undefined-length item")
		case ItemTag:
			// Parsed below.
		default:
			return p.errAt(start, ErrExpectedItem, fmt.Sprintf("expected item, found %s", tag))
		}

		item := &Item{Length: int64(length)}
		if length == undefinedLength {
			item.Length = -1
			item.Elements, err = p.parseElements(
				frame{end: -1, limit: boundary, stop: ItemDelimiterTag},
				depth+1,
				newPrivateScope(),
			)
		} else {
			itemEnd := p.pos + int64(length)
			if itemEnd > boundary {
				return p.errAt(start, ErrInvalidLength, "defined-length item extends past its sequence")
			}
			item.Elements, err = p.parseElements(
				frame{end: itemEnd, limit: boundary, stop: zeroTag},
				depth+1,
				newPrivateScope(),
			)
			if err == nil && p.pos != itemEnd {
				return p.errAt(p.pos, ErrInvalidLength, "defined-length item did not end at its declared boundary")
			}
		}
		if err != nil {
			return err
		}
		elem.Items = append(elem.Items, item)
	}
}

func (p *parser) readHeader(boundary int64) (Tag, uint32, error) {
	if p.pos+8 > boundary {
		return zeroTag, 0, p.errAt(p.pos, ErrTruncated, "element header crosses container boundary")
	}
	b := p.data[p.pos : p.pos+8]
	tag := Tag{
		Group:   uint16(b[0]) | uint16(b[1])<<8,
		Element: uint16(b[2]) | uint16(b[3])<<8,
	}
	length := uint32(b[4]) | uint32(b[5])<<8 | uint32(b[6])<<16 | uint32(b[7])<<24
	p.pos += 8
	return tag, length, nil
}

func (p *parser) errAt(offset int64, err error, detail string) error {
	return &ParseError{Offset: offset, Err: err, Detail: detail}
}

// privateScope tracks private creators independently for one element-list
// layer. A creator in an outer data set does not authorize a private element
// in an item, and a creator in one item does not authorize one in another.
type privateScope struct {
	creators map[uint16]map[uint8]struct{}
}

func newPrivateScope() *privateScope {
	return &privateScope{creators: make(map[uint16]map[uint8]struct{})}
}

func (s *privateScope) observe(t Tag) error {
	if !t.IsPrivate() {
		return nil
	}

	// (gggg,0010)-(gggg,00FF) are private creator elements. Their low byte
	// selects the data block they create.
	if t.Element >= 0x0010 && t.Element <= 0x00FF {
		block := uint8(t.Element)
		blocks := s.creators[t.Group]
		if blocks == nil {
			blocks = make(map[uint8]struct{})
			s.creators[t.Group] = blocks
		}
		blocks[block] = struct{}{}
		return nil
	}

	// (gggg,1000)-(gggg,FFFF) are private data elements. The high byte of
	// the element number identifies the creator block (gggg,00bb).
	if t.Element >= 0x1000 {
		block := uint8(t.Element >> 8)
		if blocks := s.creators[t.Group]; blocks != nil {
			if _, ok := blocks[block]; ok {
				return nil
			}
		}
		return ErrPrivateBeforeCreator
	}
	return nil
}
