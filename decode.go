package q214

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
)

// decodeBase64URLCanonical decodes a compact base64url segment without
// padding and rejects anything that is not the unique shortest encoding of
// the decoded bytes. This catches '=' padding, standard-alphabet chars
// ('+', '/'), whitespace and length-invalid (non-minimal) encodings.
func decodeBase64URLCanonical(segment string) ([]byte, error) {
	// A canonical unpadded base64url segment has a length congruent to
	// 0, 2 or 3 mod 4; length 1 mod 4 cannot encode any byte sequence.
	if len(segment)%4 == 1 {
		return nil, ErrNonCanonicalEncoding
	}
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return nil, ErrNonCanonicalEncoding
	}
	if base64.RawURLEncoding.EncodeToString(raw) != segment {
		return nil, ErrNonCanonicalEncoding
	}
	return raw, nil
}

// strictUnmarshal parses exactly one JSON object into dst. It rejects:
//   - duplicate object keys at every nesting level,
//   - unknown/duplicate struct fields (via DisallowUnknownFields),
//   - multiple JSON values and trailing data,
//   - non-finite or otherwise invalid numbers.
func strictUnmarshal(data []byte, dst any) error {
	if err := rejectDuplicateKeys(data); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(dst); err != nil {
		return ErrMalformedJSON
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return ErrMalformedJSON
	}
	return nil
}

type jsonFrame struct {
	isObject bool
	// expectKey is only meaningful for object frames: true means the next
	// string token is an object key rather than a value.
	expectKey bool
	keys      map[string]struct{}
}

// rejectDuplicateKeys tokenizes the document and tracks object keys. A stack
// of frames distinguishes object contexts from arrays, where strings are
// always values and duplicate names are allowed.
func rejectDuplicateKeys(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()

	var stack []jsonFrame
	sawValue := false
	for {
		tok, err := dec.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return ErrMalformedJSON
		}
		sawValue = true

		switch t := tok.(type) {
		case json.Delim:
			switch t {
			case '{':
				// The nested container is the value of the parent's key.
				if len(stack) > 0 && stack[len(stack)-1].isObject {
					stack[len(stack)-1].expectKey = true
				}
				stack = append(stack, jsonFrame{isObject: true, expectKey: true, keys: map[string]struct{}{}})
			case '[':
				if len(stack) > 0 && stack[len(stack)-1].isObject {
					stack[len(stack)-1].expectKey = true
				}
				stack = append(stack, jsonFrame{isObject: false})
			case '}', ']':
				if len(stack) == 0 {
					return ErrMalformedJSON
				}
				stack = stack[:len(stack)-1]
			}
		case string:
			if len(stack) > 0 && stack[len(stack)-1].isObject && stack[len(stack)-1].expectKey {
				top := &stack[len(stack)-1]
				if _, exists := top.keys[t]; exists {
					return ErrMalformedJSON
				}
				top.keys[t] = struct{}{}
				top.expectKey = false
			} else if len(stack) > 0 && stack[len(stack)-1].isObject {
				// String value: the enclosing object expects a key next.
				stack[len(stack)-1].expectKey = true
			}
		default:
			// null, bool or json.Number value.
			if len(stack) > 0 && stack[len(stack)-1].isObject {
				stack[len(stack)-1].expectKey = true
			}
		}
	}

	if len(stack) != 0 || !sawValue {
		return ErrMalformedJSON
	}
	return nil
}
