"""选择重传（Selective Repeat）协议仿真包。"""

from .protocol import Receiver, Sender, VirtualClock, validate_params
from .simulation import Simulation

__all__ = ["Receiver", "Sender", "Simulation", "VirtualClock", "validate_params"]
