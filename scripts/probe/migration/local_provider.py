"""Finite, synthetic SSE traffic for the Linux release-resource probe."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Provider:
    def __init__(self):
        self.requests = []
        self.cancel_closed = threading.Event()
        self.errors = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append(body)
                if len(owner.requests) > 2:
                    owner.errors.append('request limit exceeded')
                    self.send_error(429)
                    return
                cancel = 'cancel-probe' in json.dumps(body['messages'][-1])
                if not body.get('stream'):
                    owner.errors.append('expected streaming request')
                    self.send_error(400)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    def chunk(text, finish=None):
                        item = {'id': 'fixture', 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': {'content': text}, 'finish_reason': finish}]}
                        self.wfile.write(('data: ' + json.dumps(item) + '\n\n').encode())
                        self.wfile.flush()
                    chunk('CANCEL_BEGIN\n' if cancel else 'STREAM_BEGIN\n')
                    for index in range(1000 if cancel else 80):
                        chunk(f'Line {index}: **synthetic** 中文 prose.\n')
                        time.sleep(.04)
                    chunk('CANCEL_END' if cancel else 'STREAM_END', 'stop')
                    self.wfile.write(b'data: [DONE]\n\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    if cancel:
                        owner.cancel_closed.set()
                    else:
                        owner.errors.append('normal stream disconnected')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self):
        return self.server.server_port

    def close(self):
        self.server.shutdown()
        self.server.server_close()
