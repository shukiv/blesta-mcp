# Blesta API notes

Facts about the Blesta API that this server depends on, with sources. Verify against your own install's version if something misbehaves.

## Endpoint and auth

* URL: `https://host/installpath/api/{model}/{method}.{format}`. Without `.htaccess` support: `.../index.php/api/...`. This server always uses `json`.
* Auth headers (recommended by Blesta): `BLESTA-API-USER`, `BLESTA-API-KEY`. HTTP Basic (`user:key`) also works but is not used here.
* Create credentials in the Blesta admin under **Settings > System > API Access**. Keys are per company.
* Plugin models: `/{plugin}.{model}/{method}.json`, e.g. `support_manager.support_manager_tickets/get.json`.

Source: https://docs.blesta.com/developers/api/

## Full access, no scopes

From the official docs:

> Any valid API credentials grant access to every public model method in Blesta core and in installed plugins, modules, gateways, and other extensions — this should be treated as full administrative access to the installation.

Consequences for this server: use `BLESTA_READ_ONLY=1` unless writes are needed, never expose the key to the model, and keep the server on HTTPS.

## Parameters

Parameters are matched to PHP method arguments **by name**, in the query string for GET/DELETE and the request body for POST/PUT. Arrays use PHP bracket syntax:

```
curl .../invoices/add.json -u user:key \
  -d 'vars[client_id]=1' -d 'vars[lines][0][description]=Line item #1' -d 'vars[lines][0][amount]=5.99'
```

Optional arguments may be omitted, except on IonCube-encoded installs where omitting one can produce:

```
HTTP/1.1 500 Internal Server Error
{"message":"An unexpected error occured.","response":"Internal error: Failed to retrieve the default value"}
```

Fix: send every optional argument explicitly.

Which classes are encoded matters. In Blesta 5.x the models under `app/models/` ship as plain PHP, so omitting their optional arguments works (`invoices/get` with only `invoice_id` succeeds). `app/app_model.php` (`AppModel`, the parent of every model) is IonCube-encoded, so its inherited helpers `systemEncrypt`, `systemDecrypt` and `systemHash` require every argument. An empty string is not a substitute for `null`: `systemHash("c=1|i=42", "", "sha256")` does not match `createPayHash(1, 42)`, proving `""` is used as the literal key. This server therefore takes `BLESTA_SYSTEM_KEY` and passes it as both `key` and `iv`, which is what the defaults resolve to.

## Responses

Success is HTTP 200 with the method's return value under `response`:

```json
{"response": {"id": 7, "id_code": "INV-0007", "...": "..."}}
```

Errors:

| Status | Body |
| --- | --- |
| 400 | `{"message":"The request cannot be fulfilled due to bad syntax.","errors":{"field":{"code":"Error message."}}}` |
| 401 | `{"message":"The authorization details given appear to be invalid."}` |
| 403 | `{"message":"The requested resource is not accessible."}` |
| 404 | `{"message":"The requested resource does not exist."}` |
| 415 | `{"message":"The format requested is not supported by the server."}` |
| 500 | `{"message":"An unexpected error occured."}` |
| 503 | `{"message":"The requested resource is currently unavailable due to maintenance."}` |

Common error codes inside `errors`: `empty`, `exists`, `format`, `length`, `valid`.

Source for the unwrap logic: `BlestaResponse::response()` in the official SDK, https://github.com/phillipsdata/blesta_sdk/blob/master/api/blesta_response.php

## Timestamps

Returned: UTC, `YYYY-MM-DD hh:mm:ss` (e.g. `2026-09-14 10:00:00`).

Accepted on input, always with a timezone:

```
2026-09-14 10:00:00 +00:00
2026-09-14 10:00:00 UTC
2026-09-14T10:00:00Z
```

Without a timezone Blesta assumes the company's local time setting.

## Models used by the curated tools

| Model | Method | Signature (from source docs / core source) |
| --- | --- | --- |
| Clients | `search` | `search(string $query, int $page = 1)` |
| Clients | `getSearchCount` | `getSearchCount(string $query)` |
| Clients | `get` | `get(int $client_id, bool $get_settings = true)` |
| Invoices | `search` | `search(string $query, int $page = 1)` |
| Invoices | `getSearchCount` | `getSearchCount(string $query)` |
| Invoices | `getList` | `getList(int $client_id = null, string $status = 'open', int $page = 1, array $order_by = ['date_due' => 'ASC'], array $filters = [])` filters: `invoice_number`, `currency`, `invoice_line` |
| Invoices | `getListCount` | `getListCount(int $client_id = null, string $status = 'open', array $filters = [])` |
| Invoices | `get` | `get(int $invoice_id, mixed $use_cache = false)` |
| Invoices | `createPayHash` | `createPayHash(int $client_id, int $invoice_id) : string` (last 16 chars of `systemHash("c=$client_id|i=$invoice_id")`) |
| Invoices | `verifyPayHash` | `verifyPayHash(int $client_id, int $invoice_id, string $hash) : bool` |
| Transactions | `getApplied` | `getApplied(int $transaction_id = null, int $invoice_id = null)` |
| Transactions | `get` | `get(int $transaction_id)` |
| Services | `getList` | `getList(int $client_id = null, string $status = 'active', int $page = 1, array $order_by = ['date_added' => 'DESC'], bool $children = true, array $filters = [], array $formatted_filters = [])` |
| Services | `getListCount` | `getListCount(int $client_id = null, string $status = 'active', bool $children = true, int $package_id = null, array $filters = [])` |
| Services | `get` | `get(int $service_id)` |
| Services | `getRenewalPrice` | `getRenewalPrice(int $service_id, string $currency = null) : float` |
| Encryption (inherited from AppModel) | `systemEncrypt` / `systemDecrypt` | `(string $value, string $key = null, string $iv = null)`; AES-256-CBC, key and iv default to `Blesta.system_key` |
| Encryption (inherited from AppModel) | `systemHash` | `(string $value, string $key = null, string $hash = "sha256")`; HMAC, key defaults to `Blesta.system_key` |

Model reference index: https://source-docs.blesta.com/packages/blesta-app-models.html

## Status values

Invoices (`Invoices.getList`): `open`, `closed`, `past_due`, `draft`, `void`, `active`, `proforma`, `to_autodebit`, `pending_autodebit`, `to_print`, `printed`, `pending`, `to_deliver`, `all`.

Services (`Services.getList`): `active`, `canceled`, `pending`, `suspended`, `in_review`, `scheduled_cancellation`, `all`.

Transactions (`Transactions.getList`): `approved`, `declined`, `void`, `error`, `pending`, `returned`, `all`.

Clients: `active`, `inactive`, `fraud`.

## Payment link format

Blesta's payment reminder cron task (`core/Automation/Tasks/Task/PaymentReminders.php`) builds the customer's pay-now URL as:

```php
$hostname . $client_uri . 'pay/method/' . $invoice->id . '/?sid='
    . rawurlencode($this->Clients->systemEncrypt('c=' . $client->id . '|h=' . substr($hash, -16)))
```

The client-area controller (`app/controllers/client_pay.php`) decrypts `sid`, splits it on `|` into `c` and `h`, and calls `Invoices::verifyPayHash($c, $invoice_id_from_url, $h)`. This server reproduces both halves, so links it creates are accepted by stock Blesta and links from Blesta emails verify correctly.

The hash never expires; it is a keyed hash of client and invoice IDs.

## Other useful models for `blesta_call`

| Need | Call |
| --- | --- |
| Client contacts | `contacts/getAll` `{client_id}` |
| Client notes | `clients/getNoteList` `{client_id, page}`; `clients/addNote` `{client_id, staff_id, vars:{title, description}}` |
| Amount owed | `invoices/amountDue` `{client_id, currency, status:"open"}` |
| Transactions for a client | `transactions/getList` `{client_id, status:"approved", page}` |
| Packages | `packages/getAll` `{company_id}`; `packages/get` `{package_id}` |
| Quotations | `quotations/getList` `{client_id, status}` |
| Payment accounts on file | `accounts/getAllCcByClient` `{client_id}`, `accounts/getAllAchByClient` `{client_id}` |
| Company settings | `companies/getSettings` `{company_id}` |
| Currencies | `currencies/getAll` `{company_id}` |
| Record an offline payment (write) | `transactions/add` `{vars:{client_id, amount, currency, type:"other", status:"approved"}}` then `transactions/apply` `{transaction_id, vars:{amounts:[{invoice_id, amount}]}}` |

## Invoice PDFs and the Component API plugin

No model under `app/models/` renders a PDF (checked all 63 in 5.x). Rendering is in `components/invoice_delivery/invoice_delivery.php` (`buildInvoices`, `downloadInvoices`, `deliverInvoices`), and components are not routable through `/api/`. The client and admin controllers that download PDFs require a browser login session. `Invoices.fetchCache(invoice_id, "pdf", language)` returns a cached PDF only when the company setting `inv_cache` is `json_pdf` and the invoice was rendered since.

Blesta's own [Component API plugin](https://docs.blesta.com/integrations/plugins/component-api/) closes the gap: `GET /api/ComponentApi.ComponentApiCaller/call.json?component=InvoiceDelivery&method=downloadInvoices&params[invoice_ids][0]=ID`. The response is the raw PDF (`Content-Type: application/pdf`), not a JSON envelope, so it needs a binary-safe HTTP path (`BlestaClient.callRaw`). `deliverInvoices` (email to an arbitrary address) is reachable the same way but is not wrapped by a tool yet.

