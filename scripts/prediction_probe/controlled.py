"""Deterministic loopback Responses fixture; the app-server binary is real."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
from pathlib import Path
import tempfile
import threading
import time
from probe import Rpc


class Model:
    def __init__(self):
        self.requests = []
        self.items = []
        self.arrived = threading.Event()
        self.release = threading.Event()
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                outer.requests.append(json.loads(body))
                item = outer.items.pop(0)
                if item == 'hold':
                    outer.arrived.set()
                    outer.release.wait(timeout=10)
                    item = {'type': 'message', 'id': 'held', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'late', 'annotations': []}]}
                events = [
                    {'type': 'response.created', 'response': {'id': 'resp_fixture', 'status': 'in_progress', 'output': []}},
                    {'type': 'response.output_item.added', 'output_index': 0, 'item': item},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                    {'type': 'response.completed', 'response': {'id': 'resp_fixture', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}},
                ]
                data = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def text(self, value):
        self.items.append({'type': 'message', 'id': 'msg_fixture', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': value, 'annotations': []}]})

    def close(self):
        self.release.set()
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)


def good(frame):
    if 'error' in frame:
        raise RuntimeError(json.dumps(frame['error']))
    return frame['result']


def completed(rpc):
    deadline = time.perf_counter() + 20
    while time.perf_counter() < deadline:
        frame = rpc.frames.get(timeout=max(.001, deadline-time.perf_counter()))
        if 'method' in frame:
            rpc.notifications.append(frame)
        if frame.get('method') == 'turn/completed':
            turn = frame['params']['turn']
            if turn['status'] != 'completed':
                raise RuntimeError(json.dumps(turn))
            return turn['id']
    raise TimeoutError('Parent turn did not complete')


def run_controlled(executable, cancel=False, compact=False, effort=False, model_name=None):
    model = Model()
    try:
        with tempfile.TemporaryDirectory(prefix='nezha-sample-model-') as directory:
            root = Path(directory)
            (root / 'home').mkdir()
            (root / 'home' / 'config.toml').write_text('model = "gpt-5.1-codex"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Loopback fixture"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:'+str(model.http.server_port)+'/v1"\n', encoding='utf-8')
            if effort or model_name:
                catalog_path = root / 'catalog.json'
                catalog = json.loads(Path(__file__).with_name('model.json').read_text(encoding='utf-8-sig'))
                if model_name:
                    catalog['slug'] = model_name
                catalog_path.write_text(json.dumps({'models': [catalog]}), encoding='utf-8')
                config = 'model = "prediction-fixture"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "medium"\nfeatures.reasoning_effort_override = true\nmodel_catalog_json = '+json.dumps(str(catalog_path))+'\n[model_providers.fixture]\nname = "OpenAI"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:'+str(model.http.server_port)+'/v1"\n'
                if model_name:
                    config = config.replace('model = "prediction-fixture"', 'model = '+json.dumps(model_name))
                (root / 'home' / 'config.toml').write_text(config, encoding='utf-8')
            rpc = Rpc(executable, root)
            try:
                good(rpc.request('initialize', {'clientInfo': {'name': 'nezha_prediction_probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}}))
                rpc.send('initialized', {}, request=False)
                thread = good(rpc.request('thread/start', {'cwd': str(root), 'approvalPolicy': 'never', 'sandbox': 'workspace-write', 'experimentalRawEvents': False}))['thread']['id']
                model.text('Acknowledged the cobalt-harbor fixture.')
                good(rpc.request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': 'Remember the unique marker cobalt-harbor. Reply briefly, do not use tools.'}]}))
                turn = completed(rpc)
                if compact:
                    model.text('COMPACTED_COBALT_CONTEXT: user wants the cobalt-harbor fixture verified.')
                    good(rpc.request('thread/compact/start', {'threadId': thread}))
                    turn = completed(rpc)
                before = good(rpc.request('thread/read', {'threadId': thread, 'includeTurns': True}))
                def rollouts():
                    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (root / 'home' / 'sessions').rglob('*.jsonl')}
                files_before = rollouts()
                if effort:
                    model.text('{"suggestion":"Verify the fixture."}')
                    good(rpc.request('thread/sample', {'threadId': thread, 'expectedTurnId': turn, 'prompt': 'Predict next message.', 'effort': 'high', 'disableMcp': True}))
                    model.text('Parent still uses medium.')
                    good(rpc.request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': 'Continue.'}]}))
                    completed(rpc)
                    return {'request_efforts': [r.get('reasoning', {}).get('effort') for r in model.requests], 'config_updates': [[i for i in r.get('input', []) if i.get('type') == 'configuration_update'] for r in model.requests]}
                if cancel:
                    model.items.append('hold')
                    sample_id = rpc.send('thread/sample', {'threadId': thread, 'expectedTurnId': turn, 'prompt': 'held sample', 'interruptOnCancel': True})
                    if not model.arrived.wait(timeout=5):
                        raise TimeoutError('Sample never reached provider')
                    started = time.perf_counter()
                    ack = rpc.request('thread/sample/cancel', {'requestId': sample_id})
                    cancel_ms = (time.perf_counter() - started) * 1000
                    model.text('Resumed normally.')
                    resumed = rpc.request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': 'Resume without tools.'}]})
                    parent_ms = (time.perf_counter() - started) * 1000
                    cancelled = rpc.wait(sample_id)
                    completed(rpc)
                    return {'cancel_acknowledged': 'result' in ack, 'cancel_ms': cancel_ms, 'parent_start_ms': parent_ms, 'parent_started': 'result' in resumed, 'cancelled_sample_rejected': 'error' in cancelled, 'cancelled_response': cancelled}
                model.items.append({'type': 'function_call', 'id': 'fc_fixture', 'call_id': 'call_fixture', 'name': 'exec_command', 'arguments': json.dumps({'cmd': 'Set-Content -LiteralPath prediction-probe-executed.txt -Value sentinel'})})
                sample = good(rpc.request('thread/sample', {'threadId': thread, 'expectedTurnId': turn, 'prompt': 'PROBE_SAMPLE_MARKER: suggest next user message.', 'effort': 'high', 'disableMcp': True, 'interruptOnCancel': True}))
                after = good(rpc.request('thread/read', {'threadId': thread, 'includeTurns': True}))
                loaded = good(rpc.request('thread/loaded/list', {}))['data']
                report = {'only_parent_loaded': loaded == [thread], 'tool_intercepted': sample.get('text') is None and not rpc.server_requests and not any('commandExecution' in json.dumps(n) for n in rpc.notifications), 'parent_unchanged': before == after, 'rollouts_unchanged': bool(files_before) and files_before == rollouts(), 'execution_marker_exists': (root / 'prediction-probe-executed.txt').exists(), 'context_inherited': 'cobalt-harbor' in json.dumps(model.requests[-1]), 'compacted_context_inherited': 'COMPACTED_COBALT_CONTEXT' in json.dumps(model.requests[-1].get('input')), 'injected_tool_advertised': 'exec_command' in json.dumps(model.requests[-1].get('tools', [])), 'sample_response': sample, 'model_requests': len(model.requests)}
                rpc.close()
                fresh = Rpc(executable, root)
                try:
                    good(fresh.request('initialize', {'clientInfo': {'name': 'nezha_prediction_probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}}))
                    fresh.send('initialized', {}, request=False)
                    resumed = good(fresh.request('thread/resume', {'threadId': thread}))
                    report['cold_resume_after_close'] = resumed['thread']['id'] == thread
                finally:
                    fresh.close()
                return report
            finally:
                rpc.close()
    finally:
        model.close()


if __name__ == '__main__':
    import sys
    print(json.dumps(run_controlled(sys.argv[1]), indent=2))
