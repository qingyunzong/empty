"""Resumable, checkpointed, atomic update applier.

The applier consumes the update stream from a seekable file in bounded
chunks, executes verified instructions against a 64 KiB memory window backed
by a temp file, and checkpoints after every verified instruction boundary
(input offset, output length, rolling hash state, decoder phase).

On open, an existing checkpoint is resumed: the baseline fingerprint and the
temp output prefix are re-verified before a single further byte is processed.
The target file is replaced atomically (os.replace) only after every block
hash and the final total hash have matched; on any failure the pre-existing
target is left untouched.
"""

import hashlib
import json
import os

from .decoder import Decoder
from .errors import (BaselineRangeError, BlockLengthExceededError,
                     BlockLengthMismatchError, CheckpointError,
                     CopyOutOfRangeError, FingerprintMismatchError,
                     HashMismatchError, Interrupted)
from .sha256 import Sha256
from .sink import OutputSink

CHECKPOINT_NAME = "checkpoint.json"
TEMP_NAME = "output.tmp"
_READ_CHUNK = 1 << 16

# Events after which a checkpoint may be taken (verified instruction
# boundaries).  add_begin/add_data are mid-instruction and never checkpointed.
_BOUNDARY_EVENTS = {"header", "block_header", "add_end", "copy_base",
                    "copy_out", "end_block"}


def _file_fingerprint(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_READ_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Applier:
    def __init__(self, baseline_path, update_path, target_path, state_dir,
                 *, window_size=1 << 16, interrupt_after=None,
                 read_chunk_size=_READ_CHUNK):
        self._baseline_path = baseline_path
        self._update_path = update_path
        self._target_path = target_path
        self._state_dir = state_dir
        self._checkpoint_path = os.path.join(state_dir, CHECKPOINT_NAME)
        self._temp_path = os.path.join(state_dir, TEMP_NAME)
        self._window_size = window_size
        self._interrupt_after = interrupt_after
        self._read_chunk_size = read_chunk_size
        self._boundaries = 0
        self.done = False

        os.makedirs(state_dir, exist_ok=True)
        self._baseline_size = os.path.getsize(baseline_path)
        fingerprint = _file_fingerprint(baseline_path)
        self._base_file = open(baseline_path, "rb")
        self._update_file = open(update_path, "rb")

        try:
            if os.path.exists(self._checkpoint_path):
                self._restore(fingerprint)
            else:
                self._fresh(fingerprint)
        except Exception:
            self._base_file.close()
            self._update_file.close()
            raise

    def _fresh(self, fingerprint):
        self._baseline_fingerprint = fingerprint
        self._sink = OutputSink(self._temp_path, self._window_size)
        self._sink.on_write = self._on_output
        self._decoder = Decoder()
        self._total_hasher = Sha256()
        self._block = None
        self._num_blocks = None
        self._blocks_seen = 0
        self._phase = "header"

    # -- public API ---------------------------------------------------------

    def run(self) -> dict:
        """Process available input; returns a JSON-able status dict."""
        while not self.done:
            chunk = self._update_file.read(self._read_chunk_size)
            if not chunk:
                return {"status": "need_more",
                        "needed": self._decoder.feed(b"").needed,
                        "input_offset": self._decoder.consumed,
                        "output_length": self._sink.length}
            result = self._decoder.feed(chunk)
            for offset, event in result.events:
                self._handle(event)
                if event[0] in _BOUNDARY_EVENTS:
                    self._write_checkpoint(offset)
                    self._boundaries += 1
                    if (self._interrupt_after is not None
                            and self._boundaries >= self._interrupt_after):
                        raise Interrupted(
                            f"interrupted after {self._boundaries} boundaries")
        return {"status": "applied",
                "output_length": self._sink.length,
                "sha256": self._total_hasher.hexdigest()}

    def close(self):
        self._base_file.close()
        self._update_file.close()
        self._sink.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # -- event handling -----------------------------------------------------

    def _on_output(self, data: bytes):
        self._total_hasher.update(data)
        if self._block is not None:
            self._block["hasher"].update(data)
            self._block["produced"] += len(data)

    def _check_block_room(self, length: int):
        if self._block is None:
            raise BlockLengthExceededError("instruction outside of a block")
        remaining = self._block["expected_len"] - self._block["produced"]
        if length > remaining:
            raise BlockLengthExceededError(
                f"instruction of {length} bytes exceeds remaining block "
                f"length {remaining}")

    def _handle(self, event):
        kind = event[0]
        if kind == "header":
            _, fingerprint, num_blocks = event
            if fingerprint.hex() != self._baseline_fingerprint:
                raise FingerprintMismatchError(
                    "update stream is for a different baseline")
            self._num_blocks = num_blocks
            self._phase = "block_header" if num_blocks else "final"
        elif kind == "block_header":
            _, out_len, block_hash = event
            self._block = {"expected_len": out_len,
                           "expected_hash": block_hash.hex(),
                           "start_output_length": self._sink.length,
                           "produced": 0,
                           "hasher": Sha256()}
            self._phase = "instructions"
        elif kind == "add_begin":
            self._check_block_room(event[1])
        elif kind == "add_data":
            self._sink.write(event[1])
        elif kind == "copy_base":
            _, offset, length = event
            self._check_block_room(length)
            if offset + length > self._baseline_size:
                raise BaselineRangeError(
                    f"COPY_BASE [{offset}, {offset + length}) exceeds "
                    f"baseline size {self._baseline_size}")
            self._sink.copy_from_base(self._base_file, offset, length)
        elif kind == "copy_out":
            _, distance, length = event
            self._check_block_room(length)
            if distance < 1 or distance > self._sink.length:
                raise CopyOutOfRangeError(
                    f"COPY_OUT distance {distance} with only "
                    f"{self._sink.length} bytes generated")
            self._sink.copy_out(distance, length)
        elif kind == "end_block":
            block = self._block
            if block["produced"] != block["expected_len"]:
                raise BlockLengthMismatchError(
                    f"block produced {block['produced']} bytes, "
                    f"declared {block['expected_len']}")
            if block["hasher"].hexdigest() != block["expected_hash"]:
                raise HashMismatchError("block hash mismatch")
            self._block = None
            self._blocks_seen += 1
            self._phase = ("block_header"
                           if self._blocks_seen < self._num_blocks
                           else "final")
        elif kind == "final_hash":
            if self._total_hasher.digest() != event[1]:
                raise HashMismatchError("final total hash mismatch")
            self._publish()
        # add_end carries no action; it only marks a checkpoint boundary.

    # -- checkpointing --------------------------------------------------------

    def _checkpoint_state(self, input_offset):
        block = self._block
        return {
            "version": 1,
            "baseline_fingerprint": self._baseline_fingerprint,
            "input_offset": input_offset,
            "output_length": self._sink.length,
            "total_hash_state": self._total_hasher.getstate().hex(),
            "num_blocks": self._num_blocks,
            "blocks_seen": self._blocks_seen,
            "phase": self._phase,
            "block": None if block is None else {
                "expected_len": block["expected_len"],
                "expected_hash": block["expected_hash"],
                "start_output_length": block["start_output_length"],
                "produced": block["produced"],
                "hash_state": block["hasher"].getstate().hex(),
            },
        }

    def _write_checkpoint(self, input_offset):
        self._sink.flush()
        tmp = self._checkpoint_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self._checkpoint_state(input_offset), fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._checkpoint_path)

    def _restore(self, fingerprint):
        with open(self._checkpoint_path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
        if state.get("version") != 1:
            raise CheckpointError("unsupported checkpoint version")
        if state["baseline_fingerprint"] != fingerprint:
            raise FingerprintMismatchError(
                "baseline does not match checkpoint fingerprint")
        if not os.path.exists(self._temp_path):
            raise CheckpointError("checkpoint exists but temp output is missing")
        self._baseline_fingerprint = fingerprint

        out_len = state["output_length"]
        actual = os.path.getsize(self._temp_path)
        if actual < out_len:
            raise CheckpointError(
                f"temp output truncated: {actual} < {out_len}")

        self._total_hasher = Sha256.fromstate(
            bytes.fromhex(state["total_hash_state"]))
        self._verify_temp_prefix(0, out_len, self._total_hasher.digest(),
                                 "total")

        block = state["block"]
        if block is not None:
            hasher = Sha256.fromstate(bytes.fromhex(block["hash_state"]))
            self._verify_temp_prefix(block["start_output_length"], out_len,
                                     hasher.digest(), "block")
            if block["start_output_length"] + block["produced"] != out_len:
                raise CheckpointError("checkpoint block/output length mismatch")
            self._block = {"expected_len": block["expected_len"],
                           "expected_hash": block["expected_hash"],
                           "start_output_length": block["start_output_length"],
                           "produced": block["produced"],
                           "hasher": hasher}
        else:
            self._block = None

        self._sink = OutputSink.resume(self._temp_path, self._window_size,
                                       out_len)
        self._sink.on_write = self._on_output
        self._num_blocks = state["num_blocks"]
        self._blocks_seen = state["blocks_seen"]
        self._phase = state["phase"]
        self._decoder = Decoder(phase=self._phase,
                                blocks_seen=self._blocks_seen,
                                num_blocks=self._num_blocks,
                                consumed=state["input_offset"])
        self._update_file.seek(state["input_offset"])

    def _verify_temp_prefix(self, start, end, expected, label):
        hasher = Sha256()
        with open(self._temp_path, "rb") as fh:
            fh.seek(start)
            remaining = end - start
            while remaining > 0:
                chunk = fh.read(min(_READ_CHUNK, remaining))
                if not chunk:
                    raise CheckpointError("temp output short read")
                hasher.update(chunk)
                remaining -= len(chunk)
        if hasher.digest() != expected:
            raise CheckpointError(
                f"temp output prefix failed {label} hash verification")

    # -- publishing -------------------------------------------------------------

    def _publish(self):
        self._sink.flush()
        self._sink.close()
        os.replace(self._temp_path, self._target_path)
        os.unlink(self._checkpoint_path)
        self.done = True
