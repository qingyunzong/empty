// Package dataeng decodes one complete SNMP version 1 or version 2c response
// message without sending or otherwise touching the network.
//
// Decode enforces strict shortest-form identifier, tag, length, INTEGER,
// OBJECT IDENTIFIER, and application-integer encodings. It also validates the
// response structure and bounds every declared content length by the host's
// maxMessage limit before reading the content.
package dataeng
