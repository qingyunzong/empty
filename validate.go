package layout

import "fmt"

// Validate checks that l is a tight, non-overlapping layout:
//
//   - every field offset is the minimal aligned offset at or after the end
//     of the previous field (which also guarantees no two fields overlap);
//   - the total size is the minimal size that covers all fields and is a
//     multiple of the layout alignment (tail padding).
//
// It returns nil when the layout satisfies all of these properties.
func Validate(l Layout) error {
	if l.Align <= 0 {
		return fmt.Errorf("layout: non-positive alignment %d", l.Align)
	}
	end := int64(0)
	for _, f := range l.Fields {
		if f.Size < 0 || f.Align <= 0 {
			return fmt.Errorf("layout: field %q has invalid size %d or align %d",
				f.Name, f.Size, f.Align)
		}
		if f.Offset < end {
			return fmt.Errorf("layout: field %q at offset %d overlaps previous field ending at %d",
				f.Name, f.Offset, end)
		}
		want, err := alignUp(end, f.Align)
		if err != nil {
			return err
		}
		if f.Offset != want {
			return fmt.Errorf("layout: field %q at offset %d, minimal aligned offset is %d",
				f.Name, f.Offset, want)
		}
		end, err = add(f.Offset, f.Size)
		if err != nil {
			return err
		}
	}
	size, err := alignUp(end, l.Align)
	if err != nil {
		return err
	}
	if l.Size != size {
		return fmt.Errorf("layout: size %d, minimal tail-padded size is %d", l.Size, size)
	}
	return nil
}
