package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math/big"
	"testing"

	dataeng "example.org/dataeng/q0252"
)

type testCard struct {
	keyword string
	value   string
	comment string
}

func cardBytes(t *testing.T, card testCard) []byte {
	t.Helper()
	if len(card.keyword) == 0 || len(card.keyword) > 8 {
		t.Fatalf("keyword %q does not fit in 8 bytes", card.keyword)
	}
	if card.keyword == "END" {
		raw := bytes.Repeat([]byte{' '}, 80)
		copy(raw, "END")
		return raw
	}

	text := fmt.Sprintf("%-8s= %s", card.keyword, card.value)
	if card.comment != "" {
		text += " / " + card.comment
	}
	if len(text) > 80 {
		t.Fatalf("card %q is %d bytes", text, len(text))
	}
	raw := bytes.Repeat([]byte{' '}, 80)
	copy(raw, text)
	return raw
}

func headerBytes(t *testing.T, cards []testCard) []byte {
	t.Helper()
	header := make([]byte, 0, len(cards)*80+80+2880)
	for _, card := range cards {
		header = append(header, cardBytes(t, card)...)
	}
	header = append(header, cardBytes(t, testCard{keyword: "END"})...)
	for len(header)%2880 != 0 {
		header = append(header, ' ')
	}
	return header
}

func fileBytes(t *testing.T, cards []testCard, data []byte) []byte {
	t.Helper()
	out := headerBytes(t, cards)
	out = append(out, data...)
	for len(out)%2880 != 0 {
		out = append(out, 0)
	}
	return out
}

func openBytes(t *testing.T, file []byte, options ...dataeng.Option) *dataeng.Image {
	t.Helper()
	image, err := dataeng.Open(bytes.NewReader(file), int64(len(file)), options...)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return image
}

func encodeSamples(t *testing.T, bitpix int, values []int64) []byte {
	t.Helper()
	var width int
	switch bitpix {
	case 8:
		width = 1
	case 16:
		width = 2
	case 32:
		width = 4
	case 64:
		width = 8
	default:
		t.Fatalf("unsupported BITPIX %d", bitpix)
	}

	out := make([]byte, 0, len(values)*width)
	for _, value := range values {
		switch bitpix {
		case 8:
			if value < 0 || value > 255 {
				t.Fatalf("8-bit test value %d is outside uint8", value)
			}
			out = append(out, byte(value))
		case 16:
			if value < -1<<15 || value > 1<<15-1 {
				t.Fatalf("16-bit test value %d is outside int16", value)
			}
			out = binary.BigEndian.AppendUint16(out, uint16(int16(value)))
		case 32:
			if value < -1<<31 || value > 1<<31-1 {
				t.Fatalf("32-bit test value %d is outside int32", value)
			}
			out = binary.BigEndian.AppendUint32(out, uint32(int32(value)))
		case 64:
			out = binary.BigEndian.AppendUint64(out, uint64(value))
		}
	}
	return out
}

func requiredCards(bitpix int, shape ...int64) []testCard {
	cards := []testCard{
		{keyword: "SIMPLE", value: "T"},
		{keyword: "BITPIX", value: fmt.Sprint(bitpix)},
		{keyword: "NAXIS", value: fmt.Sprint(len(shape))},
	}
	for i, length := range shape {
		cards = append(cards, testCard{keyword: fmt.Sprintf("NAXIS%d", i+1), value: fmt.Sprint(length)})
	}
	return cards
}

func mustRat(t *testing.T, text string) *big.Rat {
	t.Helper()
	value, ok := new(big.Rat).SetString(text)
	if !ok {
		t.Fatalf("invalid test rational %q", text)
	}
	return value
}

func requirePhysical(t *testing.T, got *big.Rat, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("physical value is nil, want %s", want)
	}
	expected := mustRat(t, want)
	if got.Cmp(expected) != 0 {
		t.Fatalf("physical value = %s, want %s", got.RatString(), expected.RatString())
	}
}

func requireRawSamples(t *testing.T, samples []dataeng.Sample, want []int64) {
	t.Helper()
	if len(samples) != len(want) {
		t.Fatalf("got %d samples, want %d", len(samples), len(want))
	}
	for i := range want {
		if samples[i].Raw != want[i] {
			t.Fatalf("sample %d raw = %d, want %d", i, samples[i].Raw, want[i])
		}
	}
}
