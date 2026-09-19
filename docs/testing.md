# Testing and troubleshooting

## Smoke test without a Blesta install

The server can be exercised end to end with a fake Blesta HTTP server. This is how the project was verified.

1. Start a mock that logs requests and answers `{"response": ...}`:

```js
// mock.mjs
import http from "node:http";
const routes = {
  "clients/search": [{ id: 1, first_name: "Ada", email: "ada@example.com" }],
  "clients/getSearchCount": 1,
  "invoices/get": { id: 7, id_code: "INV-0007", client_id: "1", status: "active", currency: "USD", total: "10.00", paid: "2.50", due: "7.50", date_due: "2026-10-01 00:00:00", date_closed: null, line_items: [] },
  "invoices/createPayHash": "abcdef0123456789",
  "invoices/verifyPayHash": true,
  "encryption/systemEncrypt": "ENC_TOKEN",
  "encryption/systemDecrypt": "c=1|h=abcdef0123456789",
  "transactions/getApplied": [{ transaction_id: 11, invoice_id: 7, applied_amount: "2.50", status: "approved" }],
};
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const key = url.pathname.replace(/^\/api\//, "").replace(/\.json$/, "");
  console.error(req.method, url.pathname + url.search, body);
  if (!(key in routes)) { res.writeHead(404); return res.end(JSON.stringify({ message: "The requested resource does not exist." })); }
  res.end(JSON.stringify({ response: routes[key] }));
}).listen(18765);
```

2. Run the server against it and send MCP messages on stdin (one JSON-RPC object per line):

```bash
node mock.mjs &
BLESTA_URL=http://127.0.0.1:18765 BLESTA_ALLOW_HTTP=1 BLESTA_API_USER=u BLESTA_API_KEY=k \
node dist/index.js <<'EOF2'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_clients","arguments":{"query":"ada@example.com"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_invoice_payment_link","arguments":{"client_id":1,"invoice_id":7}}}
EOF2
```

The mock's stderr shows the exact method, path, query and body the server sent, which is the place to confirm parameter names and encoding.

## First calls against a real install

Use `BLESTA_READ_ONLY=1` and run in this order; each step exercises a different part of the contract.

1. `search_clients` with a known email. Proves auth, URL and JSON unwrapping.
2. `get_client` with the returned `id`. Proves numeric IDs and `get_settings` boolean encoding.
3. `search_invoices` with `client_id` and `status: "all"`. Proves array-valued `order_by`/`filters` encoding.
4. `get_invoice_payments`. First call that omits a trailing optional argument (`transaction_id`); watch for the IonCube error described below.
5. `get_client_services` with `include_renewal_price: true`.
6. `create_invoice_payment_link` (needs `BLESTA_SYSTEM_KEY` on IonCube installs), then open the URL in a private browser window. Blesta should show the payment-method page for that invoice without a login prompt.
7. `verify_invoice_payment_link` with the URL from step 6.

## Verification status

| Group | Verified how |
|---|---|
| 25 read tools | live, read-only, against a Blesta 5.x IonCube install (`download_invoice_pdf` needs the Component API plugin installed there) |
| `create_invoice_payment_link` / `verify_invoice_payment_link` | live; generated link opens the payment page without a login |
| 10 write tools | mock only: paths, parameter names and encoding checked against `app/models/*.php` validation rules; refused live under `BLESTA_READ_ONLY=1` |

Safest first live write: `add_client_note` on a test client with an unmistakable title, then remove it with `blesta_call` `clients/deleteNote` (`{ "note_id": N }`, DELETE). Run that once with `BLESTA_READ_ONLY` unset before trusting the other write tools.

## Common problems

**`Missing required environment variable(s): BLESTA_URL, ...`**
The server exits at startup. Set the variables in the MCP client's `env` block, not in your shell profile (MCP clients spawn the server with a controlled environment).

**`BLESTA_URL must use https://`**
Deliberate. Set `BLESTA_ALLOW_HTTP=1` only for a local mock.

**HTTP 401 `The authorization details given appear to be invalid.`**
Wrong user/key, or the key belongs to a different company than the one at that hostname. Regenerate under Settings > System > API Access. Also check the reverse proxy passes custom headers (`BLESTA-API-USER`, `BLESTA-API-KEY`); some strip underscores or unknown headers.

**HTTP 404 `The requested resource does not exist.`**
Model name must be the URL form (`clients`, `service_changes`, `client_groups`), not the class name. Method names are camelCase exactly as in PHP (`getList`, not `get_list`). If the install has no `.htaccess` support, set `BLESTA_URL` to `https://host/installpath/index.php` so the path becomes `/index.php/api/...`.

**HTTP 403 `The requested resource is not accessible.`**
The method is private/protected or the model is not exposed. Only public model methods are callable.

**HTTP 400 with `errors`**
Validation failure. The tool result lists each field, e.g. `vars.lines.0.amount.format: Amount must be a number.` Fix the input and retry.

**HTTP 500 `Failed to retrieve the default value`**
IonCube could not resolve a default argument. Use `blesta_call` and pass every optional argument explicitly with its documented default (for example `services/getList` with `order_by`, `children`, `filters` and `formatted_filters` all set). Report which curated tool hit it so the call can be made explicit in code.

**`create_invoice_payment_link` fails with `Failed to retrieve the default value`**
IonCube-encoded `AppModel`. Copy the `Blesta.system_key` value from `config/blesta.php` on the Blesta server into a private file and point `BLESTA_SYSTEM_KEY_FILE` at it (or set `BLESTA_SYSTEM_KEY` directly), then restart the MCP server:

```bash
mkdir -p ~/.config/blesta-mcp && chmod 700 ~/.config/blesta-mcp
# paste the key as the only content of the file, no quotes
${EDITOR:-nano} ~/.config/blesta-mcp/system_key && chmod 600 ~/.config/blesta-mcp/system_key
```

**Key check before trusting `BLESTA_SYSTEM_KEY`**
Hosts sometimes carry more than one Blesta tree (a live install plus a stale copy) with different keys. Confirm the key belongs to the live install before configuring it: `encryption/systemHash` with `value: "c=<client_id>|i=<invoice_id>"`, `key: <system_key>`, `hash: "sha256"` must end with the same 16 characters that `invoices/createPayHash` returns for that client and invoice. A mismatch means the wrong key, and the symptom (link bounces to login) is identical to the IonCube failure.

**Payment link opens the login page instead of the payment page**
Either the `sid` was encrypted with the wrong key (wrong `BLESTA_SYSTEM_KEY`, or none on an IonCube install) or `BLESTA_CLIENT_URI` does not match the install. Default is `client/`; check the "Client URI" under Settings > System > General, or compare with a link from a real Blesta payment reminder email.

**Output ends with `...[truncated N chars ...]`**
Result exceeded 60,000 characters. Page (`page: 2`), narrow the status filter, or for `blesta_call` raise `max_chars` up to 200,000.

**Server starts but the client lists no tools**
Run `node dist/index.js` manually; anything printed to stderr is a startup error. Confirm `npm run build` succeeded and the client points at the absolute path of `dist/index.js`.

## Logging

The server writes nothing to stdout except MCP messages (stdout is the protocol channel). Startup errors go to stderr. To see raw HTTP traffic during development, put a logging proxy such as the mock above between the server and Blesta, or add a temporary `console.error(url)` in `BlestaClient.call`; never log the `BLESTA-API-KEY` header.
