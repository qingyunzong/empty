package dataeng

// GeometryType is the uint32 object type stored in each geometry header.
type GeometryType uint32

const (
	// PointType is a single coordinate pair.
	PointType GeometryType = 1
	// LineStringType is a polyline: a point count followed by that many points.
	LineStringType GeometryType = 2
	// PolygonType is a ring count followed by each ring's points.
	PolygonType GeometryType = 3
	// GeometryCollectionType is an object count followed by nested geometries.
	GeometryCollectionType GeometryType = 7

	// PolylineType is an alias for LineStringType.
	PolylineType = LineStringType
)

// Short type-name aliases for callers that prefer Type* naming.
const (
	TypePoint              = PointType
	TypeLineString         = LineStringType
	TypePolyline           = LineStringType
	TypePolygon            = PolygonType
	TypeGeometryCollection = GeometryCollectionType
)

func (t GeometryType) String() string {
	switch t {
	case PointType:
		return "Point"
	case LineStringType:
		return "LineString"
	case PolygonType:
		return "Polygon"
	case GeometryCollectionType:
		return "GeometryCollection"
	default:
		return "Unknown"
	}
}

// ByteOrder is the byte-order marker at the start of every object.
type ByteOrder uint8

const (
	// BigEndian is encoded by the marker byte 0.
	BigEndian ByteOrder = 0
	// LittleEndian is encoded by the marker byte 1.
	LittleEndian ByteOrder = 1
)

func (o ByteOrder) String() string {
	switch o {
	case BigEndian:
		return "big-endian"
	case LittleEndian:
		return "little-endian"
	default:
		return "unknown byte order"
	}
}

// Point is one coordinate pair. X and Y must both be finite.
type Point struct {
	X float64
	Y float64
}

// Ring is one closed polygon ring, including the repeated first/last point.
type Ring []Point

// Payload aliases for the slices held by Geometry.
type (
	LineString         = []Point
	Polygon            = []Ring
	GeometryCollection = []Geometry
)

// Geometry is one decoded object. Type and Order describe the object's own
// header. Exactly one of the geometry payload fields is populated according to
// Type:
//
//	PointType                 Point
//	LineStringType            Points
//	PolygonType               Rings
//	GeometryCollectionType    Geometries
//
// An empty polygon has no Rings. A GeometryCollection can contain objects with
// different byte orders.
type Geometry struct {
	Type  GeometryType
	Order ByteOrder

	Point      *Point
	Points     []Point
	Rings      []Ring
	Geometries []Geometry
}

// PointCount returns the number of coordinate pairs in the geometry,
// recursively including collection members.
func (g Geometry) PointCount() int {
	switch g.Type {
	case PointType:
		if g.Point == nil {
			return 0
		}
		return 1
	case LineStringType:
		return len(g.Points)
	case PolygonType:
		total := 0
		for _, ring := range g.Rings {
			total += len(ring)
		}
		return total
	case GeometryCollectionType:
		total := 0
		for _, child := range g.Geometries {
			total += child.PointCount()
		}
		return total
	default:
		return 0
	}
}
