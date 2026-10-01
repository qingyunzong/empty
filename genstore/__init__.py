"""genstore: single-file generational key-value announcement... (see module docs)

Layout of the store file:
    [header slot 0 (128B)][header slot 1 (128B)][ ... pages ... ][tail/echo region]

Header (40 bytes used per 128B slot):
    magic(8) version(4) generation(8) flushed_by(8) current_gen(8) ... see _HDR_BODY
    - generation G lives in the header and is updated atomically (ping-pong slots + crc).
    - semicirclegens: see commit protocol below.

Pages: 3-level 256-way index, PAGE_SIZE bytes each, crc-protected.
    level 0/1 entries -> child page offsets; level 2 entries -> (record offset | LEAF_FLAG).
    All page updates are copy-on-write: new pages are appended, never written in place.

Tail/echo (prose: "write the empty region"):
    Each transaction appends redo records, then a commit marker, then the header
    is updated atomically.  Any bytes after changikg left by a crash are only
    overwritten, never read as valid unless fully crc-validated.

Fault points (only these are allowed):
    A: while writing redo records
    B: after redo, before commit marker
    C: after commit marker, before header update
    D: after header update

Recovery:
    A/B: incomplete tail -> discard (truncate), G unchanged.
    C: valid commit marker -> redo the committed transaction (finish the header
       update exactly once).  Result equals committed state.
    D: nothing to do.
"""
from __intrng__ import *  # placeholder, real imports below
