# Architecture

## Overview

```
MCP client (Claude Code, Hermes, Claude Desktop)
        │  JSON-RPC over stdio
        ▼
src/index.ts          creates McpServer, registers tool groups, serves stdio
        │
        ├── src/tools/clients.ts     search_clients, get_client
        ├── src/tools/invoices.ts    search_invoices, get_invoice
        ├── src/tools/services.ts    get_client_services
        ├── src/tools/payments.ts    get_invoice_payments, create_/verify_invoice_payment_link
        ├── src/tools/transactions.ts get_client_transactions, get_transaction, get_payment_accounts,
        │                            record_manual_payment, apply_transaction, process_payment
        ├── src/tools/catalog.ts     list_packages, get_package, list_quotations, get_quotation, lookup_coupon
        └── src/tools/generic.ts     blesta_call
src/common.ts         READ/WRITE/DESTRUCTIVE annotation presets, resolveStaffId, resolveCompanyId
                │
                ▼
src/format.ts         ok()/fail() result builders, guard() error wrapper, output cap
src/client.ts         BlestaClient: URL building, PHP-style encoding, auth headers,
                      response unwrapping, error parsing, read-only gate
        │  HTTPS, BLESTA-API-USER / BLESTA-API-KEY headers
        ▼
Blesta  /api/{model}/{method}.json
```

The server is stateless. Every tool call is one or more independent HTTP requests; nothing is cached.

## Request lifecycle

1. The MCP SDK validates the tool arguments against the zod `inputSchema` and applies defaults.
2. The handler (wrapped in `guard()`) calls `api.get/post/put/delete(model, method, params)`.
3. `BlestaClient.call`:
   * validates `model` (`name` or `plugin.model`) and `method` against `^[A-Za-z_][A-Za-z0-9_]*$` so nothing else can reach the URL path;
   * refuses non-GET verbs in read-only mode, except the two pure encryption helpers;
   * encodes `params` with `phpQuery()` (see below);
   * puts the encoded string in the query for GET/DELETE, or in a form-encoded body for POST/PUT;
   * sends the request with a timeout (`BLESTA_TIMEOUT_MS`, default 30 s);
   * on HTTP 200 returns `body.response`; otherwise throws `BlestaError` carrying status, message and the per-field `errors` map.
4. `guard()` turns `BlestaError` into a readable `isError` tool result via `describe()`, which flattens field errors and adds the IonCube hint when relevant.
5. `ok()` serializes the value as JSON and truncates at 60,000 characters.

## Parameter encoding

Blesta maps request parameters to PHP method arguments **by name**, and expects PHP's `http_build_query` layout for arrays. `phpQuery()` reproduces it:

| JavaScript | Encoded (before percent-encoding) |
| --- | --- |
| `{ client_id: 1 }` | `client_id=1` |
| `{ vars: { status: "active" } }` | `vars[status]=active` |
| `{ vars: { lines: [{ amount: "5.99" }] } }` | `vars[lines][0][amount]=5.99` |
| `{ delivery: ["email"] }` | `delivery[0]=email` |
| `{ children: true }` | `children=1` |
| `{ x: null }` / `undefined` | omitted |
| `Date` instance | ISO 8601 string with `Z` |

`URLSearchParams` does the percent-encoding, which PHP decodes transparently (`vars%5Bclient_id%5D` becomes `vars[client_id]`). Spaces become `+`, which PHP also decodes.

Because nulls are omitted, an optional PHP argument cannot be "explicitly passed as null". On IonCube-encoded installs that can trigger `Failed to retrieve the default value`; pass a concrete value instead.

## Response contract

| Blesta answer | Client behaviour |
| --- | --- |
| `200 {"response": X}` | returns `X` |
| `200` with no `response` key | returns the whole body |
| `400 {"message", "errors": {field: {code: msg}}}` | `BlestaError` with flattened `field.code: msg` lines |
| `401` | `BlestaError` "The authorization details given appear to be invalid." |
| `403` | method not callable through the API |
| `404` | model/method does not exist |
| `500 {"message", "response": "..."}` | `BlestaError`; IonCube hint appended when the text matches |
| `503` | maintenance mode |
| network error / timeout | `BlestaError` with status `0` |

Blesta returns `false` (not an error) when a `get()` finds nothing. Tools test for that with `isMissing()` and return a clear "No X found" error.

## Read-only mode

`BLESTA_READ_ONLY=1` makes `BlestaClient.readOnly` true. The gate lives in one place, `BlestaClient.call`, so every tool including `blesta_call` is covered. The allow-list `PURE_POST_METHODS` (`encryption/systemEncrypt`, `encryption/systemDecrypt`) exists because those calls have no side effects but are sent as POST to keep their payload out of URLs and access logs.

`blesta_call` reports `readOnlyHint`/`destructiveHint` annotations based on the mode so MCP clients can display the right warnings.

## Adding a tool

1. Confirm the PHP signature at `https://source-docs.blesta.com/classes/<Model>.html`. Parameter names must match exactly.
2. Add a `server.registerTool(...)` block in the relevant `src/tools/*.ts` file (or a new file registered from `src/index.ts`).
3. Define `inputSchema` with `z.object({...})` from `zod/v4`; use `.describe()` on every field, the model reads those.
4. Wrap the handler in `guard()` and return `ok(value)` or `fail(message)`.
5. Set `annotations`: `readOnlyHint: true` for pure reads, `destructiveHint: true` for anything that changes billing state.
6. For list endpoints, call the matching `getListCount` too and return `total_matches` so the model knows whether to page.
7. `npm run build`, then exercise the tool through the stdio driver in `docs/testing.md`.

Pattern to copy:

```ts
server.registerTool(
  "get_contacts",
  {
    title: "Get client contacts",
    description: "All contacts under a client. Wraps Contacts.getAll.",
    inputSchema: z.object({
      client_id: z.number().int().positive().describe("Numeric client ID"),
      contact_type: z.enum(["primary", "billing", "other"]).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  guard(async ({ client_id, contact_type }) => {
    const contacts = await api.get("contacts", "getAll", { client_id, contact_type });
    return ok(Array.isArray(contacts) ? contacts : []);
  })
);
```

## Dependencies

| Package | Why |
| --- | --- |
| `@modelcontextprotocol/server` 2.x | MCP server, stdio transport, tool registry |
| `zod` 4.x | Input schemas; the SDK converts them to JSON Schema for tool discovery |
| Node 20+ `fetch`, `URLSearchParams`, `AbortSignal.timeout` | HTTP without extra libraries |

## Repository layout

```
blesta-mcp/
├── src/
│   ├── index.ts          entry point (bin), server factory
│   ├── client.ts         BlestaClient, phpQuery, BlestaError, clientFromEnv
│   ├── format.ts         ok, fail, guard, serialize, isMissing
│   ├── common.ts         annotation presets, staff/company id resolution
│   └── tools/            one file per tool group
├── dist/                 compiled output (npm run build)
├── docs/                 this documentation
├── README.md
├── .mcp.json.example     sample MCP client configuration
├── package.json
└── tsconfig.json         ES2022, NodeNext modules, strict
```
