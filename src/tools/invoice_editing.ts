import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail } from "../format.js";
import { WRITE, DESTRUCTIVE, writeNote } from "../common.js";

/**
 * Invoice editing beyond header fields: line items, draft deletion, merge, split, appending
 * services and the closed flag.
 *
 * Invoices.edit line semantics (app/models/invoices.php):
 *  - a line with `id` and a description/amount is updated;
 *  - a line with `id` whose description AND amount are empty is deleted;
 *  - a line without `id` is added;
 *  - lines not mentioned are left alone.
 * edit() also reads vars.status and vars.currency unconditionally and re-creates the unsent
 * delivery rows from vars.delivery, so all three are always sent back.
 */

interface LineItem {
  id: number | string;
  service_id?: number | string | null;
  description?: string;
  qty?: string | number;
  amount?: string | number;
  taxes?: unknown[];
}

interface InvoiceRecord {
  id: number;
  id_code?: string;
  client_id: number | string;
  status: string;
  currency: string;
  total?: string;
  paid?: string;
  due?: string;
  line_items?: LineItem[];
}

async function fetchInvoice(api: BlestaClient, invoice_id: number): Promise<InvoiceRecord | null> {
  const inv = await api.get<InvoiceRecord | false>("invoices", "get", { invoice_id });
  return inv && typeof inv === "object" ? inv : null;
}

/** Unsent delivery methods, which Invoices.edit would otherwise drop. */
async function pendingDelivery(api: BlestaClient, invoice_id: number): Promise<string[]> {
  const rows = await api.get<Array<{ method?: string; date_sent?: string | null }> | false>("invoices", "getDelivery", { invoice_id });
  return (Array.isArray(rows) ? rows : []).filter((d) => !d.date_sent && d.method).map((d) => d.method as string);
}

function summarize(inv: InvoiceRecord) {
  return {
    invoice_id: inv.id,
    invoice_number: inv.id_code,
    client_id: inv.client_id,
    status: inv.status,
    currency: inv.currency,
    total: inv.total,
    paid: inv.paid,
    due: inv.due,
    line_items: (inv.line_items ?? []).map((l) => ({
      id: l.id,
      service_id: l.service_id ?? null,
      description: l.description,
      qty: l.qty,
      amount: l.amount,
      taxed: Array.isArray(l.taxes) && l.taxes.length > 0,
    })),
  };
}

const lineInput = z.object({
  id: z.number().int().positive().optional().describe("Existing line ID to update; omit to add a new line"),
  description: z.string().max(1000).optional(),
  qty: z.number().positive().optional().describe("Default 1 for new lines"),
  amount: z.number().optional().describe("Unit price; negative for discounts"),
  tax: z.boolean().optional().describe("Apply the client's tax rules; default true for new lines, unchanged for updates"),
  service_id: z.number().int().positive().nullable().optional(),
});

export function registerInvoiceEditingTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "edit_invoice_lines",
    {
      title: "Edit invoice line items",
      description:
        "Add, update or remove line items on an invoice (Invoices.edit with `lines`). Entries with `id` update that line " +
        "(missing fields keep their current value), entries without `id` are added, `remove_line_ids` deletes lines. Untouched " +
        "lines stay as they are. Blesta refuses line changes on invoices that already have payments applied and on void invoices. " +
        "Header fields belong to update_invoice." +
        writeNote(api),
      inputSchema: z.object({
        invoice_id: z.number().int().positive(),
        lines: z.array(lineInput).default([]),
        remove_line_ids: z.array(z.number().int().positive()).default([]),
      }),
      annotations: WRITE,
    },
    guard(async ({ invoice_id, lines, remove_line_ids }) => {
      if (!lines.length && !remove_line_ids.length) return fail("Nothing to do: pass `lines` and/or `remove_line_ids`.");
      const inv = await fetchInvoice(api, invoice_id);
      if (!inv) return fail(`Invoice ${invoice_id} not found.`);
      if (inv.status === "void") return fail(`Invoice ${invoice_id} is void and cannot be edited.`);
      const existing = new Map((inv.line_items ?? []).map((l) => [Number(l.id), l]));

      const out: Record<string, unknown>[] = [];
      for (const id of remove_line_ids) {
        if (!existing.has(id)) return fail(`Line ${id} is not on invoice ${invoice_id}.`);
        out.push({ id, description: "", amount: "" });
      }
      for (const l of lines) {
        if (l.id !== undefined) {
          const cur = existing.get(l.id);
          if (!cur) return fail(`Line ${l.id} is not on invoice ${invoice_id}.`);
          if (remove_line_ids.includes(l.id)) return fail(`Line ${l.id} is both updated and removed.`);
          const description = l.description ?? cur.description ?? "";
          const amount = l.amount ?? Number(cur.amount ?? 0);
          if (!description.trim() && amount === 0) {
            return fail(`Line ${l.id}: empty description with zero amount would delete it; use remove_line_ids.`);
          }
          out.push({
            id: l.id,
            description,
            qty: l.qty ?? Number(cur.qty ?? 1),
            amount: amount.toFixed(4),
            tax: (l.tax ?? (Array.isArray(cur.taxes) && cur.taxes.length > 0)) ? 1 : 0,
            ...(l.service_id !== undefined ? { service_id: l.service_id } : cur.service_id ? { service_id: cur.service_id } : {}),
          });
        } else {
          if (!l.description?.trim()) return fail("New lines need a description.");
          if (l.amount === undefined) return fail(`New line "${l.description}" needs an amount.`);
          out.push({
            description: l.description,
            qty: l.qty ?? 1,
            amount: l.amount.toFixed(4),
            tax: (l.tax ?? true) ? 1 : 0,
            ...(l.service_id ? { service_id: l.service_id } : {}),
          });
        }
      }

      const vars: Record<string, unknown> = { status: inv.status, currency: inv.currency, lines: out };
      const delivery = await pendingDelivery(api, invoice_id);
      if (delivery.length) vars.delivery = delivery;
      await api.put("invoices", "edit", { invoice_id, vars });
      const after = await fetchInvoice(api, invoice_id);
      return ok({
        invoice_id,
        added: lines.filter((l) => l.id === undefined).length,
        updated: lines.filter((l) => l.id !== undefined).length,
        removed: remove_line_ids.length,
        invoice: after ? summarize(after) : null,
      });
    })
  );

  server.registerTool(
    "delete_invoice",
    {
      title: "Delete draft invoice",
      description:
        "Permanently delete a DRAFT invoice (Invoices.deleteDraft). Any other status is refused by Blesta; void those with " +
        "update_invoice `status: \"void\"` instead." + writeNote(api),
      inputSchema: z.object({ invoice_id: z.number().int().positive() }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ invoice_id }) => {
      const inv = await fetchInvoice(api, invoice_id);
      if (!inv) return fail(`Invoice ${invoice_id} not found.`);
      if (inv.status !== "draft") return fail(`Invoice ${invoice_id} is ${inv.status}; only drafts can be deleted. Void it instead.`);
      await api.delete("invoices", "deleteDraft", { invoice_id });
      const after = await fetchInvoice(api, invoice_id);
      return ok({ invoice_id, deleted: after === null, invoice_number: inv.id_code });
    })
  );

  server.registerTool(
    "merge_invoices",
    {
      title: "Merge invoices",
      description:
        "Combine several open invoices of one client and currency into a single invoice (Invoices.merge). Lines move to " +
        "`into_invoice_id` when given, otherwise a new active invoice is created; the source invoices are voided by Blesta." +
        writeNote(api),
      inputSchema: z.object({
        invoice_ids: z.array(z.number().int().positive()).min(2).max(50),
        into_invoice_id: z.number().int().positive().optional().describe("Existing invoice to receive the lines"),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ invoice_ids, into_invoice_id }) => {
      const ids = [...new Set(invoice_ids)];
      const invoices: InvoiceRecord[] = [];
      for (const id of ids) {
        const inv = await fetchInvoice(api, id);
        if (!inv) return fail(`Invoice ${id} not found.`);
        invoices.push(inv);
      }
      const clients = new Set(invoices.map((i) => String(i.client_id)));
      const currencies = new Set(invoices.map((i) => i.currency));
      if (clients.size > 1) return fail(`Invoices belong to different clients: ${[...clients].join(", ")}.`);
      if (currencies.size > 1) return fail(`Invoices use different currencies: ${[...currencies].join(", ")}.`);
      const bad = invoices.filter((i) => !["active", "proforma", "draft"].includes(i.status));
      if (bad.length) return fail(`Not open: ${bad.map((i) => `${i.id} (${i.status})`).join(", ")}.`);
      const merged_id = await api.post<number>("invoices", "merge", {
        invoice_ids: ids,
        ...(into_invoice_id ? { invoice_id: into_invoice_id } : {}),
      });
      const merged = await fetchInvoice(api, merged_id);
      return ok({ merged_invoice_id: merged_id, source_invoice_ids: ids, invoice: merged ? summarize(merged) : null });
    })
  );

  server.registerTool(
    "split_invoice",
    {
      title: "Split invoice",
      description:
        "Move some line items of an invoice onto a new invoice (Invoices.split). At least one line must stay behind." +
        writeNote(api),
      inputSchema: z.object({
        invoice_id: z.number().int().positive(),
        line_ids: z.array(z.number().int().positive()).min(1).describe("Line IDs to move to the new invoice"),
      }),
      annotations: WRITE,
    },
    guard(async ({ invoice_id, line_ids }) => {
      const inv = await fetchInvoice(api, invoice_id);
      if (!inv) return fail(`Invoice ${invoice_id} not found.`);
      const all = inv.line_items ?? [];
      const move = all.filter((l) => line_ids.includes(Number(l.id)));
      const missing = line_ids.filter((id) => !all.some((l) => Number(l.id) === id));
      if (missing.length) return fail(`Lines not on invoice ${invoice_id}: ${missing.join(", ")}.`);
      if (move.length >= all.length) return fail("At least one line must remain on the original invoice.");
      const new_id = await api.put<number>("invoices", "split", {
        invoice_id,
        line_items: move.map((l) => ({ id: l.id, description: l.description, qty: l.qty, amount: l.amount })),
      });
      const [original, created] = await Promise.all([fetchInvoice(api, invoice_id), fetchInvoice(api, new_id)]);
      return ok({
        original: original ? summarize(original) : null,
        new_invoice: created ? summarize(created) : null,
      });
    })
  );

  server.registerTool(
    "append_services_to_invoice",
    {
      title: "Append services to invoice",
      description:
        "Add line items for services to an existing invoice, priced by Blesta from the service's package " +
        "(Invoices.appendServices). Useful to bill several services on one invoice." + writeNote(api),
      inputSchema: z.object({
        invoice_id: z.number().int().positive(),
        service_ids: z.array(z.number().int().positive()).min(1).max(50),
      }),
      annotations: WRITE,
    },
    guard(async ({ invoice_id, service_ids }) => {
      const inv = await fetchInvoice(api, invoice_id);
      if (!inv) return fail(`Invoice ${invoice_id} not found.`);
      if (inv.status === "void") return fail(`Invoice ${invoice_id} is void.`);
      await api.put("invoices", "appendServices", { invoice_id, service_ids: [...new Set(service_ids)] });
      const after = await fetchInvoice(api, invoice_id);
      return ok({ invoice_id, appended_service_ids: [...new Set(service_ids)], invoice: after ? summarize(after) : null });
    })
  );

  server.registerTool(
    "set_invoice_closed",
    {
      title: "Recalculate invoice closed state",
      description:
        "Re-evaluate one active invoice: mark it closed if paid in full, otherwise clear a stale closed date " +
        "(Invoices.setClosed). Normally automatic; use after unusual manual transaction edits." + writeNote(api),
      inputSchema: z.object({ invoice_id: z.number().int().positive() }),
      annotations: WRITE,
    },
    guard(async ({ invoice_id }) => {
      const inv = await fetchInvoice(api, invoice_id);
      if (!inv) return fail(`Invoice ${invoice_id} not found.`);
      const closed = await api.put<boolean>("invoices", "setClosed", { invoice_id });
      const after = await fetchInvoice(api, invoice_id);
      return ok({ invoice_id, closed: Boolean(closed), invoice: after ? summarize(after) : null });
    })
  );
}
