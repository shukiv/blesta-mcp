import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";

interface InvoiceRecord {
  id?: number;
  id_code?: string;
  client_id?: number | string;
  status?: string;
  date_due?: string;
  date_closed?: string | null;
  currency?: string;
  total?: string | number;
  paid?: string | number;
  due?: string | number;
  [key: string]: unknown;
}

/**
 * Builds the client-area "pay now" URL exactly the way Blesta's PaymentReminders task does:
 *   {install}/{client_uri}pay/method/{invoice_id}/?sid=rawurlencode(systemEncrypt("c={client_id}|h={hash}"))
 */
export function buildPayUrl(installBase: string, clientUri: string, invoiceId: number, sid: string): string {
  const base = installBase.replace(/\/+$/, "");
  const uri = clientUri.replace(/^\/+|\/+$/g, "");
  return `${base}/${uri}/pay/method/${invoiceId}/?sid=${encodeURIComponent(sid)}`;
}

function summarizeInvoice(inv: InvoiceRecord) {
  const total = Number(inv.total ?? 0);
  const paid = Number(inv.paid ?? 0);
  const due = inv.due !== undefined && inv.due !== null ? Number(inv.due) : total - paid;
  return {
    invoice_id: inv.id,
    invoice_number: inv.id_code,
    client_id: inv.client_id,
    status: inv.status,
    currency: inv.currency,
    total,
    paid,
    due,
    date_due: inv.date_due,
    date_closed: inv.date_closed ?? null,
    payment_still_due: due > 0 && inv.status !== "void" && inv.status !== "draft",
  };
}

export interface PaymentToolOptions {
  /** Path of the client area relative to the install root, default "client/". */
  clientUri: string;
}

export function registerPaymentTools(server: McpServer, api: BlestaClient, opts: PaymentToolOptions): void {
  const installBase = api.publicBase;
  const keyHint = api.hasSystemKey
    ? ""
    : " On IonCube-encoded installs this call fails with 'Failed to retrieve the default value' unless BLESTA_SYSTEM_KEY is configured.";

  server.registerTool(
    "get_invoice_payments",
    {
      title: "Get invoice payments",
      description:
        "List payments (transactions) applied to an invoice: applied amount and date, transaction status (approved/declined/void/error/pending/returned), " +
        "payment type, gateway, reference and transaction number. Wraps Transactions.getApplied(invoice_id). " +
        "Set `include_transaction_details` to also fetch each full transaction record (Transactions.get). Also returns the invoice's current paid/due summary.",
      inputSchema: z.object({
        invoice_id: z.number().int().positive().describe("Numeric invoice ID"),
        include_transaction_details: z
          .boolean()
          .default(false)
          .describe("Fetch the full transaction record for each applied payment (one extra call per transaction)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ invoice_id, include_transaction_details }) => {
      const [invoice, appliedRaw] = await Promise.all([
        api.get<InvoiceRecord | false>("invoices", "get", { invoice_id }),
        api.get<Array<Record<string, unknown>> | false>("transactions", "getApplied", { invoice_id }),
      ]);
      if (isMissing(invoice)) return fail(`No invoice found with id ${invoice_id}.`);
      const applied = Array.isArray(appliedRaw) ? appliedRaw : [];

      let transactions: unknown[] | undefined;
      if (include_transaction_details) {
        const ids = [...new Set(applied.map((a) => Number(a.transaction_id)).filter((n) => Number.isFinite(n)))];
        transactions = await Promise.all(ids.map((id) => api.get("transactions", "get", { transaction_id: id })));
      }

      return ok({
        invoice: summarizeInvoice(invoice as InvoiceRecord),
        applied_payments: applied,
        ...(transactions ? { transactions } : {}),
      });
    })
  );

  server.registerTool(
    "create_invoice_payment_link",
    {
      title: "Create invoice payment link",
      description:
        "Produce a customer-facing URL that lets the invoice be paid without logging in. Uses Invoices.createPayHash(client_id, invoice_id) " +
        "then Encryption.systemEncrypt to build the `sid` token, exactly like Blesta's own payment reminder emails: " +
        "{install}/client/pay/method/{invoice_id}/?sid=... . The link is tied to this client and invoice and does not expire. " +
        "Only hand it to the invoice's own customer. Refuses if the invoice does not belong to `client_id`." + keyHint,
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID that owns the invoice"),
        invoice_id: z.number().int().positive().describe("Numeric invoice ID to pay"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ client_id, invoice_id }) => {
      const invoice = await api.get<InvoiceRecord | false>("invoices", "get", { invoice_id });
      if (isMissing(invoice)) return fail(`No invoice found with id ${invoice_id}.`);
      const inv = invoice as InvoiceRecord;
      if (Number(inv.client_id) !== client_id) {
        return fail(`Invoice ${invoice_id} belongs to client ${inv.client_id}, not ${client_id}. Refusing to create a link.`);
      }

      const hash = await api.get<string>("invoices", "createPayHash", { client_id, invoice_id });
      if (typeof hash !== "string" || !hash) return fail("Blesta returned an empty payment hash.");
      // systemEncrypt is pure (no side effects); POST keeps the plaintext out of the URL.
      const sid = await api.systemEncrypt(`c=${client_id}|h=${hash}`);
      if (typeof sid !== "string" || !sid) return fail("Blesta returned an empty encrypted token.");

      const summary = summarizeInvoice(inv);
      return ok({
        payment_url: buildPayUrl(installBase, opts.clientUri, invoice_id, sid),
        hash,
        invoice: summary,
        ...(summary.payment_still_due
          ? {}
          : { note: "This invoice currently has nothing due; the link will open but there may be nothing to pay." }),
      });
    })
  );

  server.registerTool(
    "verify_invoice_payment_link",
    {
      title: "Verify invoice payment link",
      description:
        "Check that a payment link/hash is valid for a given client and invoice, and report whether payment is still due. " +
        "Accepts either the raw 16-character `hash` (with `client_id`) or the `sid` token / full payment URL (decrypted via Encryption.systemDecrypt). " +
        "Wraps Invoices.verifyPayHash and Invoices.get." + keyHint,
      inputSchema: z.object({
        invoice_id: z.number().int().positive().describe("Numeric invoice ID the link is for"),
        client_id: z.number().int().positive().optional().describe("Numeric client ID; required when `hash` is given, derived from `sid` otherwise"),
        hash: z.string().optional().describe("The 16-character pay hash returned by create_invoice_payment_link"),
        sid: z.string().optional().describe("The `sid` query token, or the entire payment URL containing it"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ invoice_id, client_id, hash, sid }) => {
      let resolvedClient = client_id;
      let resolvedHash = hash;

      if (!resolvedHash) {
        if (!sid) return fail("Provide `hash` (with `client_id`) or `sid` / full payment URL.");
        let token = sid.trim();
        const m = token.match(/[?&]sid=([^&#]+)/);
        if (m) token = decodeURIComponent(m[1]);
        const plain = await api.systemDecrypt(token);
        if (typeof plain !== "string" || !plain.includes("|")) {
          return fail("The sid token could not be decrypted with this installation's system key. It is invalid or belongs to a different Blesta install.");
        }
        const fields: Record<string, string> = {};
        for (const part of plain.split("|")) {
          const idx = part.indexOf("=");
          if (idx > 0) fields[part.slice(0, idx)] = part.slice(idx + 1);
        }
        const c = Number(fields.c);
        if (!Number.isFinite(c) || !fields.h) return fail("Decrypted sid token is missing the client id or hash.");
        if (resolvedClient && resolvedClient !== c) {
          return fail(`sid token is for client ${c}, not ${resolvedClient}.`);
        }
        resolvedClient = c;
        resolvedHash = fields.h;
      }
      if (!resolvedClient) return fail("`client_id` is required when verifying by `hash`.");

      const [valid, invoice] = await Promise.all([
        api.get<boolean>("invoices", "verifyPayHash", { client_id: resolvedClient, invoice_id, hash: resolvedHash }),
        api.get<InvoiceRecord | false>("invoices", "get", { invoice_id }),
      ]);

      if (isMissing(invoice)) {
        return ok({
          valid: false,
          hash_valid: Boolean(valid),
          client_id: resolvedClient,
          invoice_id,
          invoice: null,
          payment_still_due: false,
          reason: "Invoice not found.",
        });
      }
      const inv = invoice as InvoiceRecord;
      const ownerMatches = Number(inv.client_id) === resolvedClient;
      const summary = summarizeInvoice(inv);
      return ok({
        valid: Boolean(valid) && ownerMatches,
        hash_valid: Boolean(valid),
        client_matches_invoice: ownerMatches,
        client_id: resolvedClient,
        invoice: summary,
        payment_still_due: summary.payment_still_due,
      });
    })
  );
}
