package dataeng

// CDF-1 data types supported by the reader.
const (
	TypeByte   = 1 // signed 8-bit integer
	TypeChar   = 2 // 8-bit byte, raw byte value is preserved
	TypeShort  = 3 // signed 16-bit big-endian integer
	TypeInt    = 4 // signed 32-bit big-endian integer
	TypeFloat  = 5 // 32-bit IEEE float, returned as its raw bit pattern
	TypeDouble = 6 // 64-bit IEEE float, returned as its raw bit pattern
)

// CDFType is a CDF-1 numeric type code.
type CDFType int

// Width returns the on-disk size in bytes of one value of this type.
func (t CDFType) Width() int64 {
	switch t {
	case TypeByte, TypeChar:
		return 1
	case TypeShort:
		return 2
	case TypeInt, TypeFloat:
		return 4
	case TypeDouble:
		return 8
	default:
		return -1
	}
}
