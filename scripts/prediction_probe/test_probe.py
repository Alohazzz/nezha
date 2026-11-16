import os
import unittest
from probe import run_probe, classify

@unittest.skipUnless(os.environ.get('CODEX_PROBE_EXE'), 'Set CODEX_PROBE_EXE for real-binary integration tests')
class ProtocolTests(unittest.TestCase):
    def test_stale_sample_is_rejected_without_starting_a_turn(self):
        result = run_probe(os.environ['CODEX_PROBE_EXE'])
        self.assertTrue(result['initialized'])
        self.assertEqual(result['stale_sample']['classification'], 'source_rejected')
        self.assertEqual(result['turn_notifications'], 0)

class ErrorClassificationTests(unittest.TestCase):
    def test_protocol_incompatibility_is_distinct_from_transient_failures(self):
        self.assertEqual(classify({'error': {'code': -32601, 'message': 'Method not found'}}), 'unsupported')
        self.assertEqual(classify({'error': {'code': -32600, 'message': 'unknown field `interruptOnCancel`'}}), 'unsupported')
        for message in ['401 Unauthorized', '429 rate limited', 'connection reset', 'model unavailable']:
            self.assertEqual(classify({'error': {'code': -32600, 'message': message}}), 'unknown_error')

if __name__ == '__main__':
    unittest.main()
