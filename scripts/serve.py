"""Local preview server for the website (no caching, so edits show up on reload)."""
import functools
import http.server
import sys
from pathlib import Path


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = Path(__file__).resolve().parent.parent / "web"
handler = functools.partial(NoCache, directory=str(root))
print(f"serving {root} at http://127.0.0.1:{port}")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
