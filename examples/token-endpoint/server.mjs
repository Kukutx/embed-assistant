// Minimal token endpoint with zero dependencies (Node.js 18+).
// Your real app would read the user from its own session instead of a header.
//   ASSISTANT_IDENTITY_SECRET=ea_whs_... node server.mjs
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const secret = process.env.ASSISTANT_IDENTITY_SECRET;
if (!secret) throw new Error("set ASSISTANT_IDENTITY_SECRET");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims) {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

createServer((req, res) => {
  if (req.url !== "/api/assistant-token") return res.writeHead(404).end();
  const userId = req.headers["x-demo-user"]; // replace with your authentication
  if (!userId) return res.writeHead(401).end();
  const now = Math.floor(Date.now() / 1000);
  const token = sign({ sub: String(userId), groups: ["customers"], iat: now, exp: now + 600 });
  res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(token);
}).listen(3001, () => console.log("token endpoint on http://localhost:3001/api/assistant-token"));
