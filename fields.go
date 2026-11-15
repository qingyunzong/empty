package dataeng

import "encoding/json"

var knownRequestFields = map[string]struct{}{
	"method": {}, "url": {}, "httpVersion": {}, "headers": {}, "cookies": {},
	"queryString": {}, "postDataMIME": {}, "headersSize": {}, "bodySize": {},
}

var knownResponseFields = map[string]struct{}{
	"status": {}, "statusText": {}, "httpVersion": {}, "headers": {}, "cookies": {},
	"mimeType": {}, "contentSize": {}, "redirectURL": {}, "headersSize": {},
	"bodySize": {},
}

func decodeRequest(fields map[string]any) *RequestInfo {
	if len(fields) == 0 {
		return nil
	}
	out := &RequestInfo{Extra: map[string]any{}}
	decodeFields(fields, out, knownRequestFields, out.Extra)
	return out
}

func decodeResponse(fields map[string]any) *ResponseInfo {
	if len(fields) == 0 {
		return nil
	}
	out := &ResponseInfo{Extra: map[string]any{}}
	decodeFields(fields, out, knownResponseFields, out.Extra)
	return out
}

// decodeFields 先整体反序列化到类型化结构，再把未知键收集到 extra 透传。
func decodeFields(fields map[string]any, typed any, known map[string]struct{}, extra map[string]any) {
	data, err := json.Marshal(fields)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, typed)
	for k, v := range fields {
		if _, ok := known[k]; !ok {
			extra[k] = v
		}
	}
	if len(extra) == 0 {
		if e, ok := typed.(*RequestInfo); ok {
			e.Extra = nil
		}
		if e, ok := typed.(*ResponseInfo); ok {
			e.Extra = nil
		}
	}
}

// mergeFields 把 src 合并进 dst；同键以 src 为准，未知键原样保留。
func mergeFields(dst, src map[string]any) map[string]any {
	if dst == nil {
		dst = make(map[string]any, len(src))
	}
	for k, v := range src {
		dst[k] = v
	}
	return dst
}
