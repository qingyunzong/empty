// Package dataeng reads a continuous stream of UTF-8 MARC21 bibliographic
// records and exposes every field and subfield as raw byte ranges together
// with the 880 alternate-representation linkage. It does not model loans or
// any other management domain.
//
// NewReader wraps any io.Reader and tolerates arbitrary chunk boundaries:
//
//	r := dataeng.NewReader(src)
//	for {
//		rec, err := r.Next()
//		if errors.Is(err, io.EOF) {
//			break
//		}
//		if err != nil {
//			// *SyntaxError consumes the bad record and keeps the stream
//			// readable; *TruncatedError is terminal.
//			log.Print(err)
//			continue
//		}
//		...
//	}
//
// A record is delivered only after its leader, directory, field coverage,
// UTF-8 text and 880 linkage all validate. Byte ranges stay in directory
// order (physical order may differ) and are absolute stream offsets for
// records produced by Reader.
package dataeng
