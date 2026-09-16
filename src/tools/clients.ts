import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";
import { READ, WRITE, DESTRUCTIVE, resolveStaffId, writeNote } from "../common.js";

export function registerClientTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "search_clients",
    {
      title: "Search clients",
      description:
        "Find customers matching a free-text query (email, first/last name, company, client ID code such as '1234'). " +
        "Wraps Clients.search. Returns a page of client records including the primary contact's name, email and status. " +
        "Use get_client with the returned `id` for full details.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Text to search for: email address, name, company or client number"),
        page: z.number().int().min(1).default(1).describe("Result page, starting at 1"),
      }),
      annotations: READ,
    },
    guard(async ({ query, page }) => {
      const [results, count] = await Promise.all([
        api.get("clients", "search", { query, page }),
        api.get<number>("clients", "getSearchCount", { query }),
      ]);
      return ok({ query, page, total_matches: count, results: results || [] });
    })
  );

  server.registerTool(
    "get_client",
    {
      title: "Get client",
      description:
        "Retrieve one customer by numeric client ID: identity, primary contact details (name, email, address, phone numbers), " +
        "status (active/inactive/fraud), client group and, optionally, effective settings (currency, language, autodebit, ...). " +
        "Wraps Clients.get.",
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID (the `id` field, not the displayed id_code)"),
        include_settings: z
          .boolean()
          .default(false)
          .describe("Also return the client's effective settings (default currency, language, tax exempt, autodebit, ...)"),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, include_settings }) => {
      const client = await api.get("clients", "get", { client_id, get_settings: include_settings });
      if (isMissing(client)) return fail(`No client found with id ${client_id}.`);
      return ok(client);
    })
  );

  server.registerTool(
    "get_client_contacts",
    {
      title: "Get client contacts",
      description:
        "All contacts under a client (primary, billing, other) with name, email, address and phone/fax numbers. " +
        "Wraps Contacts.getAll and Contacts.getNumbers.",
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID"),
        contact_type: z.enum(["primary", "billing", "other"]).optional().describe("Filter by contact type"),
        include_numbers: z.boolean().default(true).describe("Fetch phone/fax numbers for each contact (one call per contact)"),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, contact_type, include_numbers }) => {
      const list = await api.get<Array<Record<string, unknown>> | false>("contacts", "getAll", { client_id, contact_type });
      let contacts = Array.isArray(list) ? list : [];
      if (include_numbers && contacts.length) {
        contacts = await Promise.all(
          contacts.map(async (c) => {
            const numbers = await api.get("contacts", "getNumbers", { contact_id: Number(c.id) });
            return { ...c, numbers: Array.isArray(numbers) ? numbers : [] };
          })
        );
      }
      return ok({ client_id, total: contacts.length, contacts });
    })
  );

  server.registerTool(
    "get_client_notes",
    {
      title: "Get client notes",
      description:
        "Staff notes on a client account, newest first, plus pinned (sticky) notes. Read these before acting on an account. " +
        "Wraps Clients.getNoteList, Clients.getNoteListCount and Clients.getAllStickyNotes.",
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID"),
        page: z.number().int().min(1).default(1).describe("Result page, starting at 1"),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, page }) => {
      const [notes, total, sticky] = await Promise.all([
        api.get("clients", "getNoteList", { client_id, page, order_by: { date_added: "DESC" } }),
        api.get<number>("clients", "getNoteListCount", { client_id }),
        api.get("clients", "getAllStickyNotes", { client_id }),
      ]);
      return ok({ client_id, page, total_notes: total, sticky_notes: sticky || [], notes: notes || [] });
    })
  );

  server.registerTool(
    "get_client_balance",
    {
      title: "Get client balance",
      description:
        "Amount the client owes in a currency (sum of open invoices) plus invoice counts by status (open, past_due, closed, ...). " +
        "Wraps Invoices.amountDue and Invoices.getStatusCount. Use get_client with include_settings to learn the client's default currency.",
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID"),
        currency: z.string().length(3).describe("ISO 4217 currency code, e.g. USD or EUR"),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, currency }) => {
      const cur = currency.toUpperCase();
      const statuses = ["open", "past_due", "closed", "draft", "void", "proforma"] as const;
      const [due, pastDue, ...counts] = await Promise.all([
        api.get<number>("invoices", "amountDue", { client_id, currency: cur, status: "open" }),
        api.get<number>("invoices", "amountDue", { client_id, currency: cur, status: "past_due" }),
        ...statuses.map((s) => api.get<number>("invoices", "getStatusCount", { client_id, status: s })),
      ]);
      const invoice_counts = Object.fromEntries(statuses.map((s, i) => [s, Number(counts[i] ?? 0)]));
      return ok({ client_id, currency: cur, amount_due: Number(due ?? 0), amount_past_due: Number(pastDue ?? 0), invoice_counts });
    })
  );

  server.registerTool(
    "add_client_note",
    {
      title: "Add client note",
      description:
        "Record a staff note on a client account (e.g. summary of a support interaction). Wraps Clients.addNote. " +
        "staff_id defaults to BLESTA_STAFF_ID." + writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID"),
        title: z.string().min(1).max(255).describe("Short note title"),
        description: z.string().default("").describe("Note body"),
        sticky: z.boolean().default(false).describe("Pin the note at the top of the client's profile"),
        staff_id: z.number().int().positive().optional().describe("Staff member to attribute the note to; defaults to BLESTA_STAFF_ID"),
      }),
      annotations: WRITE,
    },
    guard(async ({ client_id, title, description, sticky, staff_id }) => {
      const staff = resolveStaffId(staff_id);
      if (!staff) return fail("staff_id is required: pass it or set BLESTA_STAFF_ID.");
      const note_id = await api.post("clients", "addNote", {
        client_id,
        staff_id: staff,
        vars: { title, description, stickied: sticky ? 1 : 0 },
      });
      return ok({ client_id, note_id, title });
    })
  );

  server.registerTool(
    "update_client_status",
    {
      title: "Update client status",
      description:
        "Set a client's status to active, inactive or fraud. Wraps Clients.edit(client_id, {status}). " +
        "Inactive/fraud clients cannot log in; fraud also blocks orders." + writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive().describe("Numeric client ID"),
        status: z.enum(["active", "inactive", "fraud"]).describe("New status"),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ client_id, status }) => {
      await api.put("clients", "edit", { client_id, vars: { status } });
      const client = await api.get<Record<string, unknown> | false>("clients", "get", { client_id, get_settings: false });
      return ok({ client_id, status: isMissing(client) ? status : (client as Record<string, unknown>).status });
    })
  );
}
