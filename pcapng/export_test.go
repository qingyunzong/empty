package pcapng

// Exports for white-box tests in the pcapng_test package.

func (rd *Reader) SectionOpen() bool { return rd.sec }

func (rd *Reader) IfaceCount() int { return len(rd.ifs) }

func (rd *Reader) Fail() error { return rd.err }
