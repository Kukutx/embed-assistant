# Minimal token endpoint using only the Python standard library.
#   ASSISTANT_IDENTITY_SECRET=ea_whs_... python3 server.py
import base64, hashlib, hmac, json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["ASSISTANT_IDENTITY_SECRET"].encode()

def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def sign(claims: dict) -> str:
    body = f'{b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())}.{b64(json.dumps(claims).encode())}'
    return f"{body}.{b64(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())}"

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        user_id = self.headers.get("x-demo-user")  # replace with your authentication
        if self.path != "/api/assistant-token" or not user_id:
            self.send_response(401); self.end_headers(); return
        now = int(time.time())
        token = sign({"sub": user_id, "groups": ["customers"], "iat": now, "exp": now + 600})
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(token.encode())

HTTPServer(("127.0.0.1", 3001), Handler).serve_forever()
