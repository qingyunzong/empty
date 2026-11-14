package dataeng

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// JSONOperation is one partial-JSON update operation.
//
// Op accepts the usual patch names: add, insert, replace, set, remove,
// delete and merge. MySQL's partial JSON diff uses replace/insert/remove,
// which are all supported. Path accepts a MySQL path ($.a[0]), a JSON Pointer
// (/a/0), or a simple dotted path (a.b).
type JSONOperation struct {
	Op    string `json:"op"`
	Type  string `json:"type,omitempty"`
	Path  string `json:"path"`
	Value any    `json:"value,omitempty"`
	From  string `json:"from,omitempty"`
}

func jsonOperationName(op JSONOperation) string {
	if strings.TrimSpace(op.Op) != "" {
		return op.Op
	}
	return op.Type
}

// JSONPatchOp is an alias for JSONOperation.
type JSONPatchOp = JSONOperation

// JSONPatchOperation is an alias for JSONOperation.
type JSONPatchOperation = JSONOperation

// JSONDiff describes a partial update of a JSON column. Exactly one of
// Operations/Ops, Patch, Raw or FullValue is normally set.
type JSONDiff struct {
	Operations []JSONOperation
	Ops        []JSONOperation

	// Patch is a textual RFC 6902 style operation array.
	Patch []byte

	// Raw is a MySQL binary partial-JSON diff (the value stored in a
	// MINIMAL row image for a partially updated JSON column).
	Raw []byte

	// FullValue represents a complete replacement rather than a diff.
	FullValue    any
	HasFullValue bool
}

// JSONPatch is an alias for JSONDiff.
type JSONPatch = JSONDiff

// NewJSONDiff constructs a diff from operations.
func NewJSONDiff(ops ...JSONOperation) JSONDiff {
	return JSONDiff{Operations: append([]JSONOperation(nil), ops...)}
}

// IsZero reports whether the diff carries no change description.
func (d JSONDiff) IsZero() bool {
	return !d.HasFullValue && len(d.Operations) == 0 && len(d.Ops) == 0 &&
		len(d.Patch) == 0 && len(d.Raw) == 0
}

func (d JSONDiff) operations() ([]JSONOperation, error) {
	if d.HasFullValue {
		return nil, nil
	}
	ops := append([]JSONOperation(nil), d.Operations...)
	ops = append(ops, d.Ops...)
	if len(ops) > 0 {
		return ops, nil
	}
	if len(d.Patch) > 0 {
		parsed, err := ParseJSONPatch(d.Patch)
		if err != nil {
			return nil, err
		}
		if parsed.HasFullValue {
			return nil, fmt.Errorf("%w: nested full value in patch", ErrJSONPatch)
		}
		return append(parsed.Operations, parsed.Ops...), nil
	}
	if len(d.Raw) > 0 {
		parsed, err := DecodeMySQLJSONDiff(d.Raw)
		if err != nil {
			return nil, err
		}
		return parsed.operations()
	}
	return nil, nil
}

// ErrJSONPatch identifies malformed or unsupported JSON partial updates.
var ErrJSONPatch = errors.New("dataeng: invalid json partial update")

// ErrJSONBaseMissing means a partial update needs the previous JSON value but
// no versioned pre-image is available. Callers must mark the column as not
// reconstructable instead of applying the diff to an empty document.
var ErrJSONBaseMissing = errors.New("dataeng: json partial update base is missing")

// ApplyJSONDiff applies a diff to base. A missing base is an error unless the
// diff replaces the document at its root. diff may be a JSONDiff, a
// JSONOperation slice, a textual patch or a MySQL binary diff.
func ApplyJSONDiff(base any, diff any) (any, error) {
	parsed, err := coerceJSONDiff(diff)
	if err != nil {
		return nil, err
	}
	typed := parsed
	if typed.HasFullValue {
		return cloneJSONValue(typed.FullValue), nil
	}
	ops, err := typed.operations()
	if err != nil {
		return nil, err
	}
	if len(ops) == 0 {
		if base == nil {
			return nil, fmt.Errorf("%w: empty diff", ErrJSONPatch)
		}
		return cloneJSONValue(base), nil
	}
	return ApplyJSONPatch(base, ops)
}

// ApplyJSONPatch applies RFC 6902 style operations. It is strict about a
// missing base: a nested operation cannot be applied without the document it
// is supposed to modify.
func ApplyJSONPatch(base any, patch any) (any, error) {
	var ops []JSONOperation
	switch typed := patch.(type) {
	case []JSONOperation:
		ops = typed
	default:
		diff, err := coerceJSONDiff(patch)
		if err != nil {
			return nil, err
		}
		if diff.HasFullValue {
			return cloneJSONValue(diff.FullValue), nil
		}
		ops, err = diff.operations()
		if err != nil {
			return nil, err
		}
	}
	root := cloneJSONValue(base)
	for _, op := range ops {
		tokens, err := parseJSONPath(op.Path)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrJSONPatch, err)
		}
		name := strings.ToLower(strings.TrimSpace(jsonOperationName(op)))
		if name == "" {
			name = "replace"
		}
		if len(tokens) == 0 {
			switch name {
			case "remove", "delete":
				root = nil
			case "add", "insert", "replace", "set":
				root = cloneJSONValue(op.Value)
			case "merge":
				merged, err := mergeJSONValue(root, op.Value)
				if err != nil {
					return nil, err
				}
				root = merged
			default:
				return nil, fmt.Errorf("%w: unsupported root operation %q", ErrJSONPatch, op.Op)
			}
			continue
		}

		if root == nil && name != "add" && name != "insert" && name != "set" && name != "replace" {
			return nil, fmt.Errorf("%w: %s", ErrJSONBaseMissing, op.Path)
		}
		root, err = applyJSONOperation(root, tokens, name, op.Value)
		if err != nil {
			return nil, err
		}
	}
	return root, nil
}

func coerceJSONDiff(value any) (JSONDiff, error) {
	switch typed := value.(type) {
	case JSONDiff:
		return typed, nil
	case *JSONDiff:
		if typed == nil {
			return JSONDiff{}, nil
		}
		return *typed, nil
	}
	if diff, ok := JSONDiffFromAny(value); ok {
		return diff, nil
	}
	if raw, ok := value.([]byte); ok {
		diff, err := DecodeMySQLJSONDiff(raw)
		if err == nil {
			return diff, nil
		}
	}
	if raw, ok := value.(json.RawMessage); ok {
		diff, err := DecodeMySQLJSONDiff(raw)
		if err == nil {
			return diff, nil
		}
	}
	return JSONDiff{}, fmt.Errorf("%w: unsupported diff type %T", ErrJSONPatch, value)
}

// ApplyJSONPartialUpdate parses a textual RFC 6902 patch (or a MySQL binary
// diff when raw is not JSON text) and applies it to base.
func ApplyJSONPartialUpdate(base any, raw []byte) (any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("%w: empty payload", ErrJSONPatch)
	}
	if trimmed[0] == '[' || trimmed[0] == '{' {
		diff, err := ParseJSONPatch(trimmed)
		if err != nil {
			return nil, err
		}
		return ApplyJSONDiff(base, diff)
	}
	diff, err := DecodeMySQLJSONDiff(raw)
	if err != nil {
		return nil, err
	}
	return ApplyJSONDiff(base, diff)
}

// ParseJSONPatch parses an operation array. An object with "operations",
// "ops" or "op" is also accepted for adapters that wrap the operation list.
func ParseJSONPatch(data []byte) (JSONDiff, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return JSONDiff{}, fmt.Errorf("%w: empty patch", ErrJSONPatch)
	}
	if trimmed[0] == '[' {
		var ops []JSONOperation
		if err := json.Unmarshal(trimmed, &ops); err != nil {
			return JSONDiff{}, fmt.Errorf("%w: %v", ErrJSONPatch, err)
		}
		if err := validateJSONOps(ops); err != nil {
			return JSONDiff{}, err
		}
		return JSONDiff{Operations: ops}, nil
	}
	if trimmed[0] == '{' {
		var wrapper struct {
			Op         string          `json:"op"`
			Path       string          `json:"path"`
			Value      json.RawMessage `json:"value"`
			Operations []JSONOperation `json:"operations"`
			Ops        []JSONOperation `json:"ops"`
			FullValue  json.RawMessage `json:"full_value"`
		}
		if err := json.Unmarshal(trimmed, &wrapper); err != nil {
			return JSONDiff{}, fmt.Errorf("%w: %v", ErrJSONPatch, err)
		}
		if len(wrapper.Operations) > 0 || len(wrapper.Ops) > 0 {
			ops := append(wrapper.Operations, wrapper.Ops...)
			if err := validateJSONOps(ops); err != nil {
				return JSONDiff{}, err
			}
			return JSONDiff{Operations: ops}, nil
		}
		if wrapper.Op != "" {
			op := JSONOperation{Op: wrapper.Op, Path: wrapper.Path}
			if len(wrapper.Value) > 0 {
				if err := json.Unmarshal(wrapper.Value, &op.Value); err != nil {
					return JSONDiff{}, fmt.Errorf("%w: %v", ErrJSONPatch, err)
				}
			}
			if err := validateJSONOps([]JSONOperation{op}); err != nil {
				return JSONDiff{}, err
			}
			return JSONDiff{Operations: []JSONOperation{op}}, nil
		}
		if len(wrapper.FullValue) > 0 {
			var value any
			if err := json.Unmarshal(wrapper.FullValue, &value); err != nil {
				return JSONDiff{}, fmt.Errorf("%w: %v", ErrJSONPatch, err)
			}
			return JSONDiff{FullValue: value, HasFullValue: true}, nil
		}
	}
	return JSONDiff{}, fmt.Errorf("%w: expected an operation array", ErrJSONPatch)
}

func validateJSONOps(ops []JSONOperation) error {
	for i, op := range ops {
		switch strings.ToLower(strings.TrimSpace(jsonOperationName(op))) {
		case "", "add", "insert", "replace", "set", "remove", "delete", "merge":
		default:
			return fmt.Errorf("%w: operation %d has unsupported op %q", ErrJSONPatch, i, op.Op)
		}
	}
	return nil
}

// IsJSONDiff reports whether v explicitly carries a partial JSON diff.
func IsJSONDiff(v any) (JSONDiff, bool) {
	switch typed := v.(type) {
	case JSONDiff:
		return typed, true
	case *JSONDiff:
		if typed == nil {
			return JSONDiff{}, false
		}
		return *typed, true
	case []JSONOperation:
		return JSONDiff{Operations: typed}, true
	case JSONOperation:
		return JSONDiff{Operations: []JSONOperation{typed}}, true
	default:
		return JSONDiff{}, false
	}
}

func jsonDiffReplacesRoot(diff JSONDiff) bool {
	if diff.HasFullValue {
		return true
	}
	ops, err := diff.operations()
	if err != nil || len(ops) == 0 {
		return false
	}
	for _, op := range ops {
		tokens, err := parseJSONPath(op.Path)
		if err != nil || len(tokens) != 0 {
			return false
		}
		switch strings.ToLower(strings.TrimSpace(jsonOperationName(op))) {
		case "replace", "set", "add", "insert":
		default:
			return false
		}
	}
	return true
}

// JSONDiffFromAny converts the common adapter representations of a partial
// update (JSONDiff, an operation slice, a patch object, or a textual patch)
// into a JSONDiff.
func JSONDiffFromAny(value any) (JSONDiff, bool) {
	if diff, ok := IsJSONDiff(value); ok {
		return diff, true
	}
	switch typed := value.(type) {
	case map[string]any:
		op := stringValue(typed, "op")
		if op == "" {
			op = stringValue(typed, "type")
		}
		path := stringValue(typed, "path")
		_, hasPath := lookupMapKey(typed, "path")
		if op != "" && hasPath {
			operation := JSONOperation{Op: op, Path: path, From: stringValue(typed, "from")}
			if raw, ok := lookupMapKey(typed, "value"); ok {
				operation.Value = raw
			}
			return JSONDiff{Operations: []JSONOperation{operation}}, true
		}
		for _, key := range []string{"operations", "ops"} {
			if raw, ok := lookupMapKey(typed, key); ok {
				data, err := json.Marshal(raw)
				if err == nil {
					if diff, parseErr := ParseJSONPatch(data); parseErr == nil {
						return diff, true
					}
				}
			}
		}
		if raw, ok := lookupMapKey(typed, "full_value"); ok {
			return JSONDiff{FullValue: raw, HasFullValue: true}, true
		}
	case []any:
		if len(typed) == 0 {
			return JSONDiff{}, false
		}
		if _, ok := typed[0].(map[string]any); !ok {
			return JSONDiff{}, false
		}
		data, err := json.Marshal(typed)
		if err != nil {
			return JSONDiff{}, false
		}
		diff, err := ParseJSONPatch(data)
		if err != nil {
			return JSONDiff{}, false
		}
		return diff, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{") {
			diff, err := ParseJSONPatch([]byte(trimmed))
			if err == nil {
				return diff, true
			}
		}
	case []byte:
		trimmed := bytes.TrimSpace(typed)
		if len(trimmed) > 0 && (trimmed[0] == '[' || trimmed[0] == '{') {
			diff, err := ParseJSONPatch(trimmed)
			if err == nil {
				return diff, true
			}
		}
	case json.RawMessage:
		trimmed := bytes.TrimSpace(typed)
		if len(trimmed) > 0 && (trimmed[0] == '[' || trimmed[0] == '{') {
			diff, err := ParseJSONPatch(trimmed)
			if err == nil {
				return diff, true
			}
		}
	}
	return JSONDiff{}, false
}

func stringValue(values map[string]any, key string) string {
	if raw, ok := lookupMapKey(values, key); ok {
		if text, ok := raw.(string); ok {
			return text
		}
	}
	return ""
}

func lookupMapKey(values map[string]any, key string) (any, bool) {
	if value, ok := values[key]; ok {
		return value, true
	}
	for candidate, value := range values {
		if strings.EqualFold(candidate, key) {
			return value, true
		}
	}
	return nil, false
}

type jsonPathToken struct {
	value string
}

func parseJSONPath(path string) ([]jsonPathToken, error) {
	path = strings.TrimSpace(path)
	if path == "" || path == "$" {
		return nil, nil
	}
	if strings.HasPrefix(path, "/") {
		parts := strings.Split(path[1:], "/")
		tokens := make([]jsonPathToken, 0, len(parts))
		for _, part := range parts {
			part = strings.ReplaceAll(part, "~1", "/")
			part = strings.ReplaceAll(part, "~0", "~")
			tokens = append(tokens, jsonPathToken{value: part})
		}
		return tokens, nil
	}

	if !strings.HasPrefix(path, "$") {
		if path[0] != '.' && path[0] != '[' {
			path = "." + path
		}
		path = "$" + path
	}

	var tokens []jsonPathToken
	i := 1
	for i < len(path) {
		switch path[i] {
		case '.':
			i++
			if i >= len(path) {
				return nil, fmt.Errorf("trailing dot in path %q", path)
			}
			if path[i] == '"' {
				value, next, err := parseQuotedPathSegment(path, i)
				if err != nil {
					return nil, err
				}
				tokens = append(tokens, jsonPathToken{value: value})
				i = next
				continue
			}
			start := i
			for i < len(path) && path[i] != '.' && path[i] != '[' {
				i++
			}
			if start == i {
				return nil, fmt.Errorf("empty path segment in %q", path)
			}
			tokens = append(tokens, jsonPathToken{value: path[start:i]})
		case '[':
			end := strings.IndexByte(path[i+1:], ']')
			if end < 0 {
				return nil, fmt.Errorf("unterminated bracket in path %q", path)
			}
			end += i + 1
			segment := strings.TrimSpace(path[i+1 : end])
			if len(segment) >= 2 && (segment[0] == '"' || segment[0] == '\'') {
				quote := segment[0]
				if segment[len(segment)-1] != quote {
					return nil, fmt.Errorf("unterminated quoted key in path %q", path)
				}
				tokens = append(tokens, jsonPathToken{value: unescapePathString(segment[1 : len(segment)-1])})
			} else {
				if segment == "" {
					return nil, fmt.Errorf("empty bracket in path %q", path)
				}
				tokens = append(tokens, jsonPathToken{value: segment})
			}
			i = end + 1
		default:
			return nil, fmt.Errorf("unexpected character %q in path %q", path[i], path)
		}
	}
	return tokens, nil
}

func parseQuotedPathSegment(path string, start int) (string, int, error) {
	var b strings.Builder
	for i := start + 1; i < len(path); i++ {
		switch path[i] {
		case '\\':
			if i+1 >= len(path) {
				return "", 0, fmt.Errorf("trailing escape in path %q", path)
			}
			i++
			b.WriteByte(path[i])
		case '"':
			return b.String(), i + 1, nil
		default:
			b.WriteByte(path[i])
		}
	}
	return "", 0, fmt.Errorf("unterminated quoted key in path %q", path)
}

func unescapePathString(value string) string {
	value = strings.ReplaceAll(value, "\\\"", "\"")
	value = strings.ReplaceAll(value, "\\'", "'")
	value = strings.ReplaceAll(value, "\\\\", "\\")
	return value
}

func applyJSONOperation(root any, tokens []jsonPathToken, op string, value any) (any, error) {
	if root == nil {
		root = newJSONContainer(tokens)
	}
	token := tokens[0]
	switch node := root.(type) {
	case map[string]any:
		key := token.value
		if len(tokens) == 1 {
			switch op {
			case "remove", "delete":
				if _, ok := node[key]; !ok {
					return nil, fmt.Errorf("%w: cannot remove missing path %q", ErrJSONPatch, key)
				}
				delete(node, key)
			case "merge":
				merged, err := mergeJSONValue(node[key], value)
				if err != nil {
					return nil, err
				}
				node[key] = merged
			default:
				node[key] = cloneJSONValue(value)
			}
			return node, nil
		}
		child, exists := node[key]
		if !exists {
			if op == "remove" || op == "delete" {
				return nil, fmt.Errorf("%w: cannot remove missing path %q", ErrJSONPatch, key)
			}
			child = nil
		}
		newChild, err := applyJSONOperation(child, tokens[1:], op, value)
		if err != nil {
			return nil, err
		}
		node[key] = newChild
		return node, nil
	case []any:
		index, err := jsonArrayIndex(token.value, len(node), op)
		if err != nil {
			return nil, err
		}
		if len(tokens) == 1 {
			switch op {
			case "remove", "delete":
				if index < 0 || index >= len(node) {
					return nil, fmt.Errorf("%w: array index %d out of range", ErrJSONPatch, index)
				}
				node = append(node[:index], node[index+1:]...)
			case "add", "insert":
				node = insertJSONArray(node, index, value)
			case "merge":
				merged, err := mergeJSONValue(node[index], value)
				if err != nil {
					return nil, err
				}
				node[index] = merged
			default:
				if index == len(node) {
					node = append(node, cloneJSONValue(value))
				} else if index >= 0 && index < len(node) {
					node[index] = cloneJSONValue(value)
				} else {
					return nil, fmt.Errorf("%w: array index %d out of range", ErrJSONPatch, index)
				}
			}
			return node, nil
		}
		if index < 0 || index >= len(node) {
			if (op == "add" || op == "insert") && index == len(node) {
				node = append(node, newJSONContainer(tokens[1:]))
			} else {
				return nil, fmt.Errorf("%w: array index %d out of range", ErrJSONPatch, index)
			}
		}
		newChild, err := applyJSONOperation(node[index], tokens[1:], op, value)
		if err != nil {
			return nil, err
		}
		node[index] = newChild
		return node, nil
	default:
		// A scalar cannot be traversed. Replacing it with the container type
		// implied by the path is only valid for set/add operations.
		if op == "set" || op == "replace" || op == "add" || op == "insert" {
			container := newJSONContainer(tokens)
			return applyJSONOperation(container, tokens, op, value)
		}
		return nil, fmt.Errorf("%w: cannot traverse %T at %q", ErrJSONPatch, root, token.value)
	}
}

func newJSONContainer(tokens []jsonPathToken) any {
	if len(tokens) == 0 {
		return nil
	}
	if _, ok := jsonTokenIndex(tokens[0].value); ok {
		return []any{}
	}
	return map[string]any{}
}

func jsonTokenIndex(value string) (int, bool) {
	if value == "-" {
		return -1, true
	}
	index, err := strconv.Atoi(value)
	if err != nil || index < 0 {
		return 0, false
	}
	return index, true
}

func jsonArrayIndex(value string, length int, op string) (int, error) {
	if value == "-" {
		if op == "add" || op == "insert" {
			return length, nil
		}
		return 0, fmt.Errorf("%w: '-' is only valid for add/insert", ErrJSONPatch)
	}
	index, err := strconv.Atoi(value)
	if err != nil || index < 0 {
		return 0, fmt.Errorf("%w: invalid array index %q", ErrJSONPatch, value)
	}
	return index, nil
}

func insertJSONArray(values []any, index int, value any) []any {
	if index < 0 {
		index = 0
	}
	if index > len(values) {
		index = len(values)
	}
	values = append(values, nil)
	copy(values[index+1:], values[index:])
	values[index] = cloneJSONValue(value)
	return values
}

func mergeJSONValue(target, patch any) (any, error) {
	if patch == nil {
		return nil, nil
	}
	patchMap, ok := patch.(map[string]any)
	if !ok {
		return cloneJSONValue(patch), nil
	}
	targetMap, ok := target.(map[string]any)
	if !ok {
		targetMap = make(map[string]any)
	}
	for key, value := range patchMap {
		merged, err := mergeJSONValue(targetMap[key], value)
		if err != nil {
			return nil, err
		}
		targetMap[key] = merged
	}
	return targetMap, nil
}

func cloneJSONValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = cloneJSONValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = cloneJSONValue(item)
		}
		return out
	case json.RawMessage:
		var decoded any
		if err := json.Unmarshal(typed, &decoded); err == nil {
			return decoded
		}
		return append(json.RawMessage(nil), typed...)
	default:
		return value
	}
}
