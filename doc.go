// Package q215 reassembles Ogg packets (RFC 3533) from an arbitrarily
// fragmented byte stream for an audio import host.
//
// A Demuxer validates every page header and its CRC-32, tracks page sequence
// numbers independently for each stream serial, and rebuilds packets from the
// segment lacing table: a lacing value of 255 continues the current packet,
// any smaller value (including 0, which yields an empty packet) closes it.
// A page may contain several packets and a packet may span several pages.
//
// The continued flag must match each serial's pending-packet state. When a
// page is missing, the unfinished packet is discarded and a Gap is reported;
// logical bitstreams never interfere with one another. An end-of-stream page
// must not leave a half packet behind.
//
// Reassembled packets are delivered through the caller-supplied callbacks in
// Config, together with their originating PageSource. Only the last packet
// completed on a page carries that page's granule position; no timestamps are
// fabricated for earlier packets or for pages declaring granule -1.
package q215
