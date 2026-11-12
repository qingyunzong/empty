package dataeng

import (
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
)

const (
	cardSize      = 80
	blockSize     = 2880
	cardsPerBlock = blockSize / cardSize
	maxHeaderAxes = 8
)

// Card is one ordinary FITS header card. END and blank cards are not
// retained. Raw contains the complete original 80 bytes.
type Card struct {
	Keyword string
	Value   string
	Comment string
	Raw     [cardSize]byte
}

// Header preserves every ordinary card, including keywords this reader does
// not interpret.
type Header struct {
	Cards []Card
}

// Lookup returns the card with the exact keyword.
func (h Header) Lookup(keyword string) (Card, bool) {
	for _, card := range h.Cards {
		if card.Keyword == keyword {
			return card, true
		}
	}
	return Card{}, false
}

type parsedCard struct {
	card  Card
	blank bool
	end   bool
}

func parseCard(raw []byte) (parsedCard, error) {
	if len(raw) != cardSize {
		return parsedCard{}, fmt.Errorf("%w: card has %d bytes", ErrInvalidHeader, len(raw))
	}

	keywordField := raw[:8]
	if allSpaces(keywordField) {
		if !allSpaces(raw) {
			return parsedCard{}, fmt.Errorf("%w: card has spaces for a keyword", ErrInvalidHeader)
		}
		return parsedCard{blank: true}, nil
	}

	keywordEnd := 8
	for keywordEnd > 0 && keywordField[keywordEnd-1] == ' ' {
		keywordEnd--
	}
	for _, b := range keywordField[:keywordEnd] {
		if !validKeywordByte(b) {
			return parsedCard{}, fmt.Errorf("%w: invalid keyword byte %q", ErrInvalidHeader, b)
		}
	}
	keyword := string(keywordField[:keywordEnd])

	if keyword == "END" {
		if !allSpaces(raw[8:]) {
			return parsedCard{}, fmt.Errorf("%w: END card is not padded with spaces", ErrInvalidPadding)
		}
		return parsedCard{end: true}, nil
	}
	for _, b := range raw {
		if b < 0x20 || b > 0x7e {
			return parsedCard{}, fmt.Errorf("%w: card contains non-printable or non-ASCII data", ErrInvalidHeader)
		}
	}
	if raw[8] != '=' || raw[9] != ' ' {
		return parsedCard{}, fmt.Errorf("%w: card %s lacks '= ' in columns 9-10", ErrInvalidHeader, keyword)
	}

	valueField := string(raw[10:])
	value := valueField
	comment := ""
	if slash := strings.IndexByte(valueField, '/'); slash >= 0 {
		value = valueField[:slash]
		comment = strings.TrimSpace(valueField[slash+1:])
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return parsedCard{}, fmt.Errorf("%w: card %s has no value", ErrInvalidHeader, keyword)
	}
	if err := parseAllowedValue(value); err != nil {
		return parsedCard{}, fmt.Errorf("%w: card %s: %v", ErrInvalidHeader, keyword, err)
	}

	var rawCopy [cardSize]byte
	copy(rawCopy[:], raw)
	return parsedCard{
		card: Card{
			Keyword: keyword,
			Value:   value,
			Comment: comment,
			Raw:     rawCopy,
		},
	}, nil
}

func validKeywordByte(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_'
}

func allSpaces(p []byte) bool {
	for _, b := range p {
		if b != ' ' {
			return false
		}
	}
	return true
}

func readHeader(r io.ReaderAt, size int64, maxCards int) (Header, int64, error) {
	var header Header
	seenKeys := make(map[string]struct{})
	cardCount := 0

	for blockIndex := int64(0); ; blockIndex++ {
		if blockIndex > (1<<63-1)/blockSize {
			return Header{}, 0, fmt.Errorf("%w: header offset overflows int64", ErrResourceLimit)
		}
		blockStart := blockIndex * blockSize
		if blockStart > size-blockSize {
			return Header{}, 0, fmt.Errorf("%w: header ends before END card", ErrTruncated)
		}

		var block [blockSize]byte
		if err := readExactAt(r, block[:], blockStart); err != nil {
			return Header{}, 0, err
		}

		for slot := 0; slot < cardsPerBlock; slot++ {
			if cardCount >= maxCards {
				return Header{}, 0, fmt.Errorf("%w: more than %d header cards", ErrResourceLimit, maxCards)
			}
			cardCount++

			start := slot * cardSize
			raw := block[start : start+cardSize]
			parsed, err := parseCard(raw)
			if err != nil {
				return Header{}, 0, fmt.Errorf("%w: card %d", err, cardCount)
			}
			if parsed.blank {
				continue
			}
			if parsed.end {
				endOfBlock := start + cardSize
				if !allSpaces(block[endOfBlock:]) {
					return Header{}, 0, fmt.Errorf("%w: bytes after END are not spaces", ErrInvalidPadding)
				}
				return header, (blockIndex + 1) * blockSize, nil
			}
			if _, exists := seenKeys[parsed.card.Keyword]; exists {
				return Header{}, 0, fmt.Errorf("%w: duplicate keyword %s", ErrInvalidHeader, parsed.card.Keyword)
			}
			seenKeys[parsed.card.Keyword] = struct{}{}
			header.Cards = append(header.Cards, parsed.card)
		}
	}
}

type imageLayout struct {
	shape      []int64
	bitpix     int
	bytesPer   int
	pixelCount int64
	dataOffset int64
	bscale     *big.Rat
	bzero      *big.Rat
	blank      int64
	hasBlank   bool
}

func parseLayout(header Header, dataOffset int64) (imageLayout, error) {
	simple, ok := header.Lookup("SIMPLE")
	if !ok {
		return imageLayout{}, fmt.Errorf("%w: missing SIMPLE", ErrInvalidHeader)
	}
	if simple.Value != "T" {
		return imageLayout{}, fmt.Errorf("%w: SIMPLE must be T", ErrInvalidHeader)
	}

	bitpixCard, ok := header.Lookup("BITPIX")
	if !ok {
		return imageLayout{}, fmt.Errorf("%w: missing BITPIX", ErrInvalidHeader)
	}
	bitpixValue, err := parseDecimalInt64(bitpixCard.Value)
	if err != nil {
		return imageLayout{}, fmt.Errorf("%w: BITPIX: %v", ErrInvalidHeader, err)
	}
	var bytesPer int
	switch bitpixValue {
	case 8:
		bytesPer = 1
	case 16:
		bytesPer = 2
	case 32:
		bytesPer = 4
	case 64:
		bytesPer = 8
	default:
		return imageLayout{}, fmt.Errorf("%w: unsupported BITPIX %d", ErrInvalidHeader, bitpixValue)
	}

	naxisCard, ok := header.Lookup("NAXIS")
	if !ok {
		return imageLayout{}, fmt.Errorf("%w: missing NAXIS", ErrInvalidHeader)
	}
	naxisValue, err := parseDecimalInt64(naxisCard.Value)
	if err != nil {
		return imageLayout{}, fmt.Errorf("%w: NAXIS: %v", ErrInvalidHeader, err)
	}
	if naxisValue < 0 || naxisValue > maxHeaderAxes {
		return imageLayout{}, fmt.Errorf("%w: NAXIS %d is outside 0..%d", ErrInvalidHeader, naxisValue, maxHeaderAxes)
	}
	naxis := int(naxisValue)

	for _, card := range header.Cards {
		if !strings.HasPrefix(card.Keyword, "NAXIS") || card.Keyword == "NAXIS" {
			continue
		}
		suffix := card.Keyword[len("NAXIS"):]
		if suffix == "" || !allDecimalDigits(suffix) {
			continue
		}
		axis, parseErr := parseDecimalInt64(suffix)
		if parseErr != nil || axis < 1 || int(axis) > naxis || fmt.Sprint(axis) != suffix {
			return imageLayout{}, fmt.Errorf("%w: unexpected keyword %s", ErrInvalidHeader, card.Keyword)
		}
	}

	shape := make([]int64, naxis)
	for axis := 1; axis <= naxis; axis++ {
		keyword := fmt.Sprintf("NAXIS%d", axis)
		card, found := header.Lookup(keyword)
		if !found {
			return imageLayout{}, fmt.Errorf("%w: missing %s", ErrInvalidHeader, keyword)
		}
		length, parseErr := parseDecimalInt64(card.Value)
		if parseErr != nil {
			return imageLayout{}, fmt.Errorf("%w: %s: %v", ErrInvalidHeader, keyword, parseErr)
		}
		if length < 0 {
			return imageLayout{}, fmt.Errorf("%w: %s is negative", ErrInvalidHeader, keyword)
		}
		shape[axis-1] = length
	}

	pixelCount, ok := checkedPixelCount(shape)
	if !ok {
		return imageLayout{}, fmt.Errorf("%w: image dimensions overflow int64", ErrResourceLimit)
	}

	bscale := new(big.Rat).SetInt64(1)
	if card, found := header.Lookup("BSCALE"); found {
		bscale, err = parseFiniteDecimal(card.Value)
		if err != nil {
			return imageLayout{}, fmt.Errorf("%w: BSCALE: %v", ErrInvalidHeader, err)
		}
	}
	bzero := new(big.Rat).SetInt64(0)
	if card, found := header.Lookup("BZERO"); found {
		bzero, err = parseFiniteDecimal(card.Value)
		if err != nil {
			return imageLayout{}, fmt.Errorf("%w: BZERO: %v", ErrInvalidHeader, err)
		}
	}

	layout := imageLayout{
		shape:      shape,
		bitpix:     int(bitpixValue),
		bytesPer:   bytesPer,
		pixelCount: pixelCount,
		dataOffset: dataOffset,
		bscale:     bscale,
		bzero:      bzero,
	}

	if card, found := header.Lookup("BLANK"); found {
		blank, parseErr := parseDecimalInt64(card.Value)
		if parseErr != nil {
			return imageLayout{}, fmt.Errorf("%w: BLANK: %v", ErrInvalidHeader, parseErr)
		}
		if !blankInRawRange(blank, layout.bitpix) {
			return imageLayout{}, fmt.Errorf("%w: BLANK %d is outside BITPIX=%d range", ErrInvalidHeader, blank, layout.bitpix)
		}
		layout.blank = blank
		layout.hasBlank = true
	}

	return layout, nil
}

func checkedPixelCount(shape []int64) (int64, bool) {
	if len(shape) == 0 {
		return 0, true
	}
	for _, length := range shape {
		if length == 0 {
			return 0, true
		}
	}
	count := int64(1)
	for _, length := range shape {
		if count > (1<<63-1)/length {
			return 0, false
		}
		count *= length
	}
	return count, true
}

func blankInRawRange(blank int64, bitpix int) bool {
	switch bitpix {
	case 8:
		return blank >= 0 && blank <= 255
	case 16:
		return blank >= -32768 && blank <= 32767
	case 32:
		return blank >= -1<<31 && blank <= 1<<31-1
	default:
		return true
	}
}

func validateDataLayout(r io.ReaderAt, size int64, layout imageLayout) error {
	if layout.pixelCount > (1<<63-1)/int64(layout.bytesPer) {
		return fmt.Errorf("%w: data byte count overflows int64", ErrResourceLimit)
	}
	dataBytes := layout.pixelCount * int64(layout.bytesPer)
	paddedBytes, ok := checkedAlignedSize(dataBytes)
	if !ok {
		return fmt.Errorf("%w: padded data byte count overflows int64", ErrResourceLimit)
	}
	if layout.dataOffset > (1<<63-1)-paddedBytes {
		return fmt.Errorf("%w: file layout overflows int64", ErrResourceLimit)
	}
	expectedSize := layout.dataOffset + paddedBytes

	switch {
	case size < expectedSize:
		return fmt.Errorf("%w: file has %d bytes, layout requires %d", ErrTruncated, size, expectedSize)
	case size > expectedSize:
		return fmt.Errorf("%w: file has %d bytes, layout requires %d", ErrTrailingData, size, expectedSize)
	}

	paddingBytes := paddedBytes - dataBytes
	if paddingBytes == 0 {
		return nil
	}
	padding := make([]byte, int(paddingBytes))
	if err := readExactAt(r, padding, layout.dataOffset+dataBytes); err != nil {
		return err
	}
	for _, b := range padding {
		if b != 0 {
			return fmt.Errorf("%w: data padding contains nonzero bytes", ErrInvalidPadding)
		}
	}
	return nil
}

func checkedAlignedSize(n int64) (int64, bool) {
	if n == 0 {
		return 0, true
	}
	remainder := n % blockSize
	if remainder == 0 {
		return n, true
	}
	padding := blockSize - remainder
	if n > (1<<63-1)-padding {
		return 0, false
	}
	return n + padding, true
}

func readExactAt(r io.ReaderAt, dst []byte, offset int64) error {
	if offset < 0 {
		return fmt.Errorf("%w: negative read offset", ErrTruncated)
	}
	n, err := r.ReadAt(dst, offset)
	if n == len(dst) {
		return nil
	}
	if err == nil {
		err = io.ErrUnexpectedEOF
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("%w: read at offset %d returned %d of %d bytes", ErrTruncated, offset, n, len(dst))
	}
	return fmt.Errorf("fits: read at offset %d: %w", offset, err)
}

func copyHeader(header Header) Header {
	out := Header{Cards: make([]Card, len(header.Cards))}
	copy(out.Cards, header.Cards)
	return out
}
