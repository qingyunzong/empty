"""netsim: deterministic single-process network simulator."""
from .config import ConfigError
from .sim import Simulator

__version__ = "0.1.0"
__all__ = ["ConfigError", "Simulator", "__version__"]
