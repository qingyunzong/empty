package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"reflect"
	"testing"

	"example.org/dataeng/q0132"
)

// The helpers in this file intentionally form a separate encoder. They do not
// call any production encoding or decoding code, so a bug in the decoder
// cannot hide behind the same implementation.

type coordinate struct {
	x float64
	y float64
}

func putUint32(buf *bytes.Buffer, order dataeng.ByteOrder, value uint32) {
	raw := make([]byte, 4)
	byteOrder(order).PutUint32(raw, value)
	_, _ = buf.Write(raw)
}

func putFloat64(buf *bytes.Buffer, order dataeng.ByteOrder, value float64) {
	raw := make([]byte, 8)
	byteOrder(order).PutUint64(raw, math.Float64bits(value))
	_, _ = buf.Write(raw)
}

func byteOrder(order dataeng.ByteOrder) binary.ByteOrder {
	if order == dataeng.LittleEndian {
		return binary.LittleEndian
	}
	return binary.BigEndian
}

func header(order dataeng.ByteOrder, typ dataeng.GeometryType) []byte {
	if order != dataeng.BigEndian && order != dataeng.LittleEndian {
		panic("test encoder: invalid byte order")
	}
	buf := &bytes.Buffer{}
	_, _ = buf.Write([]byte{byte(order)})
	putUint32(buf, order, uint32(typ))
	return buf.Bytes()
}

func encodePoint(order dataeng.ByteOrder, x, y float64) []byte {
	buf := bytes.NewBuffer(header(order, dataeng.PointType))
	putFloat64(buf, order, x)
	putFloat64(buf, order, y)
	return buf.Bytes()
}

func encodeLine(order dataeng.ByteOrder, points []coordinate) []byte {
	buf := bytes.NewBuffer(header(order, dataeng.LineStringType))
	putUint32(buf, order, uint32(len(points)))
	for _, point := range points {
		putFloat64(buf, order, point.x)
		putFloat64(buf, order, point.y)
	}
	return buf.Bytes()
}

func encodePolygon(order dataeng.ByteOrder, rings [][]coordinate) []byte {
	buf := bytes.NewBuffer(header(order, dataeng.PolygonType))
	putUint32(buf, order, uint32(len(rings)))
	for _, ring := range rings {
		putUint32(buf, order, uint32(len(ring)))
		for _, point := range ring {
			putFloat64(buf, order, point.x)
			putFloat64(buf, order, point.y)
		}
	}
	return buf.Bytes()
}

func encodeCollection(order dataeng.ByteOrder, children ...[]byte) []byte {
	buf := bytes.NewBuffer(header(order, dataeng.GeometryCollectionType))
	putUint32(buf, order, uint32(len(children)))
	for _, child := range children {
		_, _ = buf.Write(child)
	}
	return buf.Bytes()
}

func encodeHeaderOnly(order dataeng.ByteOrder, typ dataeng.GeometryType) []byte {
	return header(order, typ)
}

func encodedPoints(points []coordinate) []dataeng.Point {
	result := make([]dataeng.Point, 0, len(points))
	for _, point := range points {
		result = append(result, dataeng.Point{X: point.x, Y: point.y})
	}
	return result
}

func encodedRing(points []coordinate) dataeng.Ring {
	return dataeng.Ring(encodedPoints(points))
}

var square = []coordinate{
	{x: 0, y: 0},
	{x: 4, y: 0},
	{x: 4, y: 3},
	{x: 0, y: 3},
	{x: 0, y: 0},
}

func TestDecodeValidObjects(t *testing.T) {
	linePoints := []coordinate{{x: -1.25, y: 2}, {x: 3.5, y: -4}, {x: 5, y: 6}}
	nested := encodeCollection(
		dataeng.LittleEndian,
		encodePoint(dataeng.BigEndian, 10, -10),
		encodeCollection(dataeng.BigEndian,
			encodeLine(dataeng.LittleEndian, []coordinate{{x: 1, y: 2}, {x: 3, y: 4}}),
		),
	)

	tests := []struct {
		name string
		data []byte
		want dataeng.Geometry
	}{
		{
			name: "big endian point",
			data: encodePoint(dataeng.BigEndian, 1.5, -2.25),
			want: dataeng.Geometry{
				Type:  dataeng.PointType,
				Order: dataeng.BigEndian,
				Point: &dataeng.Point{X: 1.5, Y: -2.25},
			},
		},
		{
			name: "little endian point",
			data: encodePoint(dataeng.LittleEndian, -8, 13),
			want: dataeng.Geometry{
				Type:  dataeng.PointType,
				Order: dataeng.LittleEndian,
				Point: &dataeng.Point{X: -8, Y: 13},
			},
		},
		{
			name: "big endian line string",
			data: encodeLine(dataeng.BigEndian, linePoints),
			want: dataeng.Geometry{
				Type:   dataeng.LineStringType,
				Order:  dataeng.BigEndian,
				Points: encodedPoints(linePoints),
			},
		},
		{
			name: "little endian polygon",
			data: encodePolygon(dataeng.LittleEndian, [][]coordinate{square}),
			want: dataeng.Geometry{
				Type:  dataeng.PolygonType,
				Order: dataeng.LittleEndian,
				Rings: []dataeng.Ring{encodedRing(square)},
			},
		},
		{
			name: "empty polygon",
			data: encodePolygon(dataeng.BigEndian, nil),
			want: dataeng.Geometry{
				Type:  dataeng.PolygonType,
				Order: dataeng.BigEndian,
			},
		},
		{
			name: "empty line string",
			data: encodeLine(dataeng.LittleEndian, nil),
			want: dataeng.Geometry{
				Type:  dataeng.LineStringType,
				Order: dataeng.LittleEndian,
			},
		},
		{
			name: "empty collection",
			data: encodeCollection(dataeng.LittleEndian),
			want: dataeng.Geometry{
				Type:  dataeng.GeometryCollectionType,
				Order: dataeng.LittleEndian,
			},
		},
		{
			name: "collection with mixed byte orders",
			data: nested,
			want: dataeng.Geometry{
				Type:  dataeng.GeometryCollectionType,
				Order: dataeng.LittleEndian,
				Geometries: []dataeng.Geometry{
					{
						Type:  dataeng.PointType,
						Order: dataeng.BigEndian,
						Point: &dataeng.Point{X: 10, Y: -10},
					},
					{
						Type:  dataeng.GeometryCollectionType,
						Order: dataeng.BigEndian,
						Geometries: []dataeng.Geometry{
							{
								Type:   dataeng.LineStringType,
								Order:  dataeng.LittleEndian,
								Points: encodedPoints([]coordinate{{x: 1, y: 2}, {x: 3, y: 4}}),
							},
						},
					},
				},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := dataeng.Decode(test.data)
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("Decode() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestEveryBytePrefixIsTruncated(t *testing.T) {
	fixtures := [][]byte{
		encodePoint(dataeng.BigEndian, 1, 2),
		encodePoint(dataeng.LittleEndian, 3, 4),
		encodeLine(dataeng.BigEndian, []coordinate{{x: 1, y: 2}, {x: 3, y: 4}}),
		encodeLine(dataeng.LittleEndian, nil),
		encodePolygon(dataeng.BigEndian, [][]coordinate{square}),
		encodePolygon(dataeng.LittleEndian, nil),
		encodeCollection(dataeng.BigEndian,
			encodePoint(dataeng.LittleEndian, 1, 2),
			encodePolygon(dataeng.BigEndian, [][]coordinate{square}),
		),
	}

	for fixtureIndex, fixture := range fixtures {
		for cut := 0; cut < len(fixture); cut++ {
			_, err := dataeng.Decode(fixture[:cut])
			if err == nil {
				t.Fatalf("fixture %d: Decode(%d-byte prefix) succeeded, want truncation", fixtureIndex, cut)
			}
			if !errors.Is(err, dataeng.ErrTruncated) {
				t.Fatalf("fixture %d: prefix %d: error = %v, want ErrTruncated", fixtureIndex, cut, err)
			}
			var decodeErr *dataeng.DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("fixture %d: prefix %d: error type = %T, want *dataeng.DecodeError", fixtureIndex, cut, err)
			}
			if decodeErr.Path == "" {
				t.Fatalf("fixture %d: prefix %d: empty geometry path", fixtureIndex, cut)
			}
		}
	}
}

func TestTrailingBytesFailWholeObject(t *testing.T) {
	fixtures := [][]byte{
		encodePoint(dataeng.LittleEndian, 1, 2),
		encodeLine(dataeng.BigEndian, []coordinate{{x: 1, y: 2}, {x: 3, y: 4}}),
		encodePolygon(dataeng.LittleEndian, [][]coordinate{square}),
		encodeCollection(dataeng.BigEndian,
			encodePoint(dataeng.LittleEndian, 5, 6),
		),
	}
	for fixtureIndex, fixture := range fixtures {
		for extra := 1; extra <= 3; extra++ {
			data := append(append([]byte(nil), fixture...), make([]byte, extra)...)
			got, err := dataeng.Decode(data)
			if err == nil {
				t.Fatalf("fixture %d: Decode() with %d trailing byte(s) succeeded: %#v", fixtureIndex, extra, got)
			}
			if !errors.Is(err, dataeng.ErrTrailingData) {
				t.Fatalf("fixture %d: trailing %d: error = %v, want ErrTrailingData", fixtureIndex, extra, err)
			}
			var decodeErr *dataeng.DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("fixture %d: trailing %d: error type = %T", fixtureIndex, extra, err)
			}
			if decodeErr.Path != "$" {
				t.Fatalf("fixture %d: trailing %d: path = %q, want %q", fixtureIndex, extra, decodeErr.Path, "$")
			}
			if decodeErr.Offset != len(fixture) {
				t.Fatalf("fixture %d: trailing %d: offset = %d, want %d", fixtureIndex, extra, decodeErr.Offset, len(fixture))
			}
			if !reflect.DeepEqual(got, dataeng.Geometry{}) {
				t.Fatalf("fixture %d: trailing %d: returned partial geometry %#v", fixtureIndex, extra, got)
			}
		}
	}
}

func TestRingValidation(t *testing.T) {
	tests := []struct {
		name     string
		data     []byte
		sentinel error
		path     string
	}{
		{
			name: "too few points",
			data: encodePolygon(dataeng.LittleEndian, [][]coordinate{{
				{x: 0, y: 0}, {x: 1, y: 0}, {x: 0, y: 0},
			}}),
			sentinel: dataeng.ErrInvalidRing,
			path:     "$.rings[0]",
		},
		{
			name:     "zero point ring",
			data:     encodePolygon(dataeng.BigEndian, [][]coordinate{{}}),
			sentinel: dataeng.ErrInvalidRing,
			path:     "$.rings[0]",
		},
		{
			name: "not closed",
			data: encodePolygon(dataeng.BigEndian, [][]coordinate{{
				{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1},
			}}),
			sentinel: dataeng.ErrRingNotClosed,
			path:     "$.rings[0]",
		},
		{
			name: "second ring not closed",
			data: encodePolygon(dataeng.LittleEndian, [][]coordinate{
				square,
				{
					{x: 1, y: 1}, {x: 2, y: 1}, {x: 2, y: 2}, {x: 1, y: 2},
				},
			}),
			sentinel: dataeng.ErrRingNotClosed,
			path:     "$.rings[1]",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.Decode(test.data)
			if err == nil {
				t.Fatal("Decode() succeeded, want ring validation error")
			}
			if !errors.Is(err, test.sentinel) {
				t.Fatalf("error = %v, want %v", err, test.sentinel)
			}
			var decodeErr *dataeng.DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
			}
			if decodeErr.Path != test.path {
				t.Fatalf("path = %q, want %q", decodeErr.Path, test.path)
			}
		})
	}
}

func TestNonFiniteCoordinates(t *testing.T) {
	nested := encodeCollection(dataeng.BigEndian,
		encodePoint(dataeng.LittleEndian, 1, 2),
		encodeLine(dataeng.BigEndian, []coordinate{{x: 3, y: 4}, {x: math.Inf(1), y: 5}}),
	)

	tests := []struct {
		name string
		data []byte
		path string
	}{
		{
			name: "NaN point",
			data: encodePoint(dataeng.BigEndian, math.NaN(), 2),
			path: "$",
		},
		{
			name: "infinite point",
			data: encodePoint(dataeng.LittleEndian, 1, math.Inf(-1)),
			path: "$",
		},
		{
			name: "infinite nested line coordinate",
			data: nested,
			path: "$.geometries[1].points[1]",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.Decode(test.data)
			if !errors.Is(err, dataeng.ErrNonFiniteCoordinate) {
				t.Fatalf("error = %v, want ErrNonFiniteCoordinate", err)
			}
			var decodeErr *dataeng.DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
			}
			if decodeErr.Path != test.path {
				t.Fatalf("path = %q, want %q", decodeErr.Path, test.path)
			}
		})
	}
}

func TestInvalidHeaders(t *testing.T) {
	tests := []struct {
		name     string
		data     []byte
		sentinel error
		path     string
	}{
		{
			name:     "invalid byte order",
			data:     []byte{2, 0, 0, 0, 1},
			sentinel: dataeng.ErrInvalidByteOrder,
			path:     "$",
		},
		{
			name:     "invalid byte order before full header",
			data:     []byte{2},
			sentinel: dataeng.ErrInvalidByteOrder,
			path:     "$",
		},
		{
			name:     "invalid type zero",
			data:     encodeHeaderOnly(dataeng.BigEndian, 0),
			sentinel: dataeng.ErrInvalidType,
			path:     "$",
		},
		{
			name:     "invalid type four",
			data:     encodeHeaderOnly(dataeng.LittleEndian, 4),
			sentinel: dataeng.ErrInvalidType,
			path:     "$",
		},
		{
			name: "invalid nested type",
			data: encodeCollection(dataeng.LittleEndian,
				encodeHeaderOnly(dataeng.BigEndian, 9),
			),
			sentinel: dataeng.ErrInvalidType,
			path:     "$.geometries[0]",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.Decode(test.data)
			if !errors.Is(err, test.sentinel) {
				t.Fatalf("error = %v, want %v", err, test.sentinel)
			}
			var decodeErr *dataeng.DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
			}
			if decodeErr.Path != test.path {
				t.Fatalf("path = %q, want %q", decodeErr.Path, test.path)
			}
		})
	}
}

func TestPointLimit(t *testing.T) {
	line := encodeLine(dataeng.BigEndian, []coordinate{
		{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}, {x: 3, y: 0},
	})
	if _, err := dataeng.DecodeWithLimits(line, dataeng.Limits{MaxPoints: 3}); !errors.Is(err, dataeng.ErrPointLimit) {
		t.Fatalf("error = %v, want ErrPointLimit", err)
	} else {
		var decodeErr *dataeng.DecodeError
		if !errors.As(err, &decodeErr) || decodeErr.Path != "$" {
			t.Fatalf("error = %#v, want path %q", err, "$")
		}
	}
	if _, err := dataeng.DecodeWithLimits(line, dataeng.Limits{MaxPoints: 4}); err != nil {
		t.Fatalf("DecodeWithLimits(MaxPoints=4) error = %v", err)
	}

	collection := encodeCollection(dataeng.LittleEndian,
		encodeLine(dataeng.BigEndian, []coordinate{{x: 1, y: 1}, {x: 2, y: 2}, {x: 3, y: 3}}),
		encodePoint(dataeng.LittleEndian, 4, 4),
	)
	_, err := dataeng.DecodeWithLimits(collection, dataeng.Limits{MaxPoints: 3})
	if !errors.Is(err, dataeng.ErrPointLimit) {
		t.Fatalf("error = %v, want ErrPointLimit", err)
	}
	var decodeErr *dataeng.DecodeError
	if !errors.As(err, &decodeErr) {
		t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
	}
	if decodeErr.Path != "$.geometries[1]" {
		t.Fatalf("path = %q, want %q", decodeErr.Path, "$.geometries[1]")
	}

	// A huge declared line count must be identified as a limit violation even
	// when the truncated input could never hold the points.
	hugeLine := bytes.NewBuffer(encodeHeaderOnly(dataeng.BigEndian, dataeng.LineStringType))
	putUint32(hugeLine, dataeng.BigEndian, math.MaxUint32)
	if _, err := dataeng.DecodeWithLimits(hugeLine.Bytes(), dataeng.Limits{MaxPoints: 100}); !errors.Is(err, dataeng.ErrPointLimit) {
		t.Fatalf("huge line error = %v, want ErrPointLimit", err)
	}
}

func nestedObjects(levels int, leaf []byte) []byte {
	if levels == 0 {
		return leaf
	}
	return encodeCollection(dataeng.BigEndian, nestedObjects(levels-1, leaf))
}

func TestDepthLimit(t *testing.T) {
	point := encodePoint(dataeng.LittleEndian, 1, 2)
	data := nestedObjects(3, point)

	if _, err := dataeng.DecodeWithLimits(data, dataeng.Limits{MaxDepth: 3}); err != nil {
		t.Fatalf("DecodeWithLimits(MaxDepth=3) error = %v", err)
	}

	_, err := dataeng.DecodeWithLimits(data, dataeng.Limits{MaxDepth: 2})
	if !errors.Is(err, dataeng.ErrDepthLimit) {
		t.Fatalf("error = %v, want ErrDepthLimit", err)
	}
	var decodeErr *dataeng.DecodeError
	if !errors.As(err, &decodeErr) {
		t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
	}
	wantPath := "$.geometries[0].geometries[0].geometries[0]"
	if decodeErr.Path != wantPath {
		t.Fatalf("path = %q, want %q", decodeErr.Path, wantPath)
	}
}

func TestImpossibleCountsAndTruncation(t *testing.T) {
	lineHeader := bytes.NewBuffer(encodeHeaderOnly(dataeng.LittleEndian, dataeng.LineStringType))
	putUint32(lineHeader, dataeng.LittleEndian, math.MaxUint32)

	collectionHeader := bytes.NewBuffer(encodeHeaderOnly(dataeng.BigEndian, dataeng.GeometryCollectionType))
	putUint32(collectionHeader, dataeng.BigEndian, math.MaxUint32)

	polygonHeader := bytes.NewBuffer(encodeHeaderOnly(dataeng.BigEndian, dataeng.PolygonType))
	putUint32(polygonHeader, dataeng.BigEndian, math.MaxUint32)

	ringHeader := bytes.NewBuffer(encodeHeaderOnly(dataeng.LittleEndian, dataeng.PolygonType))
	putUint32(ringHeader, dataeng.LittleEndian, 1)
	putUint32(ringHeader, dataeng.LittleEndian, math.MaxUint32)

	tests := []struct {
		name     string
		data     []byte
		sentinel error
		path     string
	}{
		{"line count limited", lineHeader.Bytes(), dataeng.ErrPointLimit, "$"},
		{"collection count cannot fit", collectionHeader.Bytes(), dataeng.ErrTruncated, "$"},
		{"polygon ring count cannot fit", polygonHeader.Bytes(), dataeng.ErrTruncated, "$"},
		{"ring point count limited", ringHeader.Bytes(), dataeng.ErrPointLimit, "$.rings[0]"},
		{
			"line points truncated",
			encodeLine(dataeng.BigEndian, []coordinate{{x: 1, y: 2}, {x: 3, y: 4}})[:5+4+16],
			dataeng.ErrTruncated,
			"$",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.Decode(test.data)
			if !errors.Is(err, test.sentinel) {
				t.Fatalf("error = %v, want %v", err, test.sentinel)
			}
			var decodeErr *dataeng.DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
			}
			if decodeErr.Path != test.path {
				t.Fatalf("path = %q, want %q", decodeErr.Path, test.path)
			}
		})
	}
}

func TestGeometryPointCount(t *testing.T) {
	collectionData := encodeCollection(dataeng.BigEndian,
		encodePoint(dataeng.LittleEndian, 1, 2),
		encodeLine(dataeng.BigEndian, []coordinate{{x: 1, y: 2}, {x: 3, y: 4}}),
		encodePolygon(dataeng.LittleEndian, [][]coordinate{square}),
	)
	geometry, err := dataeng.Decode(collectionData)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if got, want := geometry.PointCount(), 1+2+len(square); got != want {
		t.Fatalf("PointCount() = %d, want %d", got, want)
	}
}

func FuzzDecodeNeverPanics(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{0, 0, 0, 0, 1})
	f.Add(encodePoint(dataeng.BigEndian, 1, 2))
	f.Add(encodeLine(dataeng.LittleEndian, []coordinate{{x: 1, y: 2}, {x: 3, y: 4}}))
	f.Add(encodePolygon(dataeng.BigEndian, [][]coordinate{square}))
	f.Add(encodeCollection(dataeng.LittleEndian, encodePoint(dataeng.BigEndian, 1, 2)))
	f.Fuzz(func(t *testing.T, data []byte) {
		_, err := dataeng.Decode(data)
		if err == nil {
			return
		}
		var decodeErr *dataeng.DecodeError
		if !errors.As(err, &decodeErr) {
			t.Fatalf("error type = %T, want *dataeng.DecodeError", err)
		}
		if decodeErr.Path == "" {
			t.Fatalf("error %v has an empty geometry path", err)
		}
	})
}
