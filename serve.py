"""Serves this repository for the demo page and the tests, on http://127.0.0.1:8771/demo/.

A threaded WebAssembly build needs the page to be cross-origin isolated (the COOP and COEP
headers). Every file is revalidated (`no-cache`); unchanged files come back as 304.

Run: uv run serve.py [port]
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8771
    handler = partial(Handler, directory=str(HERE))
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    main()
