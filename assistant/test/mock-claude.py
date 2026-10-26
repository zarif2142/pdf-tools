# A stand-in for the Claude API, for trying the assistant locally without an
# API key: streams a fixed Markdown answer and saves the last request it got.
# Run: python3 test/mock-claude.py 8799, and set ANTHROPIC_BASE_URL in .dev.vars.
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ANSWER = "Here's what this letter says, **in simple words**:\n\n1. Your bill is **$84.20**.\n2. It's due on *March 3*.\n3. You can pay online at https://example.com.\n\n| Item | Cost |\n|---|---|\n| Water | $60.00 |\n| Fees | $24.20 |\n\nNothing here looks like a scam."

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with open(sys.argv[2] if len(sys.argv) > 2 else "/tmp/mock-claude-last.json", "wb") as f:
            f.write(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        def ev(t, d):
            self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode()); self.wfile.flush()
        ev("message_start", {"type": "message_start", "message": {"id": "msg_mock", "type": "message", "role": "assistant",
            "model": "claude-opus-5-5", "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 0}}})
        ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
        for i in range(0, len(ANSWER), 12):
            ev("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": ANSWER[i:i+12]}})
            time.sleep(0.03)
        ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 50}})
        ev("message_stop", {"type": "message_stop"})
    def log_message(self, *a): pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
