package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

var (
	// ErrCursorOutOfRange reports a UTF-16 position outside [0, length].
	ErrCursorOutOfRange = errors.New("dataeng: UTF-16 cursor position out of range")
	// ErrInvalidSegmentation reports cluster spans that are not a valid,
	// gap-free segmentation of one continuous text.
	ErrInvalidSegmentation = errors.New("dataeng: invalid grapheme segmentation")
)

// CursorRangeError reports a rejected cursor position. Length is the total
// UTF-16 length of the segmented text.
type CursorRangeError struct {
	Position int
	Length   int
}

func (e *CursorRangeError) Error() string {
	return fmt.Sprintf(
		"dataeng: UTF-16 cursor position %d outside [0,%d]",
		e.Position, e.Length,
	)
}

func (e *CursorRangeError) Unwrap() error { return ErrCursorOutOfRange }

// UTF16CursorMap is an immutable boundary lookup built from a valid sequence
// of grapheme clusters. It allows arbitrary UTF-16 cursor positions, including
// positions inside a surrogate pair, to be snapped without splitting a
// cluster.
type UTF16CursorMap struct {
	boundaries []int
	length     int
}

// NewUTF16CursorMap validates clusters and builds a cursor map. Spans must
// start at zero and be contiguous in both byte and UTF-16 coordinates. Each
// cluster's Text must match its byte span and contain exactly the number of
// UTF-16 code units in its UTF-16 span.
func NewUTF16CursorMap(clusters []Grapheme) (*UTF16CursorMap, error) {
	boundaries := make([]int, 1, len(clusters)+1)
	nextByte := 0
	nextUTF16 := 0

	for i, cluster := range clusters {
		if cluster.ByteStart != nextByte || cluster.ByteEnd <= cluster.ByteStart {
			return nil, invalidCluster(i, "non-contiguous or empty byte span")
		}
		if cluster.UTF16Start != nextUTF16 || cluster.UTF16End <= cluster.UTF16Start {
			return nil, invalidCluster(i, "non-contiguous or empty UTF-16 span")
		}
		if !utf8.ValidString(cluster.Text) {
			return nil, invalidCluster(i, "text is not valid UTF-8")
		}
		if len(cluster.Text) != cluster.ByteEnd-cluster.ByteStart {
			return nil, invalidCluster(i, "text length does not match byte span")
		}
		if units := textUTF16Units(cluster.Text); units != cluster.UTF16End-cluster.UTF16Start {
			return nil, invalidCluster(i, "text width does not match UTF-16 span")
		}

		nextByte = cluster.ByteEnd
		nextUTF16 = cluster.UTF16End
		boundaries = append(boundaries, nextUTF16)
	}

	return &UTF16CursorMap{
		boundaries: boundaries,
		length:     nextUTF16,
	}, nil
}

// Length returns the total UTF-16 length of the segmented text.
func (m *UTF16CursorMap) Length() int {
	return m.length
}

// SnapLeft returns the nearest legal cluster boundary at or before position.
// A position in the middle of a cluster, including the middle of a surrogate
// pair, moves to that cluster's start. A position already on a boundary stays
// unchanged.
func (m *UTF16CursorMap) SnapLeft(position int) (int, error) {
	if err := m.checkPosition(position); err != nil {
		return 0, err
	}
	index := sort.SearchInts(m.boundaries, position)
	if index < len(m.boundaries) && m.boundaries[index] == position {
		return position, nil
	}
	return m.boundaries[index-1], nil
}

// SnapRight returns the nearest legal cluster boundary at or after position.
// A position in the middle of a cluster, including the middle of a surrogate
// pair, moves to that cluster's end. A position already on a boundary stays
// unchanged.
func (m *UTF16CursorMap) SnapRight(position int) (int, error) {
	if err := m.checkPosition(position); err != nil {
		return 0, err
	}
	index := sort.SearchInts(m.boundaries, position)
	if index < len(m.boundaries) && m.boundaries[index] == position {
		return position, nil
	}
	return m.boundaries[index], nil
}

func (m *UTF16CursorMap) checkPosition(position int) error {
	if position < 0 || position > m.length {
		return &CursorRangeError{Position: position, Length: m.length}
	}
	return nil
}

// SnapLeftUTF16 is a convenience wrapper around NewUTF16CursorMap and
// UTF16CursorMap.SnapLeft.
func SnapLeftUTF16(clusters []Grapheme, position int) (int, error) {
	cursorMap, err := NewUTF16CursorMap(clusters)
	if err != nil {
		return 0, err
	}
	return cursorMap.SnapLeft(position)
}

// SnapRightUTF16 is a convenience wrapper around NewUTF16CursorMap and
// UTF16CursorMap.SnapRight.
func SnapRightUTF16(clusters []Grapheme, position int) (int, error) {
	cursorMap, err := NewUTF16CursorMap(clusters)
	if err != nil {
		return 0, err
	}
	return cursorMap.SnapRight(position)
}

func invalidCluster(index int, reason string) error {
	return fmt.Errorf("%w: cluster %d: %s", ErrInvalidSegmentation, index, reason)
}

func textUTF16Units(text string) int {
	units := 0
	for _, r := range text {
		units += utf16Units(r)
	}
	return units
}
