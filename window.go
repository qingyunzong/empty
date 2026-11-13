package dataeng

import (
	"fmt"
	"strings"
)

// WindowKind identifies the supported event-time window assigners.
type WindowKind uint8

const (
	KindTumbling WindowKind = iota + 1
	KindSliding
	KindSession
)

// String returns the lower-case name of the window kind.
func (k WindowKind) String() string {
	switch k {
	case KindTumbling:
		return "tumbling"
	case KindSliding:
		return "sliding"
	case KindSession:
		return "session"
	default:
		return fmt.Sprintf("WindowKind(%d)", uint8(k))
	}
}

// Window is a half-open event-time interval [Start, End). End is exclusive.
type Window struct {
	Start int64
	End   int64
}

// Contains reports whether ts belongs to the window.
func (w Window) Contains(ts int64) bool {
	return ts >= w.Start && ts < w.End
}

func (w Window) String() string {
	return fmt.Sprintf("[%d,%d)", w.Start, w.End)
}

// WindowSpec describes one of the three supported assigners:
//
//   - Tumbling: fixed Size, windows are aligned to multiples of Size.
//   - Sliding: fixed Size and Slide, windows start at multiples of Slide.
//   - Session: one or more gap-delimited intervals per partition and key.
//
// Tumbling and sliding windows use the half-open interval [Start, End). A
// sliding specification with Size < Slide leaves gaps between windows; events
// that fall into a gap are routed to the side output with SideOutputNoWindow.
type WindowSpec struct {
	Kind  WindowKind
	Size  int64
	Slide int64
	Gap   int64
}

// Tumbling returns a tumbling window specification of the given size.
func Tumbling(size int64) WindowSpec {
	return WindowSpec{Kind: KindTumbling, Size: size}
}

// Sliding returns a sliding window specification of the given size and slide.
func Sliding(size, slide int64) WindowSpec {
	return WindowSpec{Kind: KindSliding, Size: size, Slide: slide}
}

// Session returns a session window specification with the given inactivity gap.
func Session(gap int64) WindowSpec {
	return WindowSpec{Kind: KindSession, Gap: gap}
}

// Validate checks that the specification is usable.
func (s WindowSpec) Validate() error {
	switch s.Kind {
	case KindTumbling:
		if s.Size <= 0 {
			return fmt.Errorf("%w: tumbling size must be positive, got %d", ErrInvalidWindowSpec, s.Size)
		}
		if s.Slide != 0 || s.Gap != 0 {
			return fmt.Errorf("%w: tumbling windows only use Size", ErrInvalidWindowSpec)
		}
	case KindSliding:
		if s.Size <= 0 {
			return fmt.Errorf("%w: sliding size must be positive, got %d", ErrInvalidWindowSpec, s.Size)
		}
		if s.Slide <= 0 {
			return fmt.Errorf("%w: sliding slide must be positive, got %d", ErrInvalidWindowSpec, s.Slide)
		}
		if s.Gap != 0 {
			return fmt.Errorf("%w: sliding windows do not use Gap", ErrInvalidWindowSpec)
		}
	case KindSession:
		if s.Gap <= 0 {
			return fmt.Errorf("%w: session gap must be positive, got %d", ErrInvalidWindowSpec, s.Gap)
		}
		if s.Size != 0 || s.Slide != 0 {
			return fmt.Errorf("%w: session windows only use Gap", ErrInvalidWindowSpec)
		}
	default:
		return fmt.Errorf("%w: unknown kind %d", ErrInvalidWindowSpec, uint8(s.Kind))
	}
	return nil
}

func (s WindowSpec) String() string {
	switch s.Kind {
	case KindTumbling:
		return fmt.Sprintf("tumbling(size=%d)", s.Size)
	case KindSliding:
		return fmt.Sprintf("sliding(size=%d,slide=%d)", s.Size, s.Slide)
	case KindSession:
		return fmt.Sprintf("session(gap=%d)", s.Gap)
	default:
		return fmt.Sprintf("WindowSpec(kind=%d)", uint8(s.Kind))
	}
}

// Assign returns the windows a timestamp belongs to for a fixed (tumbling or
// sliding) specification. Session windows are key-scoped and are assigned by
// the operator, so Assign returns the initial [ts, ts+Gap) session interval.
// An invalid specification returns nil.
func (s WindowSpec) Assign(ts int64) []Window {
	if s.Validate() != nil {
		return nil
	}
	switch s.Kind {
	case KindTumbling:
		start := floorDiv(ts, s.Size) * s.Size
		return []Window{{Start: start, End: start + s.Size}}
	case KindSliding:
		return slidingWindows(ts, s.Size, s.Slide)
	case KindSession:
		return []Window{{Start: ts, End: ts + s.Gap}}
	default:
		return nil
	}
}

func slidingWindows(ts, size, slide int64) []Window {
	base := floorDiv(ts, slide) * slide
	var windows []Window
	for start := base; start+size > ts; start -= slide {
		windows = append(windows, Window{Start: start, End: start + size})
	}
	// The loop walks backwards, so reverse into ascending order.
	for i, j := 0, len(windows)-1; i < j; i, j = i+1, j-1 {
		windows[i], windows[j] = windows[j], windows[i]
	}
	return windows
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func windowSpecsEqual(a, b WindowSpec) bool {
	return a.Kind == b.Kind && a.Size == b.Size && a.Slide == b.Slide && a.Gap == b.Gap
}

func windowsString(windows []Window) string {
	parts := make([]string, len(windows))
	for i, w := range windows {
		parts[i] = w.String()
	}
	return "[" + strings.Join(parts, ",") + "]"
}
