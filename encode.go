package dataeng

import (
	"fmt"
	"sort"
)

// EncodePresent packs booleans MSB-first, as ORC does for bit fields.
func EncodePresent(values []bool) []byte {
	out := make([]byte, (len(values)+7)/8)
	for i, value := range values {
		if value {
			out[i/8] |= 1 << uint(7-i%8)
		}
	}
	return out
}

// EncodeRLEv1 writes values as an ORC RLEv1 integer stream. The encoder emits
// literal runs, which is valid for both signed and unsigned streams.
func EncodeRLEv1(values []int64, signed bool) []byte {
	out := make([]byte, 0, len(values)*2)
	for len(values) > 0 {
		count := len(values)
		if count > 128 {
			count = 128
		}
		out = append(out, byte(256-count))
		for _, value := range values[:count] {
			if signed {
				out = appendUVarint(out, zigzagEncode(value))
			} else {
				out = appendUVarint(out, uint64(value))
			}
		}
		values = values[count:]
	}
	return out
}

// EncodeRLEv2 writes values as a sequence of ORC RLEv2 direct runs.
func EncodeRLEv2(values []int64, signed bool) []byte {
	out := make([]byte, 0, len(values)*2)
	for len(values) > 0 {
		count := len(values)
		if count > 512 {
			count = 512
		}
		chunk := values[:count]
		encoded := make([]uint64, count)
		var max uint64
		for i, value := range chunk {
			if signed {
				encoded[i] = zigzagEncode(value)
			} else {
				if value < 0 {
					// Unsigned streams must not contain negative values. The
					// decoder will reject the resulting value rather than
					// silently wrapping it.
					encoded[i] = uint64(value)
				} else {
					encoded[i] = uint64(value)
				}
			}
			if encoded[i] > max {
				max = encoded[i]
			}
		}
		width := bitsRequired(max)
		if width == 0 {
			width = 1
		}
		width = orcBitWidth(width)
		widthCode, err := encodeBitWidth(width)
		if err != nil {
			panic(err)
		}
		length := count - 1
		out = append(out, byte(0x40|widthCode<<1|uint64(length>>8)), byte(length))
		out = appendPacked(out, encoded, width)
		values = values[count:]
	}
	return out
}

func appendPacked(dst []byte, values []uint64, width int) []byte {
	var current byte
	used := 0
	for _, value := range values {
		left := width
		for left > 0 {
			take := 8 - used
			if take > left {
				take = left
			}
			shift := left - take
			part := byte((value >> uint(shift)) & uint64((1<<uint(take))-1))
			current |= part << uint(8-used-take)
			used += take
			left -= take
			if used == 8 {
				dst = append(dst, current)
				current = 0
				used = 0
			}
		}
	}
	if used != 0 {
		dst = append(dst, current)
	}
	return dst
}

func bitsRequired(value uint64) int {
	width := 0
	for value > 0 {
		width++
		value >>= 1
	}
	return width
}

func orcBitWidth(width int) int {
	if width <= 24 {
		return width
	}
	for _, candidate := range [...]int{26, 28, 30, 32, 40, 48, 56, 64} {
		if width <= candidate {
			return candidate
		}
	}
	return 64
}

func appendUVarint(dst []byte, value uint64) []byte {
	for value >= 0x80 {
		dst = append(dst, byte(value)|0x80)
		value >>= 7
	}
	return append(dst, byte(value))
}

// EncodeDirect builds a direct-encoded StringStream. PRESENT is omitted when
// every row is non-null. For an all-null input DATA and LENGTH are absent,
// which is the only valid missing-stream case.
func EncodeDirect(values []Value, v2 bool) StringStream {
	encoding := EncodingDirect
	if v2 {
		encoding = EncodingDirectV2
	}
	st := StringStream{Rows: len(values), Encoding: encoding}
	present, anyNull := presentFor(values)
	if anyNull {
		st.Present = present
	}
	if allNull(values) {
		return st
	}

	lengths := make([]int64, 0, len(values))
	data := make([]byte, 0)
	for _, value := range values {
		if value.Null {
			continue
		}
		lengths = append(lengths, int64(len(value.Text)))
		data = append(data, value.Text...)
	}
	if v2 {
		st.Length = EncodeRLEv2(lengths, false)
	} else {
		st.Length = EncodeRLEv1(lengths, false)
	}
	st.Data = data
	return st
}

// EncodeDictionary builds an ORC dictionary-encoded StringStream. The
// dictionary is sorted lexicographically by UTF-8 bytes, as required by ORC.
func EncodeDictionary(values []Value, v2 bool) StringStream {
	encoding := EncodingDictionary
	if v2 {
		encoding = EncodingDictionaryV2
	}
	st := StringStream{Rows: len(values), Encoding: encoding}
	present, anyNull := presentFor(values)
	if anyNull {
		st.Present = present
	}
	if allNull(values) {
		return st
	}

	unique := make(map[string]struct{})
	for _, value := range values {
		if !value.Null {
			unique[value.Text] = struct{}{}
		}
	}
	dictionary := make([]string, 0, len(unique))
	for value := range unique {
		dictionary = append(dictionary, value)
	}
	sort.Strings(dictionary)

	index := make(map[string]int64, len(dictionary))
	var dictData []byte
	dictLengths := make([]int64, len(dictionary))
	for i, value := range dictionary {
		index[value] = int64(i)
		dictLengths[i] = int64(len(value))
		dictData = append(dictData, value...)
	}

	indices := make([]int64, 0, len(values))
	for _, value := range values {
		if !value.Null {
			indices = append(indices, index[value.Text])
		}
	}
	if v2 {
		st.Data = EncodeRLEv2(indices, false)
		st.Length = EncodeRLEv2(dictLengths, false)
	} else {
		st.Data = EncodeRLEv1(indices, false)
		st.Length = EncodeRLEv1(dictLengths, false)
	}
	st.DictionaryData = dictData
	return st
}

// EncodeStrings chooses the requested encoding and builds a StringStream.
func EncodeStrings(values []Value, encoding Encoding) (StringStream, error) {
	switch encoding {
	case EncodingDirect:
		return EncodeDirect(values, false), nil
	case EncodingDirectV2:
		return EncodeDirect(values, true), nil
	case EncodingDictionary:
		return EncodeDictionary(values, false), nil
	case EncodingDictionaryV2:
		return EncodeDictionary(values, true), nil
	default:
		return StringStream{}, fmt.Errorf("%w: %v", ErrInvalidEncoding, encoding)
	}
}

func presentFor(values []Value) ([]byte, bool) {
	bits := make([]bool, len(values))
	anyNull := false
	for i, value := range values {
		bits[i] = !value.Null
		anyNull = anyNull || value.Null
	}
	return EncodePresent(bits), anyNull
}

func allNull(values []Value) bool {
	for _, value := range values {
		if !value.Null {
			return false
		}
	}
	return len(values) > 0
}
