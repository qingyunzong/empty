package q204

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type nodeSet map[*ruleNode]struct{}

func (rs *RuleSet) deidentify(value any, key []byte) (any, error) {
	if rs == nil || rs.root == nil {
		return cloneValue(value), nil
	}
	result, deleted, err := rs.process(nodeSet{rs.root: {}}, value, nil, key)
	if err != nil {
		return nil, err
	}
	if deleted {
		return nil, nil
	}
	return result, nil
}

func (rs *RuleSet) process(nodes nodeSet, value any, path []string, key []byte) (any, bool, error) {
	if selected, ambiguous := bestAction(nodes); ambiguous {
		return nil, false, &AmbiguousMatchError{Path: displayPath(path)}
	} else if selected != nil {
		return applyAction(*selected, value, path, key)
	}

	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for name := range v {
			keys = append(keys, name)
		}
		sort.Strings(keys)
		for _, name := range keys {
			next := nextMapNodes(nodes, name)
			if len(next) == 0 {
				continue
			}
			item, removed, err := rs.process(next, v[name], appendPath(path, name), key)
			if err != nil {
				return nil, false, err
			}
			if removed {
				delete(v, name)
			} else {
				v[name] = item
			}
		}
		return v, false, nil
	case []any:
		if len(v) == 0 {
			return v, false, nil
		}
		out := make([]any, 0, len(v))
		for i, item := range v {
			next := nextArrayNodes(nodes, i)
			transformed, removed, err := rs.process(next, item, appendIndex(path, i), key)
			if err != nil {
				return nil, false, err
			}
			if !removed {
				out = append(out, transformed)
			}
		}
		return out, false, nil
	default:
		return v, false, nil
	}
}

func bestAction(nodes nodeSet) (*compiledAction, bool) {
	var best *compiledAction
	ambiguous := false
	for node := range nodes {
		action := node.action
		if action == nil {
			continue
		}
		if best == nil || action.literals > best.literals {
			best = action
			ambiguous = false
			continue
		}
		if action.literals == best.literals && !action.action.equal(best.action) {
			ambiguous = true
		}
	}
	return best, ambiguous
}

func nextMapNodes(nodes nodeSet, name string) nodeSet {
	next := make(nodeSet, len(nodes))
	for node := range nodes {
		if child := node.literal[name]; child != nil {
			next[child] = struct{}{}
		}
		if node.wildcard != nil {
			next[node.wildcard] = struct{}{}
		}
	}
	return next
}

func nextArrayNodes(nodes nodeSet, index int) nodeSet {
	// Arrays are transparent: a path may continue directly into an element.
	// A wildcard or a literal decimal segment can also consume the element as
	// one path segment.
	next := make(nodeSet, len(nodes)*2)
	indexKey := strconv.Itoa(index)
	for node := range nodes {
		next[node] = struct{}{}
		if node.wildcard != nil {
			next[node.wildcard] = struct{}{}
		}
		if child := node.literal[indexKey]; child != nil {
			next[child] = struct{}{}
		}
	}
	return next
}

func applyAction(action compiledAction, value any, path []string, key []byte) (any, bool, error) {
	switch action.action.Type {
	case ActionDelete:
		if array, ok := value.([]any); ok {
			if len(array) == 0 {
				return array, false, nil
			}
			return []any{}, false, nil
		}
		return nil, true, nil
	case ActionReplace:
		return replaceValue(value, action.action.Replacement), false, nil
	case ActionHMAC:
		return hmacValue(value, key, path)
	default:
		return nil, false, fmt.Errorf("%w: unknown compiled action %q", ErrInvalidConfig, action.action.Type)
	}
}

func replaceValue(value any, replacement string) any {
	if array, ok := value.([]any); ok {
		if len(array) == 0 {
			return array
		}
		out := make([]any, len(array))
		for i, item := range array {
			out[i] = replaceValue(item, replacement)
		}
		return out
	}
	return replacement
}

func hmacValue(value any, key []byte, path []string) (any, bool, error) {
	switch v := value.(type) {
	case string:
		return hmacHex(key, v), false, nil
	case []any:
		if len(v) == 0 {
			return v, false, nil
		}
		out := make([]any, len(v))
		for i, item := range v {
			transformed, _, err := hmacValue(item, key, appendIndex(path, i))
			if err != nil {
				return nil, false, err
			}
			out[i] = transformed
		}
		return out, false, nil
	default:
		return nil, false, &ValueTypeError{Path: displayPath(path)}
	}
}

func hmacHex(key []byte, value string) string {
	digest := hmac.New(sha256.New, key)
	_, _ = digest.Write([]byte(value))
	return hex.EncodeToString(digest.Sum(nil))
}

func appendPath(path []string, key string) []string {
	out := make([]string, len(path)+1)
	copy(out, path)
	out[len(path)] = key
	return out
}

func appendIndex(path []string, index int) []string {
	out := make([]string, len(path)+1)
	copy(out, path)
	out[len(path)] = "[" + strconv.Itoa(index) + "]"
	return out
}

func displayPath(path []string) string {
	if len(path) == 0 {
		return "<root>"
	}
	var builder strings.Builder
	for i, segment := range path {
		if strings.HasPrefix(segment, "[") {
			builder.WriteString(segment)
			continue
		}
		if i > 0 {
			builder.WriteByte('.')
		}
		builder.WriteString(segment)
	}
	return builder.String()
}
