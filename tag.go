package dataeng

import "fmt"

// Tag identifies a DICOM data element by its group and element numbers.
type Tag struct {
	Group   uint16
	Element uint16
}

// String returns the conventional (gggg,eeee) representation of a tag.
func (t Tag) String() string {
	return fmt.Sprintf("(%04X,%04X)", t.Group, t.Element)
}

// IsPrivate reports whether the tag belongs to a private group. DICOM
// reserves odd group numbers for private data.
func (t Tag) IsPrivate() bool {
	return t.Group&1 == 1
}

// Well-known tags used by item and sequence delimitation. These tags are
// structural markers and are never returned as data elements.
var (
	ItemTag              = Tag{Group: 0xFFFE, Element: 0xE000}
	ItemDelimiterTag     = Tag{Group: 0xFFFE, Element: 0xE00D}
	SequenceDelimiterTag = Tag{Group: 0xFFFE, Element: 0xE0DD}
)

var zeroTag Tag
