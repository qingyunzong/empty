package dataeng

// Reassemble builds a complete message from a sequence of literal fragments.
// Expected section sizes are optional; when they are omitted, completion is
// impossible because a short final literal cannot be distinguished from server
// truncation. Passing more than one size map is an error.
//
// The input segments are added in order. Any conflict or invalid segment
// aborts the operation.
func Reassemble(segments []Segment, sizes ...map[Section]int64) (map[Section][]byte, error) {
	if len(sizes) > 1 {
		return nil, &ExpectedSizeError{
			Section:  "",
			Existing: int64(len(sizes)),
			Incoming: 1,
			Reason:   "duplicate size maps",
		}
	}
	message := NewMessage()
	if len(sizes) == 1 {
		if err := message.ExpectSections(sizes[0]); err != nil {
			return nil, err
		}
	}
	for _, segment := range segments {
		if err := message.Add(segment); err != nil {
			return nil, err
		}
	}
	return message.Assemble()
}

// AssembleSegments is an alias for Reassemble.
func AssembleSegments(segments []Segment, sizes ...map[Section]int64) (map[Section][]byte, error) {
	return Reassemble(segments, sizes...)
}
