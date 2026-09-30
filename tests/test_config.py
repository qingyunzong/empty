import unittest

from nakproto import ConfigError, parse_config


class TestConfig(unittest.TestCase):
    def test_valid_minimal_script(self):
        cfg = parse_config({"frames": [1, 2, 3]})
        self.assertEqual(cfg.frames, [1, 2, 3])
        self.assertEqual(cfg.window, 8)
        self.assertEqual(cfg.debounce, 20)

    def test_non_increasing_frames_raise_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 3, 2, 4]})

    def test_duplicate_frames_raise_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 2, 2, 3]})

    def test_non_increasing_loss_list_raises_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 2, 3, 4], "loss": [3, 2]})

    def test_non_increasing_loss_permanent_raises_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 2, 3, 4], "loss_permanent": [4, 2]})

    def test_loss_seq_not_in_frames_raises_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 2, 3], "loss": [9]})

    def test_empty_frames_raise_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": []})

    def test_missing_frames_raise_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"loss": [1]})

    def test_delay_for_unknown_seq_raises_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 2], "delay": {"5": 1}})

    def test_invalid_window_raises_config_error(self):
        with self.assertRaises(ConfigError):
            parse_config({"frames": [1, 2], "window": 0})


if __name__ == "__main__":
    unittest.main()
