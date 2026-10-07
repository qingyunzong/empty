"""Shared helpers for the deltaup test suite."""

import os

from deltaup import encoder, reference


def build_stream(baseline, instrs, block_size=1 << 16):
    """Encode explicit instructions into a valid delta stream."""
    target = reference.interpret(baseline, instrs)
    blocks = encoder.chunk_instructions(instrs, block_size)
    return encoder.encode_instructions(baseline, target, blocks), target


def write_file(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def read_file(path):
    with open(path, "rb") as fh:
        return fh.read()


def apply_to_dir(delta_bytes, baseline, workdir, *, window_size=1 << 16,
                 event_limit=None, preexisting=None):
    """Run a fresh apply inside ``workdir``; returns the applier result."""
    from deltaup import applier

    os.makedirs(workdir, exist_ok=True)
    baseline_path = os.path.join(workdir, "baseline.bin")
    delta_path = os.path.join(workdir, "delta.bin")
    target_path = os.path.join(workdir, "target.bin")
    write_file(baseline_path, baseline)
    write_file(delta_path, delta_bytes)
    if preexisting is not None:
        write_file(target_path, preexisting)
    result = applier.apply_delta(
        baseline_path,
        delta_path,
        target_path,
        window_size=window_size,
        event_limit=event_limit,
    )
    return result, target_path
