import os
import unittest
from controlled import run_controlled

@unittest.skipUnless(os.environ.get('CODEX_PROBE_EXE'), 'Set CODEX_PROBE_EXE for real-binary integration tests')
class ControlledTests(unittest.TestCase):
    def test_sample_intercepts_tool_and_keeps_parent_clean(self):
        report = run_controlled(os.environ['CODEX_PROBE_EXE'])
        self.assertTrue(report['tool_intercepted'])
        self.assertTrue(report['parent_unchanged'])
        self.assertTrue(report['context_inherited'])
        self.assertTrue(report['injected_tool_advertised'])
        self.assertTrue(report['rollouts_unchanged'])
        self.assertFalse(report['execution_marker_exists'])
        self.assertTrue(report['only_parent_loaded'])
        self.assertTrue(report['cold_resume_after_close'])

    def test_cancellation_does_not_block_parent_resume(self):
        report = run_controlled(os.environ['CODEX_PROBE_EXE'], cancel=True)
        self.assertTrue(report['cancel_acknowledged'])
        self.assertLess(report['parent_start_ms'], 250)
        self.assertTrue(report['cancelled_sample_rejected'])

    def test_sample_inherits_compacted_context(self):
        report = run_controlled(os.environ['CODEX_PROBE_EXE'], compact=True)
        self.assertTrue(report['compacted_context_inherited'])
        self.assertTrue(report['parent_unchanged'])

    def test_sample_high_effort_does_not_change_medium_parent(self):
        report = run_controlled(os.environ['CODEX_PROBE_EXE'], effort=True)
        self.assertEqual(report['request_efforts'], ['medium', 'medium', 'medium'])
        self.assertEqual(report['config_updates'][1][-1], {'type': 'configuration_update', 'reasoning': {'effort': 'high'}})
        self.assertEqual(report['config_updates'][0], report['config_updates'][2])

if __name__ == '__main__':
    unittest.main()
