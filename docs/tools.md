# Tool reference

Every tool returns a single text content block containing pretty-printed JSON. Errors are returned as tool results with `isError: true` and a plain-text message, never as protocol errors, so the calling model can read and recover from them.

All IDs are Blesta's numeric database IDs (the `id` column). Displayed numbers such as `INV-1042` or a client number `1500` live in the `id_code` field and are different values; use the search tools to translate one into the other.

Output is capped at 60,000 characters per call. Longer results are cut and end with `...[truncated N chars; ...]`. Page through results or narrow the query instead of raising the cap.

---

## search_clients

Find customers by free text. Wraps `Clients.search` and `Clients.getSearchCount`.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | Email, first/last name, company, or client number |
| `page` | integer | no | Default `1` |

**Output**

```json
{
  "query": "ada@example.com",
  "page": 1,
  "total_matches": 1,
  "results": [ { "id": 1, "id_code": "1500", "first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com", "company": "", "status": "active", "client_group_id": 1, "...": "..." } ]
}
```

`results` is Blesta's own client search row (client columns joined with the primary contact). `total_matches` counts every page.

**Errors**: none specific; `results` is empty when nothing matches.

---

## get_client

One client by numeric ID. Wraps `Clients.get`.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | yes | Numeric ID |
| `include_settings` | boolean | no | Default `false`. Adds a `settings` object (default currency, language, autodebit, tax settings, invoice method, ...) |

**Output**: the client object as Blesta returns it. Typical fields: `id`, `id_code`, `user_id`, `client_group_id`, `status` (`active`, `inactive`, `fraud`), `primary_account_type`, `primary_account_id`, plus primary-contact fields `contact_id`, `first_name`, `last_name`, `company`, `email`, `address1`, `address2`, `city`, `state`, `zip`, `country`, and `numbers` (phone/fax list).

**Errors**: `No client found with id N.`

---

## search_invoices

Two modes in one tool.

1. **Free text** (`query`): searches invoice number, customer name/email and line descriptions. Wraps `Invoices.search` and `Invoices.getSearchCount`.
2. **By client** (`client_id`): lists that client's invoices filtered by status. Wraps `Invoices.getList` and `Invoices.getListCount`.

When both are given, `client_id` mode wins. At least one is required.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | one of | Free-text search |
| `client_id` | integer | one of | List this client's invoices |
| `status` | enum | no | Default `open`. One of `open`, `closed`, `past_due`, `draft`, `void`, `active`, `proforma`, `to_autodebit`, `pending_autodebit`, `to_print`, `printed`, `pending`, `to_deliver`, `all`. Only used with `client_id`. |
| `invoice_number` | string | no | Exact displayed number filter (with `client_id`) |
| `currency` | string | no | ISO 4217 code (with `client_id`) |
| `page` | integer | no | Default `1` |

Status meanings that matter for support: `open` = unpaid and active, `closed` = fully paid, `past_due` = open and past `date_due`, `void` = cancelled, `draft` = not yet issued, `all` = no filter.

**Output**

```json
{
  "client_id": 1,
  "status": "open",
  "page": 1,
  "total_matches": 3,
  "results": [ { "id": 7, "id_code": "INV-0007", "client_id": "1", "status": "active", "currency": "USD", "total": "10.0000", "paid": "2.5000", "due": "7.5000", "date_billed": "2026-09-01 00:00:00", "date_due": "2026-10-01 00:00:00", "date_closed": null, "...": "..." } ]
}
```

In `query` mode the top-level keys are `query`, `page`, `total_matches`, `results`.

**Errors**: `Provide `query` (free-text) or `client_id` ...` when neither is given.

---

## get_invoice

One invoice with line items. Wraps `Invoices.get`.

**Input**

| Field | Type | Required |
| --- | --- | --- |
| `invoice_id` | integer | yes |

**Output**: the invoice object. Typical fields: `id`, `id_code`, `client_id`, `status`, `currency`, `subtotal`, `total`, `paid`, `due`, `date_billed`, `date_due`, `date_closed`, `date_autodebit`, `note_public`, `note_private`, `line_items[]` (each with `id`, `description`, `qty`, `amount`, `subtotal`, `total`, `taxes[]`), `taxes[]`, `delivery[]`, `meta`.

Amounts are decimal strings. `due` is `total - paid` as computed by Blesta.

**Errors**: `No invoice found with id N.`

---

## get_invoice_payments

Payments applied to an invoice. Wraps `Transactions.getApplied(invoice_id)` and, optionally, `Transactions.get` per transaction.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `invoice_id` | integer | yes | |
| `include_transaction_details` | boolean | no | Default `false`. Fetches the full transaction record for each applied payment (one extra call each) |

**Output**

```json
{
  "invoice": {
    "invoice_id": 7, "invoice_number": "INV-0007", "client_id": "1", "status": "active",
    "currency": "USD", "total": 10, "paid": 2.5, "due": 7.5,
    "date_due": "2026-10-01 00:00:00", "date_closed": null, "payment_still_due": true
  },
  "applied_payments": [
    { "transaction_id": 11, "invoice_id": 7, "applied_amount": "2.5000", "applied_date": "2026-09-05 14:02:11",
      "amount": "2.5000", "currency": "USD", "status": "approved", "type": "cc", "type_name": null,
      "gateway_name": "Stripe", "gateway_type": "merchant", "transaction_number": "ch_123", "reference_id": null, "invoice_id_code": "INV-0007" }
  ],
  "transactions": [ { "id": 11, "...": "..." } ]
}
```

`transactions` is present only when `include_transaction_details` is true. Transaction `status` is one of `approved`, `declined`, `void`, `error`, `pending`, `returned`, `refunded`.

`payment_still_due` is `due > 0` and status is neither `void` nor `draft`.

---

## get_client_services

Services for a client, or one service in full.

* With `client_id`: wraps `Services.getList` and `Services.getListCount`.
* With `service_id`: wraps `Services.get`.
* With `include_renewal_price`: adds `Services.getRenewalPrice` per service.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | one of | List mode |
| `service_id` | integer | one of | Single-service mode; takes precedence |
| `status` | enum | no | Default `active`. One of `active`, `canceled`, `pending`, `suspended`, `in_review`, `scheduled_cancellation`, `all` |
| `page` | integer | no | Default `1` |
| `include_children` | boolean | no | Default `true`. Include add-on services |
| `include_renewal_price` | boolean | no | Default `false`. One extra call per service |
| `full` | boolean | no | Default `false`. Return raw Blesta objects instead of the compact view |

By default each service is reduced to a compact view: identity, status, dates, pricing, a trimmed `package` (`id`, `id_code`, `name`, `module_id`, `status`, `single_term`, `taxable`), `fields` as `{key, value}` pairs (encrypted fields dropped) and `options`. Raw objects carry package descriptions, email templates and module meta and run to 3 KB or more each; a 20-service list would exceed the output cap.

**Output (list mode)**

```json
{
  "client_id": 1, "status": "active", "page": 1, "total_matches": 2,
  "results": [
    { "id": 42, "parent_service_id": null, "package_group_id": 1, "pricing_id": 3, "client_id": 1, "module_row_id": 1,
      "coupon_id": null, "qty": 1, "status": "active", "date_added": "2025-09-14 10:00:00", "date_renews": "2026-10-14 10:00:00",
      "date_last_renewed": "2026-09-14 10:00:00", "date_suspended": null, "date_canceled": null,
      "name": "example.com", "package": { "id": 5, "name": "Shared Hosting", "...": "..." },
      "package_pricing": { "term": 1, "period": "month", "price": "9.9900", "currency": "USD", "...": "..." },
      "renewal_price": 9.99 }
  ]
}
```

**Output (single mode)**: the service object, which additionally includes `fields[]` (module-specific values such as domain, username, server) and `options[]` (configurable options). `renewal_price` is added when requested.

`renewal_price` is `null` for a service if the price lookup fails, so one bad service does not break the list.

---

## create_invoice_payment_link

Builds a link the customer can open to pay one invoice without logging in. Wraps `Invoices.get` (ownership check), `Invoices.createPayHash`, and `Encryption.systemEncrypt`.

The URL format is identical to the `{payment_url}` tag Blesta uses in its own payment-reminder emails:

```
{BLESTA_URL}/{BLESTA_CLIENT_URI}pay/method/{invoice_id}/?sid=<urlencoded systemEncrypt("c={client_id}|h={hash}")>
```

**Input**

| Field | Type | Required |
| --- | --- | --- |
| `client_id` | integer | yes |
| `invoice_id` | integer | yes |

**Output**

```json
{
  "payment_url": "https://billing.example.com/client/pay/method/7/?sid=U2FsdGVk...",
  "hash": "3f9a1c2b7d8e4f60",
  "invoice": { "invoice_id": 7, "invoice_number": "INV-0007", "due": 7.5, "payment_still_due": true, "...": "..." },
  "note": "only present when nothing is currently due"
}
```

**Errors**

* `No invoice found with id N.`
* `Invoice N belongs to client X, not Y. Refusing to create a link.` The tool never creates a link for a mismatched client.

**IonCube installs**: `Encryption.systemEncrypt` is inherited from the encoded `AppModel`; without `BLESTA_SYSTEM_KEY` the call fails with `Failed to retrieve the default value` and the tool returns that error with a hint.

**Security**: the hash is derived from Blesta's system key and does not expire. Anyone holding the URL can pay (only pay) that invoice. Send it only to the invoice's own customer.

---

## verify_invoice_payment_link

Checks a hash or `sid` token against a client and invoice, then reports whether payment is still due. Wraps `Encryption.systemDecrypt` (for `sid`), `Invoices.verifyPayHash`, and `Invoices.get`.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `invoice_id` | integer | yes | |
| `client_id` | integer | with `hash` | Derived from the token when `sid` is used |
| `hash` | string | one of | The 16-character hash |
| `sid` | string | one of | The `sid` query value, or the entire payment URL |

**Output**

```json
{
  "valid": true,
  "hash_valid": true,
  "client_matches_invoice": true,
  "client_id": 1,
  "invoice": { "invoice_id": 7, "status": "active", "due": 7.5, "payment_still_due": true, "...": "..." },
  "payment_still_due": true
}
```

`valid` is true only when the hash verifies **and** the invoice belongs to the resolved client. The `sid` path needs `BLESTA_SYSTEM_KEY` on IonCube installs; the `hash` path does not. If the invoice does not exist, `valid` is `false`, `invoice` is `null`, and `reason` explains.

**Errors**

* token cannot be decrypted (wrong install or corrupted URL)
* `sid` is for a different client than the `client_id` supplied
* neither `hash` nor `sid` given

---

## blesta_call

Generic escape hatch. Calls any public model method as `{model}/{method}` with named parameters.

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `model` | string | yes | URL form, snake_case: `clients`, `invoices`, `services`, `transactions`, `contacts`, `packages`, ... Plugin models as `plugin.model` |
| `method` | string | yes | PHP method name, e.g. `getList`, `add`, `edit` |
| `params` | object | no | Named arguments. Nested objects and arrays allowed |
| `http_method` | enum | no | `GET`, `POST`, `PUT`, `DELETE`. Inferred from the method name when omitted |
| `max_chars` | integer | no | Output cap, 1000 to 200000, default 60000 |

**Verb inference**

| Method name starts with | Verb |
| --- | --- |
| `add`, `create`, `process`, `apply`, `send`, `auth`, `systemEncrypt`, `systemDecrypt`, `verify` | POST |
| `edit`, `set`, `update`, `cancel`, `suspend`, `unsuspend`, `renew`, `void`, `unapply`, `mark`, `reset`, `increment`, `decrement` | PUT |
| `delete`, `remove`, `unset`, `purge` | DELETE |
| anything else | GET |

**Output**

```json
{ "request": "POST invoices/add", "response": 99 }
```

`response` is the unwrapped return value of the PHP method: an object for `get*`, an array for `getList*`/`getAll*`, an integer ID for `add`, `true`/`null` for edits, `false` for "not found".

**Examples**

Add a note to a client:

```json
{ "model": "clients", "method": "addNote", "params": { "client_id": 1, "staff_id": 1, "vars": { "title": "Called about invoice", "description": "Promised payment Friday", "stickied": 0 } } }
```

List a client's contacts:

```json
{ "model": "contacts", "method": "getAll", "params": { "client_id": 1 } }
```

Amount due for a client in USD:

```json
{ "model": "invoices", "method": "amountDue", "params": { "client_id": 1, "currency": "USD", "status": "open" } }
```

Create an invoice (nested `vars` and `lines`):

```json
{ "model": "invoices", "method": "add", "params": { "vars": { "client_id": 1, "date_billed": "2026-09-14T00:00:00Z", "date_due": "2026-10-14T00:00:00Z", "currency": "USD", "lines": [ { "description": "Setup fee", "amount": "25.00", "qty": 1 } ], "delivery": ["email"] } } }
```

Support Manager plugin ticket:

```json
{ "model": "support_manager.support_manager_tickets", "method": "get", "params": { "ticket_id": 12 } }
```

**Finding parameter names**: open `https://source-docs.blesta.com/classes/<Model>.html` (PascalCase class name, e.g. `Invoices`). The signature shown there, such as `getList([int $client_id = null][, string $status = 'open'][, int $page = 1]...)`, gives the exact names to use in `params`.

**Errors**

* Blesta validation errors (HTTP 400) are listed per field, e.g. `vars.client_id.exists: Invalid client ID.`
* HTTP 403: method is not public or not callable through the API
* HTTP 404: model or method does not exist (check spelling and snake_case)
* In read-only mode any non-GET call is refused before it is sent (except `encryption/systemEncrypt` and `systemDecrypt`).

---

# Tier 1 and 2 tools (added 2026-09-15)

Write tools are refused before any request is sent when `BLESTA_READ_ONLY=1`; their descriptions say so at runtime. Every write tool re-reads the affected record after the change and returns it.

## get_client_contacts

All contacts under a client with phone/fax numbers. Wraps `Contacts.getAll(client_id, contact_type)` and `Contacts.getNumbers(contact_id)`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | yes | |
| `contact_type` | enum | no | `primary`, `billing`, `other` |
| `include_numbers` | boolean | no | Default `true`; one extra call per contact |

Output: `{ client_id, total, contacts: [ { id, contact_type, first_name, last_name, email, company, address1, city, state, country, numbers: [ { number, type, location } ] } ] }`.

## get_client_notes

Staff notes newest first, plus sticky notes. Wraps `Clients.getNoteList`, `Clients.getNoteListCount`, `Clients.getAllStickyNotes`.

| Field | Type | Required |
| --- | --- | --- |
| `client_id` | integer | yes |
| `page` | integer | no |

Output: `{ client_id, page, total_notes, sticky_notes: [...], notes: [ { id, staff_id, title, description, stickied, date_added, date_updated } ] }`.

## get_client_balance

Amount owed and invoice counts by status. Wraps `Invoices.amountDue(client_id, currency, status)` for `open` and `past_due`, and `Invoices.getStatusCount(client_id, status)` for six statuses.

| Field | Type | Required |
| --- | --- | --- |
| `client_id` | integer | yes |
| `currency` | string (3) | yes |

Output: `{ client_id, currency, amount_due, amount_past_due, invoice_counts: { open, past_due, closed, draft, void, proforma } }`. `amount_due` is per currency; a client billed in two currencies needs two calls.

## get_client_transactions

Payment history. Wraps `Transactions.getList(client_id, status, page, order_by, filters)` and `getListCount`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | no | Omit for all clients |
| `status` | enum | no | Default `approved`. `approved`, `declined`, `void`, `error`, `pending`, `returned`, `refunded`, `all` |
| `page` | integer | no | |
| `payment_type` | string | no | `cc`, `ach`, or a transaction type name |
| `reference_id` | string | no | Partial match |
| `applied_status` | enum | no | `fully_applied`, `partially_applied`, `not_applied` (values from Blesta core) |
| `start_date` / `end_date` | string | no | ISO 8601 with timezone |
| `start_amount` / `end_amount` | number | no | |

Output: `{ client_id, status, page, total_matches, results: [ { id, transaction_id (gateway number), amount, currency, type, type_name, status, gateway_name, reference_id, date_added, applied_amount, ... } ] }`.

## get_transaction

One payment plus applied invoices. Wraps `Transactions.get` and `Transactions.getApplied(transaction_id)`.

| Field | Type | Required |
| --- | --- | --- |
| `transaction_id` | integer | yes |

## get_payment_accounts

Masked payment methods on file. Wraps `Accounts.getAllCcByClient(client_id)` and `Accounts.getAllAchByClient(client_id, unverified=true)`. Card numbers are never returned (Blesta stores them encrypted with the company key and the tool never asks to decrypt).

| Field | Type | Required |
| --- | --- | --- |
| `client_id` | integer | yes |

Output: `{ client_id, credit_cards: [ { id, contact_id, first_name, last_name, last4, type, expiration (yyyymm), status, gateway_id } ], bank_accounts: [ ... ] }`.

## search_services

Find services across all clients. Wraps `Services.search(query, page, search_fields)`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | Domain, username, package name or service number |
| `page` | integer | no | |
| `search_fields` | boolean | no | Default `true`: also match module field values (domain, username) |
| `full` | boolean | no | Raw objects instead of the compact view |

## get_service_actions

Allowed operations for a service in its current state. Wraps `Services.get` then `Services.getActions(current_status)`.

Output example: `{ service_id: 42, status: "canceled", actions: { uncancel: "Reactivate" } }`. Action keys map to tools or `blesta_call` methods: `suspend`/`unsuspend`/`cancel` are tools here, `uncancel` is `services/unCancel`, `change_renew_date` is `services/edit` with `date_renews`.

## list_packages

Product catalog. Wraps `Packages.getAll(company_id, order, status, type, filters)` and `Packages.getAllGroups(company_id)`. `Packages.getAll` returns no prices; `include_pricing` fetches `Packages.get` per package (capped at 25 per call).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | enum | no | `active`, `inactive`, `restricted`; default all |
| `type` | enum | no | `standard`, `addon` |
| `name` | string | no | Partial name |
| `package_group_id` | integer | no | |
| `include_hidden` | boolean | no | Default `true` |
| `include_pricing` | boolean | no | Default `false` |
| `company_id` | integer | no | Default `BLESTA_COMPANY_ID`, else first company |
| `full` | boolean | no | Raw package objects |

Compact package: `{ id, id_code, name, status, module_id, qty, single_term, taxable, hidden, groups: [{id, name}], pricing?: [ { pricing_id, term, period, price, price_renews, setup_fee, currency } ] }`.

## get_package

One package in full (pricing, description, module, option groups). Wraps `Packages.get(package_id)`.

## list_quotations

Wraps `Quotations.getList(client_id, status, page, order_by)` and `getListCount`. Statuses: `draft`, `pending` (default), `approved`, `invoiced`, `expired`, `dead`, `lost`, `all`.

## get_quotation

Wraps `Quotations.get`, `Quotations.getLineItems`, `Quotations.getInvoices`. Output: the quote with `line_items` and `invoices` arrays.

## lookup_coupon

Validate a promo code. Wraps `Coupons.getByCode(code)`; with `package_ids`, also `Coupons.getForPackages(code, coupon_id, packages)`.

Output: `{ code, found, usable_now, checks: { status_active, within_dates, usage_available }, applies_to_packages?, coupon }`. `usable_now` is the AND of the checks (and package applicability when asked). Dates are compared as UTC.

---

## add_client_note (write)

Wraps `Clients.addNote(client_id, staff_id, vars)`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | yes | |
| `title` | string | yes | |
| `description` | string | no | |
| `sticky` | boolean | no | Pin to profile |
| `staff_id` | integer | no | Default `BLESTA_STAFF_ID`; required one way or the other |

Output: `{ client_id, note_id, title }`.

## update_client_status (write, destructive)

Wraps `Clients.edit(client_id, { status })`. `status`: `active`, `inactive`, `fraud`. Inactive and fraud clients cannot log in.

## create_invoice (write)

Wraps `Invoices.add(vars)`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | yes | |
| `currency` | string (3) | yes | |
| `lines` | array | yes | `{ description, amount, qty=1, tax=true, service_id? }` |
| `date_billed` | string | no | ISO 8601 with timezone; default now |
| `date_due` | string | no | Default now + 7 days |
| `note_public` / `note_private` | string | no | |
| `deliver_by_email` | boolean | no | Default `true`; adds `delivery: ["email"]`, sent by cron |
| `draft` | boolean | no | Default `false` |

Output: `{ invoice_id, invoice }`. Amounts are sent with four decimals as Blesta stores them.

## send_invoice (write)

Wraps `Invoices.get` (to learn the client), `Invoices.addDelivery(invoice_id, { method }, client_id)`, `Invoices.getDelivery(invoice_id)`. Queues a delivery record; Blesta's cron sends it and fills `date_sent`. `method` defaults to `email`; other methods must be enabled for the company.

## update_invoice (write, destructive)

Wraps `Invoices.edit(invoice_id, vars)` for header fields only: `status` (`active`, `draft`, `proforma`, `void`), `date_due`, `date_billed`, `note_public`, `note_private`. Voiding is the common use. Line-item edits go through `blesta_call` `invoices/edit` with `vars.lines` (each existing line needs its `id`, otherwise it is added).

Two Blesta behaviours are handled for you (verified in `app/models/invoices.php`):

* `Invoices.edit` reads `vars['status']` unconditionally, so the tool fetches the invoice first and always sends a status (the current one when you did not pass one).
* `Invoices.edit` deletes every unsent `invoice_delivery` row and re-inserts `vars['delivery']`. The tool fetches `getDelivery` and passes the pending methods back, otherwise a queued email delivery would be silently dropped. The result lists them under `preserved_delivery`.

A status or currency change on an invoice that already has payments applied is refused by Blesta with `id.amount_applied`; the tool surfaces that error unchanged.

## suspend_service (write, destructive)

Wraps `Services.suspend(service_id, { use_module, staff_id, suspension_reason })`. `use_module=true` (default) also suspends on the provisioning module.

## unsuspend_service (write)

Wraps `Services.unsuspend(service_id, { use_module, staff_id })`.

## cancel_service (write, destructive)

Wraps `Services.cancel(service_id, vars)`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `service_id` | integer | yes | |
| `when` | string | no | `end_of_term` (default), `now`, or ISO 8601 date with timezone |
| `reason` | string | no | |
| `use_module` | boolean | no | Default `true`; deprovisions when cancelling now |
| `notify_client` | boolean | no | Default `true` |

`now` is sent as a timestamp one minute in the past, which Blesta treats as immediate. Scheduled cancellations run from cron and can be reverted with `blesta_call` `services/unCancel` before they execute. `reapply_payments` is always `true` so credits on removed line items are re-applied.

## download_invoice_pdf (read)

Renders one or more invoices with Blesta's own invoice template and saves the PDF locally. Requires the [Component API plugin](https://docs.blesta.com/integrations/plugins/component-api/); the call is `ComponentApi.ComponentApiCaller/call` with `component=InvoiceDelivery`, `method=downloadInvoices`, `params[invoice_ids][]`, optionally `params[options][language]`. Blesta streams raw PDF bytes instead of JSON, so the server reads the body as binary and checks for the `%PDF-` magic. Nothing is emailed and nothing in Blesta changes; allowed in read-only mode.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `invoice_ids` | integer[] (1-20) | yes | Numeric IDs. Several IDs produce one combined document |
| `output_dir` | string | no | Default `BLESTA_DOWNLOAD_DIR`, else `<os tmp>/blesta-mcp` |
| `filename` | string | no | Basename only (directories are stripped); default `<invoice_number>.pdf` or `invoices-<ids>.pdf` |
| `language` | string | no | e.g. `en_us`; default is the client's language |
| `include_base64` | boolean | no | Also embeds the PDF as an MCP resource content block (`application/pdf`, base64). Large |

Output:

```json
{ "path": "/tmp/blesta-mcp/1042.pdf", "bytes": 168122,
  "invoices": [ { "invoice_id": 7, "invoice_number": "1042", "client_id": 1, "status": "active" } ],
  "language": "client default" }
```

Each invoice is fetched with `Invoices.get` first, so an unknown ID fails before anything is rendered. If the plugin is missing, the response is JSON rather than a PDF and the tool reports that with installation instructions.

## record_manual_payment (write)

Wraps `Transactions.add(vars)` with `type: "other"`, `status: "approved"`, then `Transactions.apply(transaction_id, { amounts })` when `apply_to` is given. Records money already received; nothing is charged.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `client_id` | integer | yes | |
| `amount` | number | yes | |
| `currency` | string (3) | yes | Invoices must be in this currency |
| `apply_to` | array | no | `[{ invoice_id, amount }]`; sum must not exceed `amount` |
| `reference` | string | no | Stored as `reference_id` |
| `message` | string | no | |
| `date_received` | string | no | ISO 8601 with timezone |

`payment_type` (optional) is the offline payment type name configured in Blesta (Settings > Company > Payments > Payment Types), resolved through `Transactions.getTypes` to `transaction_type_id`. An unknown name fails and lists the configured types.

If `add` succeeds but `apply` fails, the output carries `apply_error` and the transaction remains as unapplied credit.

## record_invoice_payment (write)

Shortcut for the common case: money was received for one invoice. Reads the invoice with `Invoices.get`, takes `client_id`, `currency` and the remaining due from it, records the payment with `Transactions.add` (`type: "other"`, `status: "approved"`) and applies it with `Transactions.apply`. Nothing is charged.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `invoice_id` | integer | yes | |
| `amount` | number | no | Default: the invoice's remaining due |
| `allow_overpayment` | boolean | no | Default `false`. When `amount` exceeds the due, apply the due and keep the remainder as unapplied client credit instead of failing |
| `payment_type` | string | no | Offline payment type name, resolved via `Transactions.getTypes` |
| `reference` | string | no | Stored as `reference_id` |
| `message` | string | no | |
| `date_received` | string | no | ISO 8601 with timezone |

Refuses void and draft invoices and invoices with nothing due. Output:

```json
{ "transaction_id": 500, "invoice_id": 7, "amount_received": 10, "amount_applied": 10, "unapplied_credit": 0,
  "invoice_after": { "status": "active", "paid": "10.0000", "due": "0.0000" } }
```

If `apply` fails after `add` succeeded, `apply_error` is set, `amount_applied` is `0` and the full amount remains as client credit.

## apply_transaction (write)

Wraps `Transactions.apply(transaction_id, { amounts: [{ invoice_id, amount }] })`. Use for applying existing client credit.

## process_payment (write, destructive, off by default)

Wraps `Payments.processPayment(client_id, type, amount, currency, account_info=omitted, account_id, options)`. Charges a stored payment account through the gateway, applies to invoices via `options.invoices` (`invoice_id -> amount`), emails a receipt unless `email_receipt=false`.

Enabled only when `BLESTA_ALLOW_PAYMENTS=1`; otherwise the tool exists but refuses. Raw card or bank details are never accepted, only `account_id` from `get_payment_accounts`.
