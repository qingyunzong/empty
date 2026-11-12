package dataeng

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Decoder decodes geometry objects using a fixed limit set.
type Decoder struct {
	Limits Limits
}

// NewDecoder returns a decoder using limits. Non-positive limit fields select
// their defaults.
func NewDecoder(limits Limits) *Decoder {
	return &Decoder{Limits: limits}
}

// Decode decodes exactly one top-level geometry object from data using
// DefaultLimits. Any extra bytes after the object are an error.
func Decode(data []byte) (Geometry, error) {
	return DecodeWithLimits(data, DefaultLimits)
}

// DecodeWithLimits decodes exactly one top-level geometry object from data.
// The whole object fails if any nested member fails.
func DecodeWithLimits(data []byte, limits Limits) (Geometry, error) {
	return NewDecoder(limits).Decode(data)
}

// Decode decodes exactly one top-level geometry object from data.
func (d *Decoder) Decode(data []byte) (Geometry, error) {
	limits := d.Limits.normalized()
	state := decodeState{
		data:   data,
		limits: limits,
	}
	geom, err := state.object("$", 0)
	if err != nil {
		return Geometry{}, err
	}
	if state.pos != len(data) {
		return Geometry{}, decodeError("$", state.pos, ErrTrailingData,
			"%d trailing byte(s) after top-level object", len(data)-state.pos)
	}
	return geom, nil
}

type decodeState struct {
	data   []byte
	pos    int
	points int
	limits Limits
}

func (s *decodeState) object(path string, depth int) (Geometry, error) {
	if depth > s.limits.MaxDepth {
		return Geometry{}, decodeError(path, s.pos, ErrDepthLimit,
			"collection depth %d exceeds limit %d", depth, s.limits.MaxDepth)
	}

	headerOffset := s.pos
	if s.remaining() == 0 {
		return Geometry{}, decodeError(path, headerOffset, ErrTruncated,
			"object header is missing")
	}

	marker := s.data[s.pos]
	if marker > 1 {
		return Geometry{}, decodeError(path, s.pos, ErrInvalidByteOrder,
			"byte order marker %d is neither 0 nor 1", marker)
	}
	if s.remaining() < 5 {
		return Geometry{}, decodeError(path, headerOffset, ErrTruncated,
			"object header needs 5 bytes, have %d", s.remaining())
	}
	s.pos++

	orderMarker := ByteOrder(marker)
	var order binary.ByteOrder
	switch orderMarker {
	case BigEndian:
		order = binary.BigEndian
	case LittleEndian:
		order = binary.LittleEndian
	}

	typ := GeometryType(s.uint32(order))
	geom := Geometry{Type: typ, Order: orderMarker}

	switch typ {
	case PointType:
		point, err := s.point(path, order)
		if err != nil {
			return Geometry{}, err
		}
		geom.Point = &point
		return geom, nil

	case LineStringType:
		points, err := s.lineString(path, order)
		if err != nil {
			return Geometry{}, err
		}
		geom.Points = points
		return geom, nil

	case PolygonType:
		rings, err := s.polygon(path, order)
		if err != nil {
			return Geometry{}, err
		}
		geom.Rings = rings
		return geom, nil

	case GeometryCollectionType:
		geometries, err := s.collection(path, depth, order)
		if err != nil {
			return Geometry{}, err
		}
		geom.Geometries = geometries
		return geom, nil

	default:
		return Geometry{}, decodeError(path, headerOffset+1, ErrInvalidType,
			"geometry type %d is not 1, 2, 3, or 7", uint32(typ))
	}
}

func (s *decodeState) point(path string, order binary.ByteOrder) (Point, error) {
	if err := s.consumePoints(path, 1); err != nil {
		return Point{}, err
	}
	point, err := s.readPoint(path, order)
	return point, err
}

func (s *decodeState) lineString(path string, order binary.ByteOrder) ([]Point, error) {
	countOffset := s.pos
	count, err := s.pointCount(path, countOffset, order)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, nil
	}

	points := make([]Point, 0, initialCapacity(count))
	for i := uint32(0); i < count; i++ {
		pointPath := fmt.Sprintf("%s.points[%d]", path, i)
		point, err := s.readPoint(pointPath, order)
		if err != nil {
			return nil, err
		}
		points = append(points, point)
	}
	return points, nil
}

func (s *decodeState) polygon(path string, order binary.ByteOrder) ([]Ring, error) {
	ringCountOffset := s.pos
	ringCount, err := s.uint32Field(path, ringCountOffset, "ring count", order)
	if err != nil {
		return nil, err
	}

	// Each declared ring needs at least its four-byte point count. Reject
	// impossible counts before looping over them.
	if uint64(ringCount) > uint64(s.remaining()/4) {
		return nil, decodeError(path, ringCountOffset, ErrTruncated,
			"ring count %d cannot fit in %d remaining byte(s)", ringCount, s.remaining())
	}
	if ringCount == 0 {
		return nil, nil
	}

	rings := make([]Ring, 0, initialCapacity(ringCount))
	for i := uint32(0); i < ringCount; i++ {
		ringPath := fmt.Sprintf("%s.rings[%d]", path, i)
		pointCountOffset := s.pos
		pointCount, err := s.uint32Field(ringPath, pointCountOffset, "ring point count", order)
		if err != nil {
			return nil, err
		}
		if pointCount < 4 {
			return nil, decodeError(ringPath, pointCountOffset, ErrInvalidRing,
				"ring has %d point(s), need at least 4", pointCount)
		}
		if err := s.consumePoints(ringPath, pointCount); err != nil {
			return nil, err
		}

		ring := make(Ring, 0, initialCapacity(pointCount))
		for j := uint32(0); j < pointCount; j++ {
			pointPath := fmt.Sprintf("%s.points[%d]", ringPath, j)
			point, err := s.readPoint(pointPath, order)
			if err != nil {
				return nil, err
			}
			ring = append(ring, point)
		}
		if ring[0].X != ring[len(ring)-1].X || ring[0].Y != ring[len(ring)-1].Y {
			return nil, decodeError(ringPath, pointCountOffset, ErrRingNotClosed,
				"first and last ring coordinates differ: (%g,%g) vs (%g,%g)",
				ring[0].X, ring[0].Y, ring[len(ring)-1].X, ring[len(ring)-1].Y)
		}
		rings = append(rings, ring)
	}
	return rings, nil
}

func (s *decodeState) collection(path string, depth int, order binary.ByteOrder) ([]Geometry, error) {
	countOffset := s.pos
	count, err := s.uint32Field(path, countOffset, "object count", order)
	if err != nil {
		return nil, err
	}

	// Every nested object starts with a five-byte header. This bound prevents
	// an impossible count from driving a long loop over a short input.
	if uint64(count) > uint64(s.remaining()/5) {
		return nil, decodeError(path, countOffset, ErrTruncated,
			"object count %d cannot fit in %d remaining byte(s)", count, s.remaining())
	}
	if count == 0 {
		return nil, nil
	}

	geometries := make([]Geometry, 0, initialCapacity(count))
	for i := uint32(0); i < count; i++ {
		childPath := fmt.Sprintf("%s.geometries[%d]", path, i)
		child, err := s.object(childPath, depth+1)
		if err != nil {
			return nil, err
		}
		geometries = append(geometries, child)
	}
	return geometries, nil
}

func (s *decodeState) pointCount(path string, offset int, order binary.ByteOrder) (uint32, error) {
	count, err := s.uint32Field(path, offset, "point count", order)
	if err != nil {
		return 0, err
	}
	// Check the configured budget before the input-size bound so an
	// implausibly large declared count is reported as a limit violation rather
	// than merely as a short input.
	if err := s.consumePoints(path, count); err != nil {
		return 0, err
	}
	if uint64(count) > uint64(s.remaining()/16) {
		return 0, decodeError(path, offset, ErrTruncated,
			"point count %d cannot fit in %d remaining byte(s)", count, s.remaining())
	}
	return count, nil
}

func (s *decodeState) consumePoints(path string, count uint32) error {
	if uint64(count) > uint64(s.limits.MaxPoints-s.points) {
		return decodeError(path, s.pos, ErrPointLimit,
			"declared %d point(s) would exceed total limit %d (already %d)",
			count, s.limits.MaxPoints, s.points)
	}
	s.points += int(count)
	return nil
}

func (s *decodeState) readPoint(path string, order binary.ByteOrder) (Point, error) {
	offset := s.pos
	if s.remaining() < 16 {
		return Point{}, decodeError(path, offset, ErrTruncated,
			"point needs 16 bytes, have %d", s.remaining())
	}
	x := math.Float64frombits(s.uint64(order))
	y := math.Float64frombits(s.uint64(order))
	if !isFinite(x) || !isFinite(y) {
		return Point{}, decodeError(path, offset, ErrNonFiniteCoordinate,
			"coordinate (%g,%g) is not finite", x, y)
	}
	return Point{X: x, Y: y}, nil
}

func (s *decodeState) uint32Field(path string, offset int, name string, order binary.ByteOrder) (uint32, error) {
	if s.remaining() < 4 {
		return 0, decodeError(path, offset, ErrTruncated,
			"%s needs 4 bytes, have %d", name, s.remaining())
	}
	return s.uint32(order), nil
}

func (s *decodeState) remaining() int {
	return len(s.data) - s.pos
}

func (s *decodeState) uint32(order binary.ByteOrder) uint32 {
	value := order.Uint32(s.data[s.pos : s.pos+4])
	s.pos += 4
	return value
}

func (s *decodeState) uint64(order binary.ByteOrder) uint64 {
	value := order.Uint64(s.data[s.pos : s.pos+8])
	s.pos += 8
	return value
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// initialCapacity avoids trusting a hostile declared count when allocating.
// append grows the slice as bytes are actually decoded.
func initialCapacity(count uint32) int {
	const maxInitialCapacity = 256
	if count > maxInitialCapacity {
		return maxInitialCapacity
	}
	return int(count)
}
