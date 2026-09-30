"""nakproto: receiver-NAK reliable-delivery protocol simulator."""

from .errors import ConfigError
from .script import Script, load_script, parse_script
from .sim import NAK_DEBOUNCE, WINDOW, SimResult, run_simulation

__all__ = [
    "ConfigError",
    "Script",
    "load_script",
    "parse_script",
    "run_simulation",
    "SimResult",
    "WINDOW",
    "NAK_DEBOUNCE",
]
