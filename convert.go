package dataeng

import (
	"encoding/json"
	"fmt"
)

// asInt 容忍 JSON 解码后数字的 float64 / json.Number / int 多种形态。
func asInt(v any) int {
	switch n := v.(type) {
	case nil:
		return 0
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	case string:
		var i int
		_, _ = fmt.Sscanf(n, "%d", &i)
		return i
	default:
		return 0
	}
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

// asPairs 把 headers/cookies/queryString 之类字段统一成 HAR 名值对，
// 同时容忍 map 形态与 [{name,value}] 形态。
func asPairs(v any) []NameValuePair {
	switch t := v.(type) {
	case nil:
		return nil
	case []any:
		out := make([]NameValuePair, 0, len(t))
		for _, item := range t {
			if m, ok := item.(map[string]any); ok {
				out = append(out, NameValuePair{
					Name:  asString(m["name"]),
					Value: asString(m["value"]),
				})
			}
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		out := make([]NameValuePair, 0, len(keys))
		for _, k := range keys {
			out = append(out, NameValuePair{Name: k, Value: asString(t[k])})
		}
		return out
	case []NameValuePair:
		return append([]NameValuePair(nil), t...)
	default:
		return nil
	}
}
