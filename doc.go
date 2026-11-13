// Package dataeng implements an incremental decoder for a telemetry wide-LZW
// code stream. It is deliberately not GIF- or TIFF-compatible; the complete
// stream rules are below.
//
// # Stream format
//
// Codes start at 9 bits. Codes 0..255 are one-byte words, 256 is CLEAR, 257 is
// END, and the first dynamic code is 258 (next=258). Codes are packed
// most-significant-bit first and continuously; there is no per-code alignment.
// The host selects earlyChange 0 or 1.
//
// The first code must be CLEAR. Every CLEAR clears the dynamic dictionary,
// restores width 9 and next 258, and clears prev; repeated CLEAR codes are
// legal and produce no bytes.
//
// An ordinary code c<256 is a one-byte word. A code 258<=c<next names an
// existing dynamic word. c==next is legal only when prev is non-empty and
// next<4096; that KwKwK word is prev followed by prev's first byte. Every other
// currently undefined code is rejected.
//
// After an ordinary word entry is obtained, if prev is non-empty and next<4096
// the decoder defines word next as prev followed by entry's first byte, then
// increments next. If width<12 and next now equals (1<<width)-earlyChange, the
// next code is read with width+1 bits. prev then becomes entry. At next==4096
// the dictionary remains full at width 12 and no further insertions occur
// until an explicit CLEAR; a full dictionary never clears itself implicitly.
//
// END may occur with empty output. It inserts nothing. After END, the unused
// low bits of the physical byte containing END must all be zero, and no further
// physical bytes may occur. StatusEnd is not reported before Finish is called.
// Physical EOF without END, a partial code, non-zero END padding, and trailing
// bytes are failures. Every failure is permanent; output delivered before the
// failure remains valid.
//
// # Incremental operation
//
// The host calls Feed to append compressed bytes and Pull to obtain output.
// Pull(maxBytes) accepts only a non-negative maxBytes. Pull(0) never consumes an
// ordinary code and never inserts a dictionary word, but it can report an
// already established terminal state. See Status for the exact stopping
// conditions, including StatusNeedInputOrOutput (zero capacity and not even a
// complete next code is available), StatusNeedOutput (a complete code or a
// pending suffix is buffered), and StatusNeedFinish.
//
// If fewer than width bits are available, an ordinary code consumes none of
// its partial state. If output capacity is exhausted in the middle of a word,
// the decoder retains that word's suffix and does not insert the word again or
// start the next code until the suffix has been delivered. CLEAR and END are
// never treated as word bytes.
//
// The dictionary stores only a prefix code, final byte, length, and first byte
// for each dynamic word; it never stores expanded word strings. A decoded word
// uses a temporary stack of at most 4096 bytes. The decoder does not retain the
// accumulated output history.
//
// The host supplies a uint64 total output limit. Before accepting an ordinary
// code the decoder checks the entire resulting word length against the
// remaining limit. It never delivers part of a word and then discovers that the
// limit was exceeded, and it performs no wrapping arithmetic on lengths or
// counts.
//
// Feed may be followed by Finish to seal the physical input. Finish permits
// Pull to drain a legal pending word suffix. StatusEnd is returned only after
// END, zero padding, and the physical tail have all been validated and all
// pending output has been delivered. A truncated stream is not treated as a
// valid empty stream.
//
// # Sources
//
// Each output segment reports the source dictionary code, the absolute
// compressed bit interval (Source.BitOffset and Source.BitWidth), and the byte
// interval within the expanded word (Source.WordOffset and Source.WordLength).
// Successive Pull calls delivering the same word report the same code and bit
// interval.
package dataeng
