package logcompact

import (
	"reflect"
	"testing"
)

// model is the full-retention reference: it keeps every entry ever
// appended and never reclaims anything. The compacted log must answer
// reads for any live pin exactly like the model does.
type model struct {
	entries []Entry
}

func (m *model) append(e Entry) {
	m.entries = append(m.entries, e)
}

func (m *model) scanFrom(seq uint64) []Entry {
	var out []Entry
	for _, e := range m.entries {
		if e.Seq >= seq {
			out = append(out, e)
		}
	}
	return out
}

func (m *model) stateAt(ver uint64) map[string]string {
	out := make(map[string]string)
	for _, e := range m.entries {
		if e.Seq <= ver {
			out[e.Key] = e.Value
		}
	}
	return out
}

// assertPinReads checks that every live pin of l reads exactly like the
// full-retention model.
func assertPinReads(t *testing.T, l *Log, m *model) {
	t.Helper()
	for _, p := range l.Pins() {
		gotScan, err := l.ScanFrom(p.Ver)
		if err != nil {
			t.Fatalf("pin %+v: ScanFrom(%d): %v", p, p.Ver, err)
		}
		if want := m.scanFrom(p.Ver); !reflect.DeepEqual(gotScan, want) {
			t.Fatalf("pin %+v: ScanFrom(%d) = %v, want %v", p, p.Ver, gotScan, want)
		}
		gotState, err := l.StateAt(p.Ver)
		if err != nil {
			t.Fatalf("pin %+v: StateAt(%d): %v", p, p.Ver, err)
		}
		if want := m.stateAt(p.Ver); !reflect.DeepEqual(gotState, want) {
			t.Fatalf("pin %+v: StateAt(%d) = %v, want %v", p, p.Ver, gotState, want)
		}
	}
}

func assertStateAt(t *testing.T, l *Log, m *model, ver uint64) {
	t.Helper()
	got, err := l.StateAt(ver)
	if err != nil {
		t.Fatalf("StateAt(%d): %v", ver, err)
	}
	if want := m.stateAt(ver); !reflect.DeepEqual(got, want) {
		t.Fatalf("StateAt(%d) = %v, want %v", ver, got, want)
	}
}
