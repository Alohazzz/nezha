"""Public stdio RPC probe. Uses an isolated CODEX_HOME; never reads account auth."""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


class Rpc:
    def __init__(self, executable, root, existing_login=False):
        env = os.environ.copy()
        if not existing_login:
            env['CODEX_HOME'] = str(root / 'home')
            Path(env['CODEX_HOME']).mkdir(exist_ok=True)
        args = [executable, 'app-server', '--stdio']
        if existing_login:
            args += ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'web_search="disabled"']
        self.process = subprocess.Popen(
            args, cwd=root, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.frames = queue.Queue()
        self.notifications = []
        self.server_requests = []
        self.next_id = 100
        self.responses = {}
        self.closed = False
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.frames.put(json.loads(line))
            except json.JSONDecodeError:
                self.frames.put({'probe_error': 'non_json_stdout'})
        self.frames.put({'probe_error': 'process_closed'})

    def send(self, method, params, request=True):
        self.next_id += 1
        frame = {'method': method, 'params': params}
        if request:
            frame['id'] = self.next_id
        self.process.stdin.write(json.dumps(frame) + '\n')
        self.process.stdin.flush()
        return self.next_id

    def wait(self, request_id, timeout=15):
        if request_id in self.responses:
            return self.responses.pop(request_id)
        deadline = time.perf_counter() + timeout
        while True:
            frame = self.frames.get(timeout=max(0.001, deadline-time.perf_counter()))
            if 'probe_error' in frame:
                raise RuntimeError(frame['probe_error'])
            if 'method' in frame:
                if 'id' in frame:
                    self.server_requests.append(frame)
                    self.process.stdin.write(json.dumps({'id': frame['id'], 'error': {'code': -32601, 'message': 'Probe refuses server requests'}}) + '\n')
                    self.process.stdin.flush()
                else:
                    self.notifications.append(frame)
            elif frame.get('id') == request_id:
                return frame
            else:
                self.responses[frame['id']] = frame
            if time.perf_counter() >= deadline:
                raise TimeoutError('RPC deadline exceeded')

    def request(self, method, params):
        return self.wait(self.send(method, params))

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self.reader.join(timeout=1)
        self.process.stdout.close()


def classify(response):
    error = response.get('error')
    if not error:
        return 'response'
    message = error.get('message', '').lower()
    if error.get('code') == -32601 or 'unknown variant `thread/sample' in message or 'unknown field `' in message:
        return 'unsupported'
    if 'thread' in message and ('not found' in message or 'invalid' in message or 'not loaded' in message or 'requires a loaded source' in message):
        return 'source_rejected'
    return 'unknown_error'


def run_probe(executable):
    with tempfile.TemporaryDirectory(prefix='nezha-prediction-') as directory:
        root = Path(directory)
        rpc = Rpc(executable, root)
        try:
            initialized = rpc.request('initialize', {'clientInfo': {'name': 'nezha_prediction_probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
            rpc.send('initialized', {}, request=False)
            stale = rpc.request('thread/sample', {'threadId': '00000000-0000-0000-0000-000000000000', 'expectedTurnId': 'missing', 'prompt': 'Return null.', 'effort': 'high', 'disableMcp': True})
            return {'initialized': 'result' in initialized, 'stale_sample': {'classification': classify(stale), 'response': stale}, 'turn_notifications': len([n for n in rpc.notifications if n['method'].startswith('turn/')])}
        finally:
            rpc.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', required=True)
    args = parser.parse_args()
    print(json.dumps(run_probe(args.codex), indent=2))
