package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

var (
	utf8BOM    = []byte{0xEF, 0xBB, 0xBF}
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}
	utf32LEBOM = []byte{0xFF, 0xFE, 0x00, 0x00}
	utf32BEBOM = []byte{0x00, 0x00, 0xFE, 0xFF}
)

type encodingGuess struct {
	Encoding   Encoding
	BOM        bool
	Confidence float64
}

func detectEncoding(data []byte) encodingGuess {
	switch {
	case bytes.HasPrefix(data, utf8BOM):
		return encodingGuess{Encoding: EncodingUTF8, BOM: true, Confidence: 1}
	case bytes.HasPrefix(data, utf32LEBOM), bytes.HasPrefix(data, utf32BEBOM):
		// UTF-32 is intentionally not decoded. Returning an unsupported
		// guess prevents its BOM from being mistaken for UTF-16.
		return encodingGuess{Encoding: EncodingLatin1, Confidence: 0}
	case bytes.HasPrefix(data, utf16LEBOM):
		return encodingGuess{Encoding: EncodingUTF16LE, BOM: true, Confidence: 1}
	case bytes.HasPrefix(data, utf16BEBOM):
		return encodingGuess{Encoding: EncodingUTF16BE, BOM: true, Confidence: 1}
	}

	if looksLikeUTF16(data, false) {
		return encodingGuess{Encoding: EncodingUTF16LE, Confidence: 0.92}
	}
	if looksLikeUTF16(data, true) {
		return encodingGuess{Encoding: EncodingUTF16BE, Confidence: 0.92}
	}
	if utf8.Valid(data) {
		return encodingGuess{Encoding: EncodingUTF8, Confidence: 0.98}
	}
	if plausibleUTF16(data, false) {
		return encodingGuess{Encoding: EncodingUTF16LE, Confidence: 0.7}
	}
	if plausibleUTF16(data, true) {
		return encodingGuess{Encoding: EncodingUTF16BE, Confidence: 0.7}
	}
	return encodingGuess{Encoding: EncodingLatin1, Confidence: 0.7}
}

// looksLikeUTF16 only accepts the very strong alternating-NUL pattern produced
// by ASCII-heavy UTF-16 text. It intentionally does not guess UTF-16 merely
// because some byte pairs happen to be printable.
func looksLikeUTF16(data []byte, bigEndian bool) bool {
	if len(data) < 4 || len(data)%2 != 0 {
		return false
	}
	limit := len(data)
	if limit > 64<<10 {
		limit = 64 << 10
		limit -= limit % 2
	}
	evenZeros, oddZeros := 0, 0
	for i := 0; i < limit; i += 2 {
		if data[i] == 0 {
			evenZeros++
		}
		if data[i+1] == 0 {
			oddZeros++
		}
	}
	pairs := limit / 2
	var expected, opposite int
	if bigEndian {
		expected, opposite = evenZeros, oddZeros
	} else {
		expected, opposite = oddZeros, evenZeros
	}
	if expected*4 < pairs || opposite*12 > expected {
		return false
	}
	_, err := decodeUTF16(data, bigEndian)
	return err == nil
}

// plausibleUTF16 is a lower-confidence fallback for non-ASCII UTF-16 without a
// BOM. It is only consulted when the input is not valid UTF-8.
func plausibleUTF16(data []byte, bigEndian bool) bool {
	text, err := decodeUTF16(data, bigEndian)
	if err != nil || text == "" {
		return false
	}
	printable, common, private := 0, 0, 0
	total := 0
	for _, r := range text {
		total++
		if r == 0 {
			return false
		}
		if unicode.IsPrint(r) || r == '\n' || r == '\r' || r == '\t' {
			printable++
		}
		if unicode.Is(unicode.Co, r) {
			private++
		}
		if unicode.In(r,
			unicode.Latin, unicode.Han, unicode.Hiragana, unicode.Katakana,
			unicode.Hangul, unicode.Cyrillic, unicode.Greek, unicode.Arabic,
			unicode.Hebrew, unicode.Thai, unicode.Devanagari,
		) {
			common++
		}
	}
	if total == 0 {
		return false
	}
	f := float64(total)
	return float64(printable)/f >= 0.95 &&
		float64(common)/f >= 0.45 &&
		float64(private)/f <= 0.02
}

func decodeUTF16(data []byte, bigEndian bool) (string, error) {
	if len(data)%2 != 0 {
		return "", errors.New("csvdialect: odd number of bytes in UTF-16 input")
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		if bigEndian {
			units[i] = binary.BigEndian.Uint16(data[i*2:])
		} else {
			units[i] = binary.LittleEndian.Uint16(data[i*2:])
		}
	}
	for i := 0; i < len(units); i++ {
		unit := units[i]
		switch {
		case unit >= 0xD800 && unit <= 0xDBFF:
			if i+1 >= len(units) || units[i+1] < 0xDC00 || units[i+1] > 0xDFFF {
				return "", errors.New("csvdialect: unpaired UTF-16 high surrogate")
			}
			i++
		case unit >= 0xDC00 && unit <= 0xDFFF:
			return "", errors.New("csvdialect: unpaired UTF-16 low surrogate")
		}
	}
	return string(utf16.Decode(units)), nil
}

// decodeAs decodes data using enc and removes a matching BOM. It returns an
// error rather than silently producing mojibake.
func decodeAs(data []byte, enc Encoding) (text string, bom bool, err error) {
	enc = enc.normalized()
	switch enc {
	case EncodingUTF8:
		if bytes.HasPrefix(data, utf16LEBOM) || bytes.HasPrefix(data, utf16BEBOM) {
			return "", false, fmt.Errorf("csvdialect: %s BOM is not valid utf-8", enc)
		}
		if bytes.HasPrefix(data, utf8BOM) {
			data = data[len(utf8BOM):]
			bom = true
		}
		if !utf8.Valid(data) {
			return "", bom, errors.New("csvdialect: input is not valid utf-8")
		}
		return string(data), bom, nil

	case EncodingUTF16LE, EncodingUTF16BE:
		bigEndian := enc == EncodingUTF16BE
		wantBOM, otherBOM := utf16LEBOM, utf16BEBOM
		if bigEndian {
			wantBOM, otherBOM = utf16BEBOM, utf16LEBOM
		}
		if bytes.HasPrefix(data, utf8BOM) {
			return "", false, fmt.Errorf("csvdialect: utf-8 BOM is not valid %s", enc)
		}
		if bytes.HasPrefix(data, otherBOM) {
			return "", false, fmt.Errorf("csvdialect: BOM endianness does not match %s", enc)
		}
		if bytes.HasPrefix(data, wantBOM) {
			data = data[len(wantBOM):]
			bom = true
		}
		text, err = decodeUTF16(data, bigEndian)
		return text, bom, err

	case EncodingLatin1:
		if bytes.HasPrefix(data, utf8BOM) || bytes.HasPrefix(data, utf16LEBOM) ||
			bytes.HasPrefix(data, utf16BEBOM) || bytes.HasPrefix(data, utf32LEBOM) ||
			bytes.HasPrefix(data, utf32BEBOM) {
			return "", false, errors.New("csvdialect: UTF BOM is not valid iso-8859-1")
		}
		runes := make([]rune, len(data))
		for i, b := range data {
			runes[i] = rune(b)
		}
		return string(runes), false, nil
	}
	return "", false, fmt.Errorf("csvdialect: unsupported encoding %q", enc)
}

func isASCII(data []byte) bool {
	for _, b := range data {
		if b >= utf8.RuneSelf || b == 0 {
			return false
		}
	}
	return true
}
