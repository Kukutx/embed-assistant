# Identity: anonymous visitors and signed-in users

## Anonymous (default)

Without any setup every visitor is anonymous. The widget generates a random 128-bit id per browser and keeps it in `localStorage`, so a visitor sees their own history on that browser. Anonymous sessions can only read knowledge tagged `public`.

## Signed-in users

Your backend proves who the user is by signing a short JSON Web Token with the widget's **identity secret** (shown once when the widget is created; rotate it in the console). The secret must never reach the browser.

| Claim | Required | Meaning |
|---|---|---|
| `sub` | yes | Your stable user id (max 256 chars). |
| `exp` | yes | Expiry, Unix seconds, **at most 1 hour ahead**. |
| `iat` | no | Issued at. |
| `name` | no | Display name. |
| `email` | no | Email, for your own transcript review. |
| `groups` | no | Access groups (lowercase `a-z0-9_-`, up to 50). |

Algorithm: `HS256`. The server rejects other algorithms, wrong signatures, expired tokens and lifetimes over one hour.

A signed-in user's session gets the access tags `public`, `users` and each entry of `groups`. Knowledge sources are tagged when you create them; a chunk is searchable only if it shares at least one tag with the session. The filter runs inside the database query, before ranking, so restricted text never reaches the model for the wrong person.

Sessions created from a user token last at most one hour, so group changes on your side take effect quickly. The widget calls your token function again whenever it needs a new session.

### Wiring it up in the page

Expose an endpoint on your backend that returns a fresh token for the logged-in user, then:

```js
EmbedAssistant.identify(async () => {
  const res = await fetch("/api/assistant-token", { credentials: "include" });
  return res.ok ? res.text() : null; // null = continue anonymously
});
// On logout:
EmbedAssistant.identify(null);
```

Switching identity starts a new conversation, so one person never sees another's history.

## Long-term memory

Turn on **memory** on an assistant (`"memory": true`, or *Remember signed-in
users* in the console) and it keeps short facts that **signed-in users** share
(the language they prefer, the plan or product they use, their role) across
conversations. Anonymous visitors never get memory.

- The model saves a fact with a built-in `remember` tool and deletes one with
  `forget`; the visitor sees "Memory updated" when either runs. It is told not
  to keep passwords, payment or bank details or health information, and
  personal data masking (`redactPii`) applies to saved facts.
- The facts are given to the model as data in a delimited block, never as
  instructions. At most 50 per user are kept (identical facts are merged; the
  least recently confirmed go first).
- Users see what is remembered under *Conversations → What I remember* in the
  widget and can delete one fact or everything (`GET /v1/memories`,
  `DELETE /v1/memories/{id}`, `DELETE /v1/memories`).
- Admins can review and delete them per user
  (`GET`/`DELETE /v1/admin/subjects/{subjectId}/memories`); erasing a subject
  deletes them too; facts not used within the tenant's retention period
  expire.
- Memory belongs to the tenant and the user (`user:<sub>`), so every assistant
  of the tenant with memory turned on shares it.

## Signing examples

### Node.js (no dependencies)

```js
import { createHmac } from "node:crypto";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function assistantToken(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, name: user.name, groups: user.groups, iat: now, exp: now + 600 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
```

### Python (PyJWT)

```python
import time, jwt
def assistant_token(user, secret):
    now = int(time.time())
    return jwt.encode({"sub": user.id, "name": user.name, "groups": user.groups, "iat": now, "exp": now + 600}, secret, algorithm="HS256")
```

### Go (github.com/golang-jwt/jwt/v5)

```go
func AssistantToken(userID string, groups []string, secret []byte) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{"sub": userID, "groups": groups, "iat": now.Unix(), "exp": now.Add(10 * time.Minute).Unix()}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
}
```

### Java (com.auth0:java-jwt)

```java
String token = JWT.create()
    .withSubject(user.getId())
    .withArrayClaim("groups", user.getGroups())
    .withIssuedAt(Instant.now())
    .withExpiresAt(Instant.now().plusSeconds(600))
    .sign(Algorithm.HMAC256(secret));
```

### C# (System.IdentityModel.Tokens.Jwt)

```csharp
var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
var token = new JwtSecurityToken(
    claims: new[] { new Claim("sub", user.Id), new Claim("name", user.Name) },
    expires: DateTime.UtcNow.AddMinutes(10),
    signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
var jwt = new JwtSecurityTokenHandler().WriteToken(token);
```

### Ruby (jwt gem)

```ruby
now = Time.now.to_i
JWT.encode({ sub: user.id, groups: user.groups, iat: now, exp: now + 600 }, secret, "HS256")
```

### Rust (jsonwebtoken)

```rust
let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
let claims = json!({ "sub": user_id, "iat": now, "exp": now + 600 });
let token = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret.as_bytes()))?;
```
