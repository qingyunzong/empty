package dataeng

import (
	"sort"
	"strconv"
	"strings"
)

// Labels is a label set as commonly found in the Prometheus remote-write
// protobuf. Maps do not have an order, so all identities in this package are
// built from a canonical form.
type Labels map[string]string

// Label is a single canonicalized label.
type Label struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Clone returns an independent copy of the label set.
func (l Labels) Clone() Labels {
	if l == nil {
		return nil
	}
	out := make(Labels, len(l))
	for k, v := range l {
		out[k] = v
	}
	return out
}

// Canonical returns the labels sorted by name. Values are never reordered
// relative to their names.
func (l Labels) Canonical() []Label {
	return CanonicalizeLabels(l)
}

// Key returns a collision-free, deterministic representation of the label set.
func (l Labels) Key() string {
	return KeyForLabels(l)
}

// CanonicalizeLabels returns the labels in canonical order.
func CanonicalizeLabels(labels map[string]string) []Label {
	out := make([]Label, 0, len(labels))
	for name, value := range labels {
		out = append(out, Label{Name: name, Value: value})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Value < out[j].Value
	})
	return out
}

// CanonicalLabels returns a copy of labels. Map equality is order independent,
// so this helper exists mainly to make normalization explicit at an ingress
// boundary.
func CanonicalLabels(labels map[string]string) Labels {
	if labels == nil {
		return nil
	}
	out := make(Labels, len(labels))
	for _, label := range CanonicalizeLabels(labels) {
		out[label.Name] = label.Value
	}
	return out
}

// KeyForLabels returns a deterministic, unambiguous key. Names and values are
// length-prefixed so that, for example, {"a":"bc"} and {"ab":"c"} cannot
// produce the same key.
func KeyForLabels(labels map[string]string) string {
	canonical := CanonicalizeLabels(labels)
	var b strings.Builder
	for _, label := range canonical {
		b.WriteString(strconv.Itoa(len(label.Name)))
		b.WriteByte(':')
		b.WriteString(label.Name)
		b.WriteByte('=')
		b.WriteString(strconv.Itoa(len(label.Value)))
		b.WriteByte(':')
		b.WriteString(label.Value)
		b.WriteByte(';')
	}
	return b.String()
}

// CanonicalLabelKey is an alias for KeyForLabels.
func CanonicalLabelKey(labels map[string]string) string {
	return KeyForLabels(labels)
}

// LabelsKey is an alias for KeyForLabels.
func LabelsKey(labels map[string]string) string {
	return KeyForLabels(labels)
}

func withoutLabels(labels Labels, remove map[string]struct{}) Labels {
	if len(remove) == 0 {
		return CanonicalLabels(labels)
	}
	out := make(Labels, len(labels))
	for name, value := range labels {
		if _, ok := remove[name]; ok {
			continue
		}
		out[name] = value
	}
	return out
}
