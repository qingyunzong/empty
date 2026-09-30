"""Loss-script loading and validation.

Script format (JSON object):
    {
        "frames": 10,          // total new frames, seq 1..frames, one per tick
        "drop": [3],           // seqs lost on first transmission
        "drop_retx": [],       // seqs whose retransmissions are also lost
        "duplicate": []        // seqs delivered a second time 2 ticks later
    }
All seq lists must be strictly increasing; a non-increasing list raises
ConfigError.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .errors import ConfigError


@dataclass(frozen=True)
class Script:
    frames: int
    drop: tuple[int, ...] = ()
    drop_retx: tuple[int, ...] = ()
    duplicate: tuple[int, ...] = ()


def _seq_list(data: dict, key: str, frames: int) -> tuple[int, ...]:
    value = data.get(key, [])
    if not isinstance(value, list) or any(
        not isinstance(x, int) or isinstance(x, bool) for x in value
    ):
        raise ConfigError(f"'{key}' must be a list of integers")
    for prev, cur in zip(value, value[1:]):
        if cur <= prev:
            raise ConfigError(
                f"'{key}' must be strictly increasing; "
                f"got non-increasing sequence {value}"
            )
    for seq in value:
        if not 1 <= seq <= frames:
            raise ConfigError(
                f"'{key}' entry {seq} out of range 1..{frames}"
            )
    return tuple(value)


def parse_script(data: object) -> Script:
    if not isinstance(data, dict):
        raise ConfigError("script must be a JSON object")
    frames = data.get("frames")
    if not isinstance(frames, int) or isinstance(frames, bool) or frames < 1:
        raise ConfigError("'frames' must be a positive integer")
    return Script(
        frames=frames,
        drop=_seq_list(data, "drop", frames),
        drop_retx=_seq_list(data, "drop_retx", frames),
        duplicate=_seq_list(data, "duplicate", frames),
    )


def load_script(path: str) -> Script:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON in {path}: {exc}") from exc
    return parse_script(data)
