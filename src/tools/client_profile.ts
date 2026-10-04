import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BlestaError, type BlestaClient } from "../client.js";
import { guard, ok, fail } from "../format.js";
import { WRITE, DESTRUCTIVE, resolveStaffId, resolveCompanyId, writeNote } from "../common.js";
import { sharedPhoneIndex } from "../phone_index.js";

/**
 * Client profile editing: contact details (names, email, address), phone numbers, additional
 * contacts and per-client settings.
 *
 * Facts from app/models/contacts.php, app/models/clients.php and the admin controller:
 *  - Contacts.edit updates only the keys it is given, but its validation always demands
 *    first_name, last_name and email, so those three are re-sent from the current record.
 *  - Unless `verify` is sent false, a client group with email verification makes Contacts.edit keep
 *    the OLD email and start a verification instead. The admin UI always sends verify = false.
 *  - The login is a separate Users record. When the username is the email address the admin UI
 *    also calls Users.edit so the login follows the new email; this module does the same.
 *  - Numbers are changed with addNumber / editNumber / deleteNumber, not through Contacts.edit.
 *  - Staff edits settings with Clients.setSettings and an explicit key list; setClientSettings
 *    applies the client-side "may the customer change this" rules and would refuse staff changes.
 */

interface Contact {
  id: number | string;
  client_id: number | string;
  contact_type?: string;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  company?: string | null;
  email?: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

interface ClientRecord {
  id: number | string;
  user_id?: number | string;
  contact_id?: number | string;
  username?: string;
  email?: string;
  settings?: Record<string, unknown>;
}

interface NumberRow {
  id: number | string;
  contact_id: number | string;
  number: string;
  type?: string;
  location?: string;
}

const CONTACT_FIELDS = ["first_name", "last_name", "title", "company", "email", "address1", "address2", "city", "state", "zip", "country"] as const;

const contactFieldSchema = {
  first_name: z.string().min(1).max(255).optional(),
  last_name: z.string().min(1).max(255).optional(),
  title: z.string().max(255).optional().describe("Job title"),
  company: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
  address1: z.string().max(255).optional(),
  address2: z.string().max(255).optional(),
  city: z.string().max(255).optional(),
  state: z.string().max(3).optional().describe("ISO 3166-2 subdivision code (up to 3 characters); needs a country"),
  zip: z.string().max(20).optional(),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code"),
};

const numberSchema = z.object({
  number: z.string().min(1).max(64),
  type: z.enum(["phone", "fax"]).default("phone"),
  location: z.enum(["home", "work", "mobile"]).default("mobile"),
});

async function getContact(api: BlestaClient, contact_id: number): Promise<Contact | null> {
  const c = await api.get<Contact | false>("contacts", "get", { contact_id });
  return c && typeof c === "object" ? c : null;
}

async function getClient(api: BlestaClient, client_id: number): Promise<ClientRecord | null> {
  const c = await api.get<ClientRecord | false>("clients", "get", { client_id, get_settings: true });
  return c && typeof c === "object" ? c : null;
}

/** Resolves the contact to edit: an explicit contact, or the client's primary contact. */
async function resolveContact(
  api: BlestaClient,
  a: { client_id?: number; contact_id?: number }
): Promise<{ contact: Contact; client: ClientRecord } | string> {
  if (a.contact_id === undefined && a.client_id === undefined) return "Pass client_id (primary contact) or contact_id.";
  let contact: Contact | null = null;
  let client: ClientRecord | null = null;
  if (a.contact_id !== undefined) {
    contact = await getContact(api, a.contact_id);
    if (!contact) return `Contact ${a.contact_id} not found.`;
    if (a.client_id !== undefined && Number(contact.client_id) !== a.client_id) {
      return `Contact ${a.contact_id} belongs to client ${contact.client_id}, not ${a.client_id}.`;
    }
    client = await getClient(api, Number(contact.client_id));
  } else {
    client = await getClient(api, a.client_id!);
    if (!client) return `Client ${a.client_id} not found.`;
    contact = await getContact(api, Number(client.contact_id));
  }
  if (!client) return `Client ${contact?.client_id} not found.`;
  if (!contact) return `Primary contact of client ${client.id} not found.`;
  return { contact, client };
}

async function numbersOf(api: BlestaClient, contact_id: number): Promise<NumberRow[]> {
  const rows = await api.get<NumberRow[] | false>("contacts", "getNumbers", { contact_id });
  return Array.isArray(rows) ? rows : [];
}

function settingOf(client: ClientRecord, key: string): string | undefined {
  const v = client.settings?.[key];
  return v === undefined || v === null ? undefined : String(v);
}

export function registerClientProfileTools(server: McpServer, api: BlestaClient): void {
  const phones = sharedPhoneIndex(api);

  server.registerTool(
    "update_client_profile",
    {
      title: "Update client profile",
      description:
        "Change a client's contact details: first/last name, email, title, company, address, city, state, zip, country " +
        "(Contacts.edit). With `client_id` the primary contact is edited; pass `contact_id` for a billing or other contact. " +
        "Only the fields you pass change. When the email of the primary contact changes and the client logs in with their " +
        "email address, the login username is updated too (Users.edit), exactly as the Blesta admin UI does. " +
        "Phone numbers are changed with set_contact_number. `dry_run` validates with Contacts.validateContact and writes nothing." +
        writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive().optional().describe("Edit this client's primary contact"),
        contact_id: z.number().int().positive().optional().describe("Edit this specific contact instead"),
        ...contactFieldSchema,
        update_login: z
          .boolean()
          .default(true)
          .describe("When the primary contact's email changes and the login username is that email, change the username too"),
        verify_email: z
          .boolean()
          .default(false)
          .describe("true = let Blesta send an email verification and keep the old address until confirmed; false = apply immediately"),
        dry_run: z.boolean().default(false),
      }),
      annotations: WRITE,
    },
    guard(async (a) => {
      const resolved = await resolveContact(api, a);
      if (typeof resolved === "string") return fail(resolved);
      const { contact, client } = resolved;
      const contact_id = Number(contact.id);

      const changes: Record<string, string> = {};
      for (const f of CONTACT_FIELDS) {
        const v = a[f];
        if (v !== undefined && v !== (contact[f] ?? "")) changes[f] = f === "country" ? v.toUpperCase() : v;
      }
      if (!Object.keys(changes).length) return fail("Nothing to change: every given field already has that value (or no field was passed).");
      if (changes.state !== undefined && !(changes.country ?? contact.country)) return fail("`state` needs a country; pass `country` too.");

      // Validation always wants these three, even when they are not changing.
      const vars: Record<string, unknown> = {
        first_name: contact.first_name ?? "",
        last_name: contact.last_name ?? "",
        email: contact.email ?? "",
        ...changes,
        verify: a.verify_email,
      };
      if (changes.state !== undefined && changes.country === undefined && contact.country) vars.country = contact.country;
      const staff_id = resolveStaffId(undefined);
      if (staff_id) vars.staff_id = staff_id;

      if (a.dry_run) {
        await api.get("contacts", "validateContact", { vars: { contact_id, ...vars }, edit: true, validate_client: true });
        return ok({ dry_run: true, valid: true, would_call: "contacts/edit", contact_id, changes });
      }

      await api.put("contacts", "edit", { contact_id, vars });
      const after = await getContact(api, contact_id);

      const applied: Record<string, { from: unknown; to: unknown }> = {};
      const not_applied: string[] = [];
      for (const f of Object.keys(changes) as Array<(typeof CONTACT_FIELDS)[number]>) {
        if (after && (after[f] ?? "") === changes[f]) applied[f] = { from: contact[f] ?? null, to: after[f] };
        else not_applied.push(f);
      }

      // Keep the login in step with the email, as AdminClients::edit does.
      let login: Record<string, unknown> | undefined;
      const isPrimary = contact.contact_type === "primary" || Number(client.contact_id) === contact_id;
      if (applied.email && isPrimary && a.update_login && client.user_id !== undefined) {
        const oldEmail = String(contact.email ?? "");
        const emailLogin = settingOf(client, "username_type") === "email" || (client.username !== undefined && client.username === oldEmail);
        if (emailLogin) {
          try {
            await api.put("users", "edit", { user_id: client.user_id, vars: { username: changes.email, verify: false }, validate_pass: false });
            login = { login_username_updated: true, username: changes.email };
          } catch (e) {
            login = {
              login_username_updated: false,
              login_update_error: e instanceof BlestaError ? e.describe() : e instanceof Error ? e.message : String(e),
              note: "The contact email changed but the login username did not; the customer still signs in with the old address.",
            };
          }
        }
      }

      return ok({
        contact_id,
        client_id: Number(contact.client_id),
        applied,
        ...(not_applied.length
          ? {
              not_applied,
              note: not_applied.includes("email")
                ? "Blesta kept the old email: email verification is pending for the new address."
                : "Some fields did not change; compare with the returned contact.",
            }
          : {}),
        ...(login ?? {}),
        contact: after,
      });
    })
  );

  server.registerTool(
    "set_contact_number",
    {
      title: "Add, change or remove a phone number",
      description:
        "Manage the phone/fax numbers of a client's contact: `add` (Contacts.addNumber), `update` (Contacts.editNumber) or " +
        "`delete` (Contacts.deleteNumber). With `client_id` the primary contact is used; pass `contact_id` for another contact. " +
        "Number IDs come from get_client_contacts. The phone search index is refreshed for that contact afterwards." +
        writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive().optional(),
        contact_id: z.number().int().positive().optional(),
        action: z.enum(["add", "update", "delete"]),
        number_id: z.number().int().positive().optional().describe("Required for update and delete"),
        number: z.string().min(1).max(64).optional().describe("Required for add; new value for update"),
        type: z.enum(["phone", "fax"]).optional().describe("Default phone when adding"),
        location: z.enum(["home", "work", "mobile"]).optional().describe("Default mobile when adding"),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async (a) => {
      const resolved = await resolveContact(api, a);
      if (typeof resolved === "string") return fail(resolved);
      const { contact, client } = resolved;
      const contact_id = Number(contact.id);
      const before = await numbersOf(api, contact_id);

      if (a.action === "add") {
        if (!a.number) return fail("`number` is required to add.");
        await api.post("contacts", "addNumber", {
          contact_id,
          vars: { number: a.number, type: a.type ?? "phone", location: a.location ?? "mobile" },
        });
      } else {
        if (a.number_id === undefined) return fail(`\`number_id\` is required to ${a.action}; see get_client_contacts.`);
        const cur = before.find((n) => Number(n.id) === a.number_id);
        if (!cur) return fail(`Number ${a.number_id} does not belong to contact ${contact_id}.`);
        if (a.action === "delete") {
          await api.delete("contacts", "deleteNumber", { contact_number_id: a.number_id });
        } else {
          if (a.number === undefined && a.type === undefined && a.location === undefined) return fail("Nothing to update.");
          await api.put("contacts", "editNumber", {
            contact_number_id: a.number_id,
            vars: { number: a.number ?? cur.number, type: a.type ?? cur.type ?? "phone", location: a.location ?? cur.location ?? "mobile" },
          });
        }
      }

      const primary = contact.contact_type === "primary" || Number(client.contact_id) === contact_id;
      await phones.refreshContact(Number(contact.client_id), contact_id, primary);
      return ok({ contact_id, client_id: Number(contact.client_id), action: a.action, numbers: await numbersOf(api, contact_id) });
    })
  );

  server.registerTool(
    "add_client_contact",
    {
      title: "Add client contact",
      description:
        "Add an additional contact (billing or other) to a client, optionally with phone numbers (Contacts.add). " +
        "The primary contact already exists and is edited with update_client_profile. `dry_run` validates only." +
        writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive(),
        contact_type: z.enum(["billing", "other"]).default("billing"),
        contact_type_id: z.number().int().positive().optional().describe("Custom contact type ID when contact_type is other"),
        ...contactFieldSchema,
        first_name: z.string().min(1).max(255),
        last_name: z.string().min(1).max(255),
        email: z.string().email().max(255),
        numbers: z.array(numberSchema).max(10).default([]),
        dry_run: z.boolean().default(false),
      }),
      annotations: WRITE,
    },
    guard(async (a) => {
      const client = await getClient(api, a.client_id);
      if (!client) return fail(`Client ${a.client_id} not found.`);
      if (a.state !== undefined && !a.country) return fail("`state` needs a country; pass `country` too.");
      const vars: Record<string, unknown> = { client_id: a.client_id, contact_type: a.contact_type, verify: false };
      if (a.contact_type_id) vars.contact_type_id = a.contact_type_id;
      for (const f of CONTACT_FIELDS) if (a[f] !== undefined) vars[f] = f === "country" ? a[f]!.toUpperCase() : a[f];
      if (a.numbers.length) vars.numbers = a.numbers;
      const staff_id = resolveStaffId(undefined);
      if (staff_id) vars.staff_id = staff_id;

      if (a.dry_run) {
        await api.get("contacts", "validateContact", { vars, edit: false, validate_client: true });
        return ok({ dry_run: true, valid: true, would_call: "contacts/add", vars });
      }
      const contact_id = Number(await api.post<number>("contacts", "add", { vars }));
      await phones.refreshContact(a.client_id, contact_id, false);
      return ok({ contact_id, client_id: a.client_id, contact: await getContact(api, contact_id), numbers: await numbersOf(api, contact_id) });
    })
  );

  server.registerTool(
    "delete_client_contact",
    {
      title: "Delete client contact",
      description:
        "Permanently remove an additional contact and its phone numbers (Contacts.delete). Blesta refuses the primary contact " +
        "and the contact invoices are addressed to; the tool checks both first." + writeNote(api),
      inputSchema: z.object({ contact_id: z.number().int().positive() }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ contact_id }) => {
      const contact = await getContact(api, contact_id);
      if (!contact) return fail(`Contact ${contact_id} not found.`);
      const client = await getClient(api, Number(contact.client_id));
      if (contact.contact_type === "primary" || (client && Number(client.contact_id) === contact_id)) {
        return fail(`Contact ${contact_id} is the primary contact of client ${contact.client_id} and cannot be deleted.`);
      }
      if (client && settingOf(client, "inv_address_to") === String(contact_id)) {
        return fail(
          `Invoices of client ${contact.client_id} are addressed to contact ${contact_id}. Point them elsewhere first: update_client_settings with inv_address_to.`
        );
      }
      await api.delete("contacts", "delete", { contact_id });
      const gone = (await getContact(api, contact_id)) === null;
      if (gone) await phones.removeContact(contact_id);
      return ok({ contact_id, client_id: Number(contact.client_id), deleted: gone });
    })
  );

  server.registerTool(
    "update_client_settings",
    {
      title: "Update client settings",
      description:
        "Per-client settings: language, default currency, tax ID, tax exemption, marketing emails, invoice delivery method, " +
        "auto-debit, and which contact invoices are addressed to. Written with Clients.setSettings, the way staff edits them " +
        "in the admin UI; values are checked against the install (languages, currencies, delivery methods, the client's contacts) " +
        "before anything is sent." + writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive(),
        language: z.string().min(2).max(10).optional().describe("Language code such as en_us"),
        default_currency: z.string().length(3).optional(),
        tax_id: z.string().max(64).optional().describe("Tax/VAT ID; empty string clears it"),
        tax_exempt: z.boolean().optional(),
        receive_email_marketing: z.boolean().optional(),
        inv_method: z.string().max(32).optional().describe("Invoice delivery method, e.g. email or paper"),
        autodebit: z.boolean().optional(),
        inv_address_to: z.number().int().positive().optional().describe("Contact ID invoices are addressed to"),
      }),
      annotations: WRITE,
    },
    guard(async ({ client_id, ...s }) => {
      const client = await getClient(api, client_id);
      if (!client) return fail(`Client ${client_id} not found.`);
      const vars: Record<string, string> = {};
      const bool = (b: boolean) => (b ? "true" : "false");

      if (s.language !== undefined) {
        const company_id = await resolveCompanyId(api);
        const langs = await api.get<Array<{ code: string }> | false>("languages", "getAll", { company_id });
        const codes = (Array.isArray(langs) ? langs : []).map((l) => l.code);
        if (!codes.includes(s.language)) return fail(`Language "${s.language}" is not installed. Available: ${codes.join(", ") || "(none reported)"}.`);
        vars.language = s.language;
      }
      if (s.default_currency !== undefined) {
        const company_id = await resolveCompanyId(api);
        const code = s.default_currency.toUpperCase();
        const cur = await api.get<Array<{ code: string }> | false>("currencies", "getAll", { company_id });
        const codes = (Array.isArray(cur) ? cur : []).map((c) => c.code);
        if (!codes.includes(code)) return fail(`Currency "${code}" is not configured. Available: ${codes.join(", ") || "(none reported)"}.`);
        vars.default_currency = code;
      }
      if (s.inv_method !== undefined) {
        const methods = await api.get<Record<string, string> | false>("invoices", "getDeliveryMethods", { client_id });
        const keys = methods && typeof methods === "object" ? Object.keys(methods) : [];
        if (!keys.includes(s.inv_method)) return fail(`Invoice method "${s.inv_method}" is not available. Available: ${keys.join(", ") || "(none reported)"}.`);
        vars.inv_method = s.inv_method;
      }
      if (s.inv_address_to !== undefined) {
        const contact = await getContact(api, s.inv_address_to);
        if (!contact || Number(contact.client_id) !== client_id) return fail(`Contact ${s.inv_address_to} is not a contact of client ${client_id}.`);
        vars.inv_address_to = String(s.inv_address_to);
      }
      if (s.tax_id !== undefined) vars.tax_id = s.tax_id;
      if (s.tax_exempt !== undefined) vars.tax_exempt = bool(s.tax_exempt);
      if (s.receive_email_marketing !== undefined) vars.receive_email_marketing = bool(s.receive_email_marketing);
      if (s.autodebit !== undefined) vars.autodebit = bool(s.autodebit);

      const keys = Object.keys(vars);
      if (!keys.length) return fail("Nothing to update: pass at least one setting.");
      const before = Object.fromEntries(keys.map((k) => [k, settingOf(client, k) ?? null]));
      await api.put("clients", "setSettings", { client_id, vars, value_keys: keys });
      const after = await getClient(api, client_id);
      return ok({
        client_id,
        updated: Object.fromEntries(keys.map((k) => [k, { from: before[k], to: after ? (settingOf(after, k) ?? null) : vars[k] }])),
      });
    })
  );
}
