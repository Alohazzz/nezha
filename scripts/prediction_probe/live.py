"""Opt-in live model smoke check using the CLI's existing login, never reading credentials."""
import argparse
import json
from pathlib import Path
import tempfile
import time
from probe import Rpc
from controlled import good, completed


def run_live(executable, model):
    with tempfile.TemporaryDirectory(prefix='nezha-live-prediction-') as directory:
        rpc = Rpc(executable, Path(directory), existing_login=True)
        try:
            good(rpc.request('initialize', {'clientInfo': {'name': 'nezha_prediction_probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}}))
            rpc.send('initialized', {}, request=False)
            catalog = good(rpc.request('model/list', {}))['data']
            selected = next(m for m in catalog if m['model'] == model)
            parent = good(rpc.request('thread/start', {'cwd': directory, 'model': model, 'ephemeral': False, 'approvalPolicy': 'never', 'sandbox': 'read-only', 'baseInstructions': 'Answer briefly. Never call tools. This is a synthetic protocol compatibility fixture.'}))
            thread = parent['thread']['id']
            good(rpc.request('turn/start', {'threadId': thread, 'effort': 'medium', 'input': [{'type': 'text', 'text': 'I plan a small herb garden. Suggest two herbs in one short sentence; do not call tools.'}]}))
            turn = completed(rpc)
            before = good(rpc.request('thread/read', {'threadId': thread, 'includeTurns': True}))
            start = time.perf_counter()
            sample = rpc.wait(rpc.send('thread/sample', {'threadId': thread, 'expectedTurnId': turn, 'prompt': 'Predict one short next user message from this conversation. Return only JSON with one key suggestion and a string value. Do not use tools.', 'effort': 'high', 'disableMcp': True, 'interruptOnCancel': True, 'threadSource': 'composer_predictions', 'turnTrigger': 'composer_predictions'}), timeout=30)
            elapsed = (time.perf_counter() - start) * 1000
            after = good(rpc.request('thread/read', {'threadId': thread, 'includeTurns': True}))
            result = sample.get('result', {})
            report = {'model': model, 'effective_model': parent['model'], 'provider': parent['modelProvider'], 'advertised_efforts': [e['reasoningEffort'] for e in selected['supportedReasoningEfforts']], 'parent_effort': 'medium', 'sample_requested_effort': 'high', 'sample_elapsed_ms': round(elapsed, 2), 'sample_result': 'text' if result.get('text') else 'no_text', 'parent_unchanged': before == after, 'server_requests': len(rpc.server_requests)}
            if 'error' in sample:
                report['error'] = sample['error']
            else:
                try:
                    parsed = json.loads(result.get('text', ''))
                    report['valid_suggestion_json'] = set(parsed) == {'suggestion'} and isinstance(parsed['suggestion'], str)
                except (ValueError, TypeError):
                    report['valid_suggestion_json'] = False
            return report
        finally:
            try:
                if 'thread' in locals():
                    rpc.request('thread/archive', {'threadId': thread})
            finally:
                rpc.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', required=True)
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    print(json.dumps(run_live(args.codex, args.model), indent=2))
