import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";
import { READ, WRITE, DESTRUCTIVE, resolveStaffId, writeNote } from "../common.js";

export const TRANSACTION_STATUSES = ["approved", "declined", "void", "error", "pending", "returned", "refunded", "all"] as const;

interface TransactionType { id: number | string; name?: string; real_name?: string; type?: string }

/**
 * Resolves an offline payment type name (e.g. "Check", "Wire Transfer") to its transaction_types.id
 * via Transactions.getTypes. Matches name or real_name, case-insensitively.
 */
async function resolveTransactionTypeId(api: BlestaClient, name: string): Promise<number | string> {
  const types = await api.get<TransactionType[] | false>("transactions", "getTypes");
  const list = Array.isArray(types) ? types : [];
  const wanted = name.trim().toLowerCase();
  const hit = list.find(
    (t) => t.name?.toLowerCase() === wanted || t.real_name?.toLowerCase() === wanted || String(t.id) === wanted
  );
  if (!hit) {
    const known = list.map((t) => t.real_name ?? t.name ?? String(t.id)).join(", ") || "(none configured)";
    throw new Error(`Unknown payment type "${name}". Configured types: ${known}`);
  }
  return hit.id;
}

export function registerTransactionTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "get_client_transactions",
    {
      title: "Get client transactions",
      description:
        "Payment history for a client (or all clients): amount, currency, type (cc/ach/other), status, gateway, reference and which invoices each " +
        "payment was applied to. Wraps Transactions.getList / getListCount. Filters: payment_type, reference_id, date and amount ranges, " +
        "applied_status (fully_applied, partially_applied, not_applied).",
      inputSchema: z.object({
        client_id: z.number().int().positive().optional().describe("Omit to list across all clients"),
        status: z.enum(TRANSACTION_STATUSES).default("approved"),
        page: z.number().int().min(1).default(1),
        payment_type: z.string().optional().describe("cc, ach, or a transaction type name such as 'check'"),
        reference_id: z.string().optional(),
        applied_status: z.enum(["fully_applied", "partially_applied", "not_applied"]).optional(),
        start_date: z.string().optional().describe("ISO 8601 with timezone"),
        end_date: z.string().optional().describe("ISO 8601 with timezone"),
        start_amount: z.number().optional(),
        end_amount: z.number().optional(),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, status, page, ...f }) => {
      const filters = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
      const [results, total] = await Promise.all([
        api.get("transactions", "getList", { client_id, status, page, order_by: { date_added: "DESC" }, filters }),
        api.get<number>("transactions", "getListCount", { client_id, status, filters }),
      ]);
      return ok({ client_id, status, page, total_matches: total, results: results || [] });
    })
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description: "One payment in full plus the invoices it was applied to. Wraps Transactions.get and Transactions.getApplied(transaction_id).",
      inputSchema: z.object({ transaction_id: z.number().int().positive() }),
      annotations: READ,
    },
    guard(async ({ transaction_id }) => {
      const [tx, applied] = await Promise.all([
        api.get<Record<string, unknown> | false>("transactions", "get", { transaction_id }),
        api.get("transactions", "getApplied", { transaction_id }),
      ]);
      if (isMissing(tx)) return fail(`No transaction found with id ${transaction_id}.`);
      return ok({ ...(tx as Record<string, unknown>), applied: applied || [] });
    })
  );

  server.registerTool(
    "get_payment_accounts",
    {
      title: "Get payment accounts",
      description:
        "Cards and bank accounts a client has on file (masked: last4, type, expiry, holder name, gateway reference). Never returns full numbers. " +
        "Wraps Accounts.getAllCcByClient and Accounts.getAllAchByClient. Useful for autodebit failures and expired cards.",
      inputSchema: z.object({ client_id: z.number().int().positive() }),
      annotations: READ,
    },
    guard(async ({ client_id }) => {
      const [cc, ach] = await Promise.all([
        api.get("accounts", "getAllCcByClient", { client_id }),
        api.get("accounts", "getAllAchByClient", { client_id, unverified: true }),
      ]);
      return ok({ client_id, credit_cards: cc || [], bank_accounts: ach || [] });
    })
  );

  server.registerTool(
    "record_manual_payment",
    {
      title: "Record manual payment",
      description:
        "Record an offline payment (bank transfer, cash, check) and apply it to invoices. Wraps Transactions.add then Transactions.apply. " +
        "Does not charge anything; it only records money already received. Omit `apply_to` to leave the amount as unapplied credit." +
        writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive(),
        amount: z.number().positive(),
        currency: z.string().length(3),
        apply_to: z
          .array(z.object({ invoice_id: z.number().int().positive(), amount: z.number().positive() }))
          .optional()
          .describe("Invoices to apply the payment to; total must not exceed amount"),
        payment_type: z
          .string()
          .optional()
          .describe("Offline payment type name as configured in Blesta (e.g. Check, Wire Transfer); resolved via Transactions.getTypes"),
        reference: z.string().optional().describe("Bank reference / check number"),
        message: z.string().optional().describe("Free-text note stored on the transaction"),
        date_received: z.string().optional().describe("ISO 8601 with timezone; default now"),
      }),
      annotations: WRITE,
    },
    guard(async ({ client_id, amount, currency, apply_to, payment_type, reference, message, date_received }) => {
      const applied = (apply_to ?? []).reduce((s, a) => s + a.amount, 0);
      if (applied > amount + 1e-9) return fail(`apply_to total ${applied} exceeds payment amount ${amount}.`);
      const vars: Record<string, unknown> = {
        client_id,
        amount: amount.toFixed(4),
        currency: currency.toUpperCase(),
        type: "other",
        status: "approved",
      };
      if (payment_type) {
        try {
          vars.transaction_type_id = await resolveTransactionTypeId(api, payment_type);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      if (reference) vars.reference_id = reference;
      if (message) vars.message = message;
      if (date_received) vars.date_added = date_received;
      const transaction_id = await api.post<number>("transactions", "add", { vars });
      let apply_error: string | undefined;
      if (apply_to?.length) {
        try {
          await api.put("transactions", "apply", {
            transaction_id,
            vars: { amounts: apply_to.map((a) => ({ invoice_id: a.invoice_id, amount: a.amount.toFixed(4) })) },
          });
        } catch (e) {
          apply_error = e instanceof Error ? e.message : String(e);
        }
      }
      const tx = await api.get("transactions", "get", { transaction_id });
      return ok({ transaction_id, transaction: tx, ...(apply_error ? { apply_error, note: "Transaction was recorded but not applied." } : {}) });
    })
  );

  server.registerTool(
    "record_invoice_payment",
    {
      title: "Record invoice payment",
      description:
        "Record an offline payment (bank transfer, cash, check) against ONE invoice by invoice ID. Looks up the client, currency and " +
        "amount due from the invoice, records the transaction (Transactions.add, type other, status approved) and applies it to that " +
        "invoice (Transactions.apply). `amount` defaults to the amount still due. Nothing is charged; use this when money was already received. " +
        "For several invoices or unapplied credit use record_manual_payment." +
        writeNote(api),
      inputSchema: z.object({
        invoice_id: z.number().int().positive().describe("Numeric invoice ID"),
        amount: z.number().positive().optional().describe("Amount received; default is the invoice's remaining due"),
        allow_overpayment: z
          .boolean()
          .default(false)
          .describe("When amount exceeds the due, apply the due and keep the remainder as unapplied client credit instead of failing"),
        payment_type: z
          .string()
          .optional()
          .describe("Offline payment type name as configured in Blesta (e.g. Check, Wire Transfer); resolved via Transactions.getTypes"),
        reference: z.string().optional().describe("Bank reference / check number"),
        message: z.string().optional().describe("Free-text note stored on the transaction"),
        date_received: z.string().optional().describe("ISO 8601 with timezone; default now"),
      }),
      annotations: WRITE,
    },
    guard(async ({ invoice_id, amount, allow_overpayment, payment_type, reference, message, date_received }) => {
      const inv = await api.get<
        { id: number; client_id: number | string; currency: string; status: string; total?: string; paid?: string; due?: string } | false
      >("invoices", "get", { invoice_id });
      if (!inv || typeof inv !== "object") return fail(`Invoice ${invoice_id} not found.`);
      if (inv.status === "void" || inv.status === "draft") {
        return fail(`Invoice ${invoice_id} is ${inv.status}; payments cannot be applied to it.`);
      }
      const total = Number(inv.total ?? 0);
      const paid = Number(inv.paid ?? 0);
      const due = inv.due !== undefined && inv.due !== null ? Number(inv.due) : total - paid;
      if (due <= 0) return fail(`Invoice ${invoice_id} has nothing due (total ${total}, paid ${paid}).`);
      const received = amount ?? due;
      if (received > due + 1e-9 && !allow_overpayment) {
        return fail(
          `Amount ${received} exceeds the ${due} due on invoice ${invoice_id}. Pass allow_overpayment=true to apply ${due} and keep the rest as credit.`
        );
      }
      const applied = Math.min(received, due);

      const vars: Record<string, unknown> = {
        client_id: Number(inv.client_id),
        amount: received.toFixed(4),
        currency: inv.currency,
        type: "other",
        status: "approved",
      };
      if (payment_type) {
        try {
          vars.transaction_type_id = await resolveTransactionTypeId(api, payment_type);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      if (reference) vars.reference_id = reference;
      if (message) vars.message = message;
      if (date_received) vars.date_added = date_received;

      const transaction_id = await api.post<number>("transactions", "add", { vars });
      let apply_error: string | undefined;
      try {
        await api.put("transactions", "apply", {
          transaction_id,
          vars: { amounts: [{ invoice_id, amount: applied.toFixed(4) }] },
        });
      } catch (e) {
        apply_error = e instanceof Error ? e.message : String(e);
      }
      const after = await api.get<{ status?: string; paid?: string; due?: string } | false>("invoices", "get", { invoice_id });
      return ok({
        transaction_id,
        invoice_id,
        amount_received: received,
        amount_applied: apply_error ? 0 : applied,
        unapplied_credit: apply_error ? received : received - applied,
        invoice_after: after && typeof after === "object" ? { status: after.status, paid: after.paid, due: after.due } : null,
        ...(apply_error ? { apply_error, note: "Transaction was recorded but not applied to the invoice." } : {}),
      });
    })
  );

  server.registerTool(
    "apply_transaction",
    {
      title: "Apply transaction to invoices",
      description:
        "Apply an existing transaction's unapplied balance (client credit) to one or more invoices in the same currency. Wraps Transactions.apply." +
        writeNote(api),
      inputSchema: z.object({
        transaction_id: z.number().int().positive(),
        amounts: z.array(z.object({ invoice_id: z.number().int().positive(), amount: z.number().positive() })).min(1),
      }),
      annotations: WRITE,
    },
    guard(async ({ transaction_id, amounts }) => {
      await api.put("transactions", "apply", {
        transaction_id,
        vars: { amounts: amounts.map((a) => ({ invoice_id: a.invoice_id, amount: a.amount.toFixed(4) })) },
      });
      const applied = await api.get("transactions", "getApplied", { transaction_id });
      return ok({ transaction_id, applied: applied || [] });
    })
  );

  const paymentsEnabled = process.env.BLESTA_ALLOW_PAYMENTS === "1" || process.env.BLESTA_ALLOW_PAYMENTS === "true";
  server.registerTool(
    "process_payment",
    {
      title: "Charge payment account on file",
      description:
        "Charge a client's stored card or bank account through the payment gateway and apply the result to invoices. Wraps Payments.processPayment " +
        "with account_id only; raw card data is never accepted. Sends the client a receipt unless disabled. Moves real money." +
        (paymentsEnabled ? "" : " DISABLED: set BLESTA_ALLOW_PAYMENTS=1 to enable.") +
        writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive(),
        account_id: z.number().int().positive().describe("Stored payment account id from get_payment_accounts"),
        type: z.enum(["cc", "ach"]).describe("Kind of stored account"),
        amount: z.number().positive(),
        currency: z.string().length(3),
        invoices: z.record(z.string(), z.number().positive()).optional().describe("Map of invoice_id -> amount to apply; total must not exceed amount"),
        email_receipt: z.boolean().default(true),
        staff_id: z.number().int().positive().optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ client_id, account_id, type, amount, currency, invoices, email_receipt, staff_id }) => {
      if (!paymentsEnabled) return fail("process_payment is disabled. Set BLESTA_ALLOW_PAYMENTS=1 on the server to enable charging stored accounts.");
      const applied = Object.values(invoices ?? {}).reduce((s, v) => s + v, 0);
      if (applied > amount + 1e-9) return fail(`invoices total ${applied} exceeds amount ${amount}.`);
      const options: Record<string, unknown> = { email_receipt };
      if (invoices) options.invoices = Object.fromEntries(Object.entries(invoices).map(([k, v]) => [k, v.toFixed(4)]));
      const staff = resolveStaffId(staff_id);
      if (staff) options.staff_id = staff;
      const result = await api.post("payments", "processPayment", {
        client_id,
        type,
        amount: amount.toFixed(4),
        currency: currency.toUpperCase(),
        account_id,
        options,
      });
      return ok({ client_id, account_id, amount, currency: currency.toUpperCase(), transaction: result });
    })
  );
}
