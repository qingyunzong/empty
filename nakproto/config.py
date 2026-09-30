"""Loss-script loading and validation for the NAK protocol simulator."""

from __future__ import annotations

import json
from dataclasses import dataclass, field


class ConfigError(Exception):
    """Raised when a loss script is invalid (e.g. non-increasing seq numbers)."""


@dataclass
class Config:
    frames: list[int]
    loss: set[int] = field(default_factory=set)
    loss_permanent: set[int] = field(default_factory=set)
    delay: dict[int, int] = field(default_factory=dict)
    window: int = 8
    debounce: int = 20
    max_ticks: int = 10000


def _require_increasing(name: str, values: list[int]) -> None:
    for prev, cur in zip(values, values[1:]):
        if cur <= prev:
            raise ConfigError(
                f"{name}: sequence numbers must be strictly increasing, "
                f"got {prev} followed by {cur}"
            )


def _as_int_list(name: str, value: object) -> list[int]:
    if not isinstance(value, list) or not all(isinstance(v, int) for v in value):
        raise ConfigError(f"{name}: must be a list of integers")
    return list(value)


def parse_config(data: object) -> Config:
    if not isinstance(data, dict):
        raise ConfigError("script must be a JSON object")

    if "frames" not in data:
        raise ConfigError("frames: required field missing")
    frames = _as_int_list("frames", data["frames"])
    if not frames:
        raise ConfigError("frames: must not be empty")
    _require_increasing("frames", frames)
    known = set(frames)

    loss = _as_int_list("loss", data.get("loss", []))
    _require_increasing("loss", loss)
    loss_permanent = _as_int_list("loss_permanent", data.get("loss_permanent", []))
    _require_increasing("loss_permanent", loss_permanent)
    for name, seqs in (("loss", loss), ("loss_permanent", loss_permanent)):
        unknown = [s for s in seqs if s not in known]
        if unknown:
            raise ConfigError(f"{name}: sequence(s) {unknown} not present in frames")

    raw_delay = data.get("delay", {})
    if not isinstance(raw_delay, dict):
        raise ConfigError("delay: must be an object mapping seq to tick count")
    delay: dict[int, int] = {}
    for key, value in raw_delay.items():
        try:
            seq = int(key)
        except (TypeError, ValueError):
            raise ConfigError(f"delay: invalid sequence key {key!r}") from None
        if seq not in known:
            raise ConfigError(f"delay: sequence {seq} not present in frames")
        if not isinstance(value, int) or value < 0:
            raise ConfigError(f"delay: ticks for seq {seq} must be a non-negative integer")
        delay[seq] = value

    window = data.get("window", 8)
    if not isinstance(window, int) or window < 1:
        raise ConfigError("window: must be a positive integer")
    debounce = data.get("debounce", 20)
    if not isinstance(debounce, int) or debounce < 1:
        raise ConfigError("debounce: must be a positive integer")
    max_ticks = data.get("max_ticks", 10000)
    if not isinstance(max_ticks, int) or max_ticks < 1:
        raise ConfigError("max_ticks: must be a positive integer")

    return Config(
        frames=frames,
        loss=set(loss),
        loss_permanent=set(loss_permanent),
        delay=delay,
        window=window,
        debounce=debounce,
        max_ticks=max_ticks,
    )


def load_config(path: str) -> Config:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise ConfigError(f"cannot read script {path!r}: {exc}") from None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON in {path!r}: {exc}") from None
    return parse_config(data)
