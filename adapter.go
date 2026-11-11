package q207

import "strings"

// Backend adapters simulate the two parser families found behind the
// gateway: first-value-wins (e.g. Go's url.Values.Get) and
// last-value-wins (e.g. PHP/ Rack style). They parse the canonical query
// the same way a backend would: split on '&' and the first '=', decode
// percent escapes once, treat '+' as space, and silently skip segments
// they cannot decode.

func backendParse(q string) map[string][]string {
	vals := make(map[string][]string)
	rest := q
	for rest != "" {
		seg := rest
		if i := strings.IndexByte(rest, '&'); i >= 0 {
			seg, rest = rest[:i], rest[i+1:]
		} else {
			rest = ""
		}
		if seg == "" {
			continue
		}
		k, v, _ := strings.Cut(seg, "=")
		dk, err := decodeOnce(k)
		if err != nil {
			continue
		}
		dv, err := decodeOnce(v)
		if err != nil {
			continue
		}
		vals[dk] = append(vals[dk], dv)
	}
	return vals
}

// AllValuesAdapter parses q and keeps every value of each key in order,
// like Go's url.Values.
func AllValuesAdapter(q string) map[string][]string {
	return backendParse(q)
}

// FirstValueAdapter parses q and keeps the first value of each key,
// like Go's url.Values.Get.
func FirstValueAdapter(q string) map[string]string {
	out := make(map[string]string)
	for k, vs := range backendParse(q) {
		out[k] = vs[0]
	}
	return out
}

// LastValueAdapter parses q and keeps the last value of each key,
// like PHP's $_GET.
func LastValueAdapter(q string) map[string]string {
	out := make(map[string]string)
	for k, vs := range backendParse(q) {
		out[k] = vs[len(vs)-1]
	}
	return out
}
