package dataeng

import "testing"

func TestStateRoundTrip(t *testing.T) {
	st := State{Cursor: "s=abc;i=1", BootID: "boot-a", Realtime: 1700000000000000, Monotonic: 12345}
	data, err := st.Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got, err := ParseState(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got != st {
		t.Fatalf("round trip mismatch: got %+v want %+v", got, st)
	}
}

func TestParseStateEmpty(t *testing.T) {
	st, err := ParseState(nil)
	if err != nil {
		t.Fatalf("parse nil: %v", err)
	}
	if !st.IsZero() {
		t.Fatalf("expected zero state, got %+v", st)
	}
}

func TestStateValidate(t *testing.T) {
	cases := []struct {
		name    string
		st      State
		wantErr bool
	}{
		{"zero ok", State{}, false},
		{"full ok", State{Cursor: "c", Realtime: 1}, false},
		{"missing cursor", State{Realtime: 1}, true},
		{"missing realtime", State{Cursor: "c"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.st.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate() err=%v, wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestCoveredByState(t *testing.T) {
	st := State{Cursor: "c", BootID: "boot-a", Realtime: 100, Monotonic: 50}
	cases := []struct {
		name string
		e    *Entry
		want bool
	}{
		{"older realtime", entry("boot-a", 99, 999, ""), true},
		{"newer realtime", entry("boot-a", 101, 1, ""), false},
		{"same boot older monotonic", entry("boot-a", 100, 40, ""), true},
		{"same boot equal monotonic", entry("boot-a", 100, 50, ""), true},
		{"same boot newer monotonic", entry("boot-a", 100, 60, ""), false},
		// 跨 boot 不比较单调时间：realtime 相同即无法证明已覆盖。
		{"other boot same realtime", entry("boot-b", 100, 1, ""), false},
		{"other boot older realtime", entry("boot-b", 90, 999999, ""), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := coveredByState(st, tc.e); got != tc.want {
				t.Fatalf("coveredByState() = %v, want %v", got, tc.want)
			}
		})
	}
}
