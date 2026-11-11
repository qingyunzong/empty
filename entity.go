package q194

import (
	"fmt"
	"io"
	"strconv"
	"unicode"
)

// entityReader enforces the entity subset accepted by the package before the
// bytes reach encoding/xml. encoding/xml rejects unknown named entities, but it
// converts numeric references to surrogate code points into U+FFFD before it
// checks the XML character range. This reader validates the reference itself.
//
// The validator is context-aware: ampersands in comments, CDATA sections,
// processing instructions, and directives are left alone. The XML decoder
// still performs all structural parsing and entity expansion.
type entityReader struct {
	src io.Reader

	buf      [4096]byte
	chunk    []byte
	chunkErr error

	state scanState
	quote byte
	match int

	holding bool
	held    []byte
	ready   []byte
	err     error
}

type scanState uint8

const (
	scanText scanState = iota
	scanAfterLT
	scanAfterBang
	scanCommentStart
	scanComment
	scanCDATAStart
	scanCDATA
	scanPI
	scanTag
	scanDirective
)

func newEntityReader(src io.Reader) *entityReader {
	return &entityReader{src: src}
}

func (r *entityReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(r.ready) == 0 && r.err == nil {
		b, err := r.nextByte()
		if err != nil {
			if r.holding {
				r.ready = append(r.ready, r.held...)
				r.holding = false
				r.held = nil
			}
			r.err = err
			break
		}
		r.consume(b)
	}

	if len(r.ready) > 0 {
		n := copy(p, r.ready)
		r.ready = r.ready[n:]
		return n, nil
	}
	if r.err != nil {
		return 0, r.err
	}
	return 0, nil
}

func (r *entityReader) nextByte() (byte, error) {
	for {
		if len(r.chunk) > 0 {
			b := r.chunk[0]
			r.chunk = r.chunk[1:]
			return b, nil
		}
		if r.chunkErr != nil {
			err := r.chunkErr
			r.chunkErr = nil
			return 0, err
		}

		n, err := r.src.Read(r.buf[:])
		if n > 0 {
			r.chunk = r.buf[:n]
			r.chunkErr = err
			b := r.chunk[0]
			r.chunk = r.chunk[1:]
			return b, nil
		}
		if err != nil {
			return 0, err
		}
	}
}

func (r *entityReader) consume(b byte) {
	if r.holding {
		r.held = append(r.held, b)
		if b != ';' {
			return
		}
		r.holding = false
		if err := validateEntity(r.held); err != nil {
			r.err = err
			r.held = nil
			return
		}
		r.ready = append(r.ready, r.held...)
		r.held = nil
		return
	}

	if r.entityAllowed() && b == '&' {
		r.holding = true
		r.held = append(r.held[:0], b)
		return
	}

	r.ready = append(r.ready, b)
	r.advanceState(b)
}

func (r *entityReader) entityAllowed() bool {
	return r.state == scanText || (r.state == scanTag && r.quote != 0)
}

func (r *entityReader) advanceState(b byte) {
	switch r.state {
	case scanText:
		if b == '<' {
			r.state = scanAfterLT
		}
	case scanAfterLT:
		switch b {
		case '!':
			r.state = scanAfterBang
		case '?':
			r.state = scanPI
			r.match = 1
		default:
			r.state = scanTag
			r.quote = 0
		}
	case scanAfterBang:
		switch {
		case b == '-':
			r.state = scanCommentStart
		case b == '[':
			r.state = scanCDATAStart
			r.match = 0
		default:
			r.state = scanDirective
			r.quote = 0
		}
	case scanCommentStart:
		if b == '-' {
			r.state = scanComment
			r.match = 0
		} else {
			r.state = scanTag
		}
	case scanComment:
		if r.match == 2 && b == '>' {
			r.state = scanText
			r.match = 0
		} else if b == '-' {
			if r.match < 2 {
				r.match++
			}
		} else {
			r.match = 0
		}
	case scanCDATAStart:
		const open = "CDATA["
		if b == open[r.match] {
			r.match++
			if r.match == len(open) {
				r.state = scanCDATA
				r.match = 0
			}
		} else {
			r.state = scanTag
		}
	case scanCDATA:
		if r.match == 2 && b == '>' {
			r.state = scanText
			r.match = 0
		} else if b == ']' {
			if r.match < 2 {
				r.match++
			}
		} else {
			r.match = 0
		}
	case scanPI:
		if r.match == 1 && b == '>' {
			r.state = scanText
			r.match = 0
		} else {
			r.match = boolByte(b == '?')
		}
	case scanTag:
		if r.quote != 0 {
			if b == r.quote {
				r.quote = 0
			}
			return
		}
		switch b {
		case '\'', '"':
			r.quote = b
		case '>':
			r.state = scanText
		}
	case scanDirective:
		if r.quote != 0 {
			if b == r.quote {
				r.quote = 0
			}
			return
		}
		switch b {
		case '\'', '"':
			r.quote = b
		case '>':
			r.state = scanText
		}
	}
}

func boolByte(value bool) int {
	if value {
		return 1
	}
	return 0
}

func validateEntity(entity []byte) error {
	if len(entity) < 3 || entity[0] != '&' || entity[len(entity)-1] != ';' {
		return fmt.Errorf("%w: %q", ErrUnsupportedEntity, entity)
	}
	body := string(entity[1 : len(entity)-1])
	if body == "" {
		return fmt.Errorf("%w: empty reference", ErrUnsupportedEntity)
	}

	if body[0] == '#' {
		return validateCharacterReference(body)
	}
	switch body {
	case "lt", "gt", "amp", "apos", "quot":
		return nil
	default:
		return fmt.Errorf("%w: &%s;", ErrUnsupportedEntity, body)
	}
}

func validateCharacterReference(body string) error {
	digits := body[1:]
	base := 10
	if len(digits) > 1 && digits[0] == 'x' {
		base = 16
		digits = digits[1:]
	}
	if digits == "" || !digitsForBase(digits, base) {
		return fmt.Errorf("%w: %s", ErrInvalidCharacterReference, body)
	}

	value, err := strconv.ParseUint(digits, base, 64)
	if err != nil || value > unicode.MaxRune {
		return fmt.Errorf("%w: %s", ErrInvalidCharacterReference, body)
	}
	if !isXMLCharacter(rune(value)) {
		return fmt.Errorf("%w: %s", ErrInvalidCharacterReference, body)
	}
	return nil
}

func digitsForBase(value string, base int) bool {
	for _, char := range value {
		if char >= '0' && char <= '9' {
			continue
		}
		if base == 16 && (char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			continue
		}
		return false
	}
	return true
}

// isXMLCharacter implements the Char production from XML 1.0 section 2.2.
func isXMLCharacter(r rune) bool {
	return r == 0x09 ||
		r == 0x0A ||
		r == 0x0D ||
		r >= 0x20 && r <= 0xD7FF ||
		r >= 0xE000 && r <= 0xFFFD ||
		r >= 0x10000 && r <= 0x10FFFF
}
