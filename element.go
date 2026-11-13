package dataeng

// DataSet is the result of parsing an implicit-VR data set.
type DataSet struct {
	Elements []*Element
}

// Element is one parsed DICOM data element.
//
// A leaf element carries its value in Value and has Sequence set to false.
// Value aliases the input slice passed to Parse rather than copying it. A
// sequence element carries its items in Items and has Sequence set to true.
// Length is the declared length from the stream; it is -1 for an undefined
// length sequence.
type Element struct {
	Tag      Tag
	Sequence bool
	Length   int64
	Value    []byte
	Items    []*Item
}

// IsSequence reports whether the element holds sequence items. It is the
// method form of the Sequence field.
func (e *Element) IsSequence() bool {
	return e != nil && e.Sequence
}

// Item is one item of a sequence. Length is -1 when the item had undefined
// length and was terminated by an item delimiter.
type Item struct {
	Length   int64
	Elements []*Element
}
