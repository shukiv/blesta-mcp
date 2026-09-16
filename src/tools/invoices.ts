import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";
import { READ, WRITE, DESTRUCTIVE, writeNote } from "../common.js";

export const INVOICE_STATUSES = [
  "open",
  "closed",
  "past_due",
  "draft",
  "void",
  "active",
  "proforma",
  "to_autodebit",
  "pending_autodebit",
  "to_print",
  "printed",
  "pending",
  "to_deliver",
  "all",
] as const;

const lineSchema = z.object({
  description: z.string().min(1).describe("Line item text"),
  amount: z.number().describe("Unit price (per qty)"),
  qty: z.number().positive().default(1).describe("Quantity"),
  tax: z.boolean().default(true).describe("Apply tax rules to this line"),
  service_id: z.number().int().positive().optional().describe("Service this line bills for, if any"),
});

export function registerInvoiceTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "search_invoices",
    {
      title: "Search invoices",
      description:
        "Find invoices two ways. (1) `query`: free-text search by displayed invoice number, client name/email or line description " +
        "(wraps Invoices.search). (2) `client_id`: list a customer's invoices filtered by status (wraps Invoices.getList; default status 'open'). " +
        "Provide at least one of `query` or `client_id`. Each result includes numeric `id`, displayed `id_code`, status, dates, total, paid and due amounts.",
      inputSchema: z.object({
        query: z.string().min(1).optional().describe("Free-text search: invoice number (e.g. '1042'), customer name/email, or line item text"),
        client_id: z.number().int().positive().optional().describe("List invoices belonging to this numeric client ID"),
        status: z
          .enum(INVOICE_STATUSES)
          .default("open")
          .describe("Status filter used with client_id. 'open' = unpaid, 'closed' = paid, 'past_due', 'void', 'draft', 'all', ..."),
        invoice_number: z.string().optional().describe("Exact displayed invoice number filter (used with client_id)"),
        currency: z.string().length(3).optional().describe("ISO 4217 currency filter (used with client_id)"),
        page: z.number().int().min(1).default(1).describe("Result page, starting at 1"),
      }),
      annotations: READ,
    },
    guard(async ({ query, client_id, status, invoice_number, currency, page }) => {
      if (!query && !client_id) return fail("Provide `query` (free-text) or `client_id` (list a customer's invoices).");

      if (client_id) {
        const filters: Record<string, string> = {};
        if (invoice_number) filters.invoice_number = invoice_number;
        if (currency) filters.currency = currency.toUpperCase();
        const params = { client_id, status, page, order_by: { date_due: "DESC" }, filters };
        const [results, total] = await Promise.all([
          api.get("invoices", "getList", params),
          api.get<number>("invoices", "getListCount", { client_id, status, filters }),
        ]);
        return ok({ client_id, status, page, total_matches: total, results: results || [] });
      }

      const [results, total] = await Promise.all([
        api.get("invoices", "search", { query, page }),
        api.get<number>("invoices", "getSearchCount", { query }),
      ]);
      return ok({ query, page, total_matches: total, results: results || [] });
    })
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description:
        "Read one invoice by numeric invoice ID: displayed number (id_code), client_id, status, date_billed, date_due, date_closed, " +
        "currency, subtotal, total, paid, due (total minus paid), taxes and line_items with descriptions, quantities and amounts. " +
        "Wraps Invoices.get. Use search_invoices first if you only know the displayed invoice number.",
      inputSchema: z.object({
        invoice_id: z.number().int().positive().describe("Numeric invoice ID (the `id` field, not the displayed number)"),
      }),
      annotations: READ,
    },
    guard(async ({ invoice_id }) => {
      const invoice = await api.get("invoices", "get", { invoice_id });
      if (isMissing(invoice)) return fail(`No invoice found with id ${invoice_id}.`);
      return ok(invoice);
    })
  );

  server.registerTool(
    "create_invoice",
    {
      title: "Create invoice",
      description:
        "Create a new invoice for a client with one or more line items. Wraps Invoices.add. Dates default to now (billed) and now+7 days (due). " +
        "Set `deliver_by_email` to queue the invoice email (sent by Blesta's cron). Set `draft` to create it unissued. " +
        "Returns the new numeric invoice ID and the invoice as stored." + writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID"),
        currency: z.string().length(3).describe("ISO 4217 currency code"),
        lines: z.array(lineSchema).min(1).describe("Line items"),
        date_billed: z.string().optional().describe("ISO 8601 with timezone, e.g. 2026-09-15T00:00:00Z; default now"),
        date_due: z.string().optional().describe("ISO 8601 with timezone; default 7 days from now"),
        note_public: z.string().optional().describe("Note visible to the client on the invoice"),
        note_private: z.string().optional().describe("Note visible to staff only"),
        deliver_by_email: z.boolean().default(true).describe("Queue email delivery of the invoice"),
        draft: z.boolean().default(false).describe("Create as draft (not issued, not deliverable)"),
      }),
      annotations: WRITE,
    },
    guard(async ({ client_id, currency, lines, date_billed, date_due, note_public, note_private, deliver_by_email, draft }) => {
      const now = new Date();
      const vars: Record<string, unknown> = {
        client_id,
        currency: currency.toUpperCase(),
        date_billed: date_billed ?? now.toISOString(),
        date_due: date_due ?? new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        status: draft ? "draft" : "active",
        lines: lines.map((l) => ({
          description: l.description,
          amount: l.amount.toFixed(4),
          qty: l.qty,
          tax: l.tax ? 1 : 0,
          ...(l.service_id ? { service_id: l.service_id } : {}),
        })),
        ...(note_public !== undefined ? { note_public } : {}),
        ...(note_private !== undefined ? { note_private } : {}),
        ...(deliver_by_email && !draft ? { delivery: ["email"] } : {}),
      };
      const invoice_id = await api.post<number>("invoices", "add", { vars });
      const invoice = await api.get("invoices", "get", { invoice_id });
      return ok({ invoice_id, invoice });
    })
  );

  server.registerTool(
    "send_invoice",
    {
      title: "Send invoice",
      description:
        "Queue (re)delivery of an invoice to the client by email or another configured method. Wraps Invoices.addDelivery. " +
        "Blesta's cron performs the actual send within a few minutes; the tool also returns the delivery log so you can see prior sends." +
        writeNote(api),
      inputSchema: z.object({
        invoice_id: z.number().int().positive().describe("Numeric invoice ID"),
        method: z.string().default("email").describe("Delivery method: email, paper, interfax, postalmethods (must be enabled for the company)"),
      }),
      annotations: WRITE,
    },
    guard(async ({ invoice_id, method }) => {
      const invoice = await api.get<{ client_id?: number | string } | false>("invoices", "get", { invoice_id });
      if (isMissing(invoice)) return fail(`No invoice found with id ${invoice_id}.`);
      const client_id = Number((invoice as { client_id?: number | string }).client_id);
      const delivery_id = await api.post("invoices", "addDelivery", { invoice_id, vars: { method }, client_id });
      const log = await api.get("invoices", "getDelivery", { invoice_id });
      return ok({ invoice_id, queued_delivery_id: delivery_id, method, delivery_log: log || [], note: "Sent by Blesta cron; date_sent stays null until then." });
    })
  );

  server.registerTool(
    "update_invoice",
    {
      title: "Update invoice",
      description:
        "Edit invoice header fields: status (active/draft/proforma/void), due date, billed date, notes. Wraps Invoices.edit. " +
        "Use `status: \"void\"` to void an unpaid invoice (irreversible in practice). Line items are not editable here; use blesta_call invoices/edit with `lines` for that." +
        writeNote(api),
      inputSchema: z.object({
        invoice_id: z.number().int().positive().describe("Numeric invoice ID"),
        status: z.enum(["active", "draft", "proforma", "void"]).optional(),
        date_due: z.string().optional().describe("ISO 8601 with timezone"),
        date_billed: z.string().optional().describe("ISO 8601 with timezone"),
        note_public: z.string().optional(),
        note_private: z.string().optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ invoice_id, ...fields }) => {
      const vars: Record<string, unknown> = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined)
      );
      if (!Object.keys(vars).length) return fail("Nothing to update: pass at least one field.");
      const current = await api.get<{ status?: string } | false>("invoices", "get", { invoice_id });
      if (!current || typeof current !== "object") return fail(`Invoice ${invoice_id} not found.`);
      // Invoices.edit reads vars.status unconditionally; always send one.
      if (vars.status === undefined && current.status) vars.status = current.status;
      // Invoices.edit deletes every unsent delivery row and re-inserts vars.delivery, so pass the
      // pending methods back or they are silently dropped. getDelivery(sent=false) cannot be
      // expressed over the API (strict === false), so fetch all and filter here.
      const deliveries = await api.get<Array<{ method?: string; date_sent?: string | null }> | false>(
        "invoices",
        "getDelivery",
        { invoice_id }
      );
      const pending = (Array.isArray(deliveries) ? deliveries : [])
        .filter((d) => !d.date_sent && d.method)
        .map((d) => d.method as string);
      if (pending.length) vars.delivery = pending;
      await api.put("invoices", "edit", { invoice_id, vars });
      const invoice = await api.get("invoices", "get", { invoice_id });
      return ok({ invoice_id, updated: Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined), preserved_delivery: pending, invoice });
    })
  );
}
