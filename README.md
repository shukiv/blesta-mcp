# blesta-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes the [Blesta](https://www.blesta.com) billing API to LLM agents (Claude Code, Claude Desktop, Hermes, or any MCP client).

It ships a small set of purpose-built, read-only tools for the common support workflow (find a customer, look at their invoices, services and payments, hand them a pay link) plus a generic `blesta_call` escape hatch that can reach every public model method Blesta exposes.

## Tools

| Tool | What it does | Blesta methods |
| --- | --- | --- |
| `search_clients` | Find customers by email, name, company or client number | `Clients.search`, `Clients.getSearchCount` |
| `get_client` | Full client record, optionally with effective settings | `Clients.get` |
| `search_invoices` | Free-text invoice search, or list a client's invoices by status | `Invoices.search`, `Invoices.getList`, `getListCount` |
| `get_invoice` | Invoice details, line items, totals, paid/due | `Invoices.get` |
| `get_invoice_payments` | Transactions applied to an invoice and their status | `Transactions.getApplied`, `Transactions.get` |
| `get_client_services` | A client's services with status, renewal date and price; or one service in full | `Services.getList`, `Services.get`, `Services.getRenewalPrice` |
| `create_invoice_payment_link` | Build a no-login "pay now" URL for one invoice | `Invoices.createPayHash`, `Encryption.systemEncrypt` |
| `verify_invoice_payment_link` | Validate a hash or `sid` token against client + invoice and report if payment is still due | `Invoices.verifyPayHash`, `Encryption.systemDecrypt`, `Invoices.get` |
| `get_client_contacts` | Contacts under a client with phone numbers | `Contacts.getAll`, `Contacts.getNumbers` |
| `get_client_notes` | Staff notes and sticky notes | `Clients.getNoteList`, `getNoteListCount`, `getAllStickyNotes` |
| `get_client_balance` | Amount due per currency and invoice counts by status | `Invoices.amountDue`, `Invoices.getStatusCount` |
| `get_client_transactions` | Payment history with filters | `Transactions.getList`, `getListCount` |
| `get_transaction` | One payment plus applied invoices | `Transactions.get`, `Transactions.getApplied` |
| `get_payment_accounts` | Masked cards/bank accounts on file | `Accounts.getAllCcByClient`, `Accounts.getAllAchByClient` |
| `search_services` | Find a service by domain/username/number across clients | `Services.search` |
| `get_service_actions` | Operations Blesta allows on a service right now | `Services.getActions` |
| `list_packages` / `get_package` | Product catalog with prices | `Packages.getAll`, `Packages.getAllGroups`, `Packages.get` |
| `list_quotations` / `get_quotation` | Quotes | `Quotations.getList`, `get`, `getLineItems`, `getInvoices` |
| `lookup_coupon` | Validate a promo code | `Coupons.getByCode`, `Coupons.getForPackages` |
| `add_client_note` (write) | Log an interaction on the account | `Clients.addNote` |
| `update_client_status` (write) | active / inactive / fraud | `Clients.edit` |
| `create_invoice` (write) | New invoice with line items | `Invoices.add` |
| `send_invoice` (write) | Queue (re)delivery by email | `Invoices.addDelivery` |
| `update_invoice` (write) | Header fields incl. void | `Invoices.edit` |
| `suspend_service` / `unsuspend_service` / `cancel_service` (write) | Service lifecycle | `Services.suspend`, `unsuspend`, `cancel` |
| `record_manual_payment` (write) | Record offline payment and apply it | `Transactions.add`, `Transactions.apply` |
| `apply_transaction` (write) | Apply existing credit to invoices | `Transactions.apply` |
| `process_payment` (write, off by default) | Charge a stored payment account | `Payments.processPayment` |
| `blesta_call` | Call any `{model}/{method}` with named parameters | anything in [source-docs.blesta.com](https://source-docs.blesta.com/packages/blesta-app-models.html) |

Write tools are refused when `BLESTA_READ_ONLY=1`. `process_payment` additionally needs `BLESTA_ALLOW_PAYMENTS=1`.

The payment link is built exactly the way Blesta's own payment-reminder emails build it:

```
{install}/client/pay/method/{invoice_id}/?sid=rawurlencode(systemEncrypt("c={client_id}|h={hash}"))
```

so the resulting URL opens Blesta's native client-area payment page without a login.

## Requirements

* Node.js 20 or newer
* A Blesta API user + key (Blesta admin: **Settings > System > API Access**)
* HTTPS access to the Blesta install (the API key travels in every request)

## Install

```bash
git clone <this repo> blesta-mcp
cd blesta-mcp
npm install
npm run build
```

## Configuration

All configuration is by environment variable.

| Variable | Required | Meaning |
| --- | --- | --- |
| `BLESTA_URL` | yes | Install URL, e.g. `https://billing.example.com` or `https://billing.example.com/api/` (both accepted) |
| `BLESTA_API_USER` | yes | API user name |
| `BLESTA_API_KEY` | yes | API key |
| `BLESTA_READ_ONLY` | no | `1` blocks every non-GET call (safe default for support agents) |
| `BLESTA_SYSTEM_KEY` | on IonCube installs | `Blesta.system_key` from `config/blesta.php`. Needed by the payment-link tools: `systemEncrypt`/`systemDecrypt` live in the IonCube-encoded `AppModel`, and omitted optional arguments fail there with `Failed to retrieve the default value`. With the key set, `key`/`iv` are passed explicitly, which is exactly what the PHP defaults do. |
| `BLESTA_SYSTEM_KEY_FILE` | alternative | Path to a file containing only the system key (preferred over the env var: keep the file `chmod 600`, outside the repo, so the key never appears in MCP client config or shell history) |
| `BLESTA_STAFF_ID` | no | Staff member ID recorded on notes, suspensions and payments when a tool call gives none |
| `BLESTA_COMPANY_ID` | no | Company for catalog calls; default is the first company Blesta reports |
| `BLESTA_ALLOW_PAYMENTS` | no | `1` enables `process_payment` (charges stored payment accounts) |
| `BLESTA_PUBLIC_URL` | no | Base URL used in customer-facing links when it differs from `BLESTA_URL`, e.g. `https://www.example.com/clients` while the API is called at `https://clients.example.com` |
| `BLESTA_CLIENT_URI` | no | Client-area path used in payment links, default `client/` |
| `BLESTA_TIMEOUT_MS` | no | HTTP timeout, default `30000` |
| `BLESTA_ALLOW_HTTP` | no | `1` permits plain `http://` URLs (local testing only) |

> **Security note.** Blesta's API has no scopes: any valid key can call every public model method, which is full administrative access. Keep the key out of shell history and prompts, prefer `BLESTA_READ_ONLY=1` unless the agent must write, and never point this server at an install over plain HTTP.

## Add to Claude Code

```bash
claude mcp add blesta \
  -e BLESTA_URL=https://billing.example.com \
  -e BLESTA_API_USER=apiuser \
  -e BLESTA_API_KEY=your-key \
  -e BLESTA_READ_ONLY=1 \
  -e BLESTA_SYSTEM_KEY_FILE=/home/you/.config/blesta-mcp/system_key \
  -- node /absolute/path/to/blesta-mcp/dist/index.js
```

Or in a project `.mcp.json` / Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "blesta": {
      "command": "node",
      "args": ["/absolute/path/to/blesta-mcp/dist/index.js"],
      "env": {
        "BLESTA_URL": "https://billing.example.com",
        "BLESTA_API_USER": "apiuser",
        "BLESTA_API_KEY": "your-key",
        "BLESTA_READ_ONLY": "1"
      }
    }
  }
}
```

## How requests are made

The client mirrors the official PHP SDK ([phillipsdata/blesta_sdk](https://github.com/phillipsdata/blesta_sdk)):

* URL: `{BLESTA_URL}/api/{model}/{method}.json`
* Auth headers: `BLESTA-API-USER`, `BLESTA-API-KEY`
* Parameters are passed **by name** and encoded like PHP's `http_build_query`, so nested arrays become `vars[lines][0][amount]=5.99`. `GET`/`DELETE` use the query string, `POST`/`PUT` a form-encoded body.
* A `200` response is unwrapped from `{"response": ...}`; any other status is turned into a tool error that lists Blesta's per-field validation messages.

`blesta_call` infers the HTTP verb from the method name (`get*`/`search*` -> GET, `add*` -> POST, `edit*`/`set*` -> PUT, `delete*` -> DELETE) and accepts `http_method` to override it. Plugin models are addressed as `plugin.model`.

Two Blesta quirks worth knowing:

* Timestamps sent to Blesta must include a timezone (`2026-01-31T12:00:00Z`); Blesta otherwise assumes the company's local time.
* On IonCube-encoded installs a call can fail with `Failed to retrieve the default value` when an optional argument is omitted. The curated tools omit a few trailing optionals (`transactions/getApplied` without `transaction_id`, `services/getList` without `filters`), so `get_invoice_payments` and `get_client_services` are the first tools to try against a real install; if they return that error, open an issue and the calls will be made fully explicit.
* `create_invoice_payment_link` and `verify_invoice_payment_link` still work under `BLESTA_READ_ONLY=1`: `Encryption.systemEncrypt`/`systemDecrypt` are side-effect free and are the only POST calls allowed in that mode.
* Verified against a live IonCube-encoded 5.x install: all 24 read tools pass. The 9 write tools were verified against a mock only (request paths, names and `http_build_query` encoding checked against the Blesta model sources); they have not been executed against a live install. A generated payment link opens Blesta's payment-method page without a login once `BLESTA_SYSTEM_KEY`/`BLESTA_SYSTEM_KEY_FILE` is set (see Configuration). Passing an empty key is not equivalent to the default: Blesta uses the empty string literally, so the resulting `sid` is rejected.

## Documentation

* [docs/tools.md](docs/tools.md) — every tool: inputs, outputs, errors, examples
* [docs/architecture.md](docs/architecture.md) — request flow, encoding rules, how to add a tool
* [docs/blesta-api-notes.md](docs/blesta-api-notes.md) — Blesta API facts this server relies on, with sources
* [docs/testing.md](docs/testing.md) — smoke test with a mock, first live calls, troubleshooting

## Development

```bash
npm run dev      # tsc --watch
npm run build
node dist/index.js   # speaks MCP over stdio
```

## License

MIT
