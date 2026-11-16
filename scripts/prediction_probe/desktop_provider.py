"""Loopback-only Responses fixture for the actual Nezha desktop acceptance runner.

No credentials, external service, or transcript logging. Request content is inspected
in memory solely to assert parent isolation; the report contains counts/timings.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import json
import re
from pathlib import Path
import threading
import time


class Fixture:
    def __init__(self):
        self.lock = threading.Lock()
        self.mode = "ready"
        self.requests = []
        self.sequence = 0

    def response(self, request):
        encoded = json.dumps(request.get("input", []), ensure_ascii=False)
        sample = "This is an app-generated request for a suggested next user message." in encoded
        with self.lock:
            self.sequence += 1
            sequence = self.sequence
            phases = re.findall(r'phase=(returned|during|before)', encoded)
            mode = 'hold' if sample and phases and phases[-1] == 'during' else self.mode
            self.requests.append({"sequence": sequence, "sample": sample,
                                  "received_ns": time.perf_counter_ns(),
                                  "parent_prediction_marker": not sample and "nezha-next-message" in encoded,
                                  "mode": mode,
                                  "model": request.get("model"),
                                  "effort": request.get("reasoning", {}).get("effort"),
                                  "configuration_updates": [i for i in request.get("input", []) if i.get("type") == "configuration_update"]})
        if sample and mode == "hold":
            time.sleep(2)
        text = '{"suggestion":"Verify the fixture and report the result."}' if sample else "Fixture completed."
        if sample and mode == "null":
            text = '{"suggestion":null}'
        if sample and mode == "invalid":
            text = 'not JSON'
        item = {"type": "message", "id": f"msg_{sequence}", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}
        if sample and mode == "tool":
            item = {"type": "function_call", "id": f"fc_{sequence}", "call_id": f"call_{sequence}",
                    "name": "exec_command", "arguments": json.dumps({"cmd": "Set-Content prediction-must-not-execute.txt forbidden"})}
        events = [
            {"type": "response.created", "response": {"id": f"resp_{sequence}", "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": f"resp_{sequence}", "status": "completed", "output": [item],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}},
        ]
        return ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()


def serve(port_file):
    fixture = Fixture()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path != "/control":
                self.send_error(404)
                return
            with fixture.lock:
                body = json.dumps(fixture.requests).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path == "/control":
                with fixture.lock:
                    fixture.mode = body["mode"]
                data, content_type = b'{}', 'application/json'
            else:
                data, content_type = fixture.response(body), 'text/event-stream'
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    Path(port_file).write_text(str(server.server_port), encoding="utf-8")
    server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port-file', required=True)
    serve(parser.parse_args().port_file)
