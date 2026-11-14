package dataeng

import (
	"fmt"
	"strings"
)

// CodePage identifies an EBCDIC code page used to decode character fields.
type CodePage int

const (
	// CP037 is EBCDIC US/Canada.
	CP037 CodePage = iota
	// CP1047 is EBCDIC Latin-1/Open Systems.
	CP1047
)

// ebcdicSpace is the EBCDIC blank character in every supported code page.
const ebcdicSpace = 0x40

func (cp CodePage) table() (*[256]rune, error) {
	switch cp {
	case CP037:
		return &cp037Table, nil
	case CP1047:
		return &cp1047Table, nil
	default:
		return nil, fmt.Errorf("dataeng: unsupported EBCDIC code page %d", int(cp))
	}
}

// Decode converts EBCDIC bytes to a UTF-8 string. Decoding is byte-oriented:
// one input byte always produces exactly one rune, so record framing is never
// affected by the decoded text.
func (cp CodePage) Decode(raw []byte) (string, error) {
	tab, err := cp.table()
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	sb.Grow(len(raw))
	for _, b := range raw {
		sb.WriteRune(tab[b])
	}
	return sb.String(), nil
}

// DecodeField decodes a blank-padded EBCDIC field, trimming trailing blanks.
func (cp CodePage) DecodeField(raw []byte) (string, error) {
	end := len(raw)
	for end > 0 && raw[end-1] == ebcdicSpace {
		end--
	}
	return cp.Decode(raw[:end])
}

// IsBlank reports whether the raw field is entirely EBCDIC blanks.
func IsBlank(raw []byte) bool {
	for _, b := range raw {
		if b != ebcdicSpace {
			return false
		}
	}
	return true
}
