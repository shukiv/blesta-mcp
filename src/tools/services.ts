import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";
import { READ, WRITE, DESTRUCTIVE, resolveStaffId, writeNote } from "../common.js";

export const SERVICE_STATUSES = [
  "active",
  "canceled",
  "pending",
  "suspended",
  "in_review",
  "scheduled_cancellation",
  "all",
] as const;

interface ServiceRecord {
  id?: number;
  [key: string]: unknown;
}

const SERVICE_KEEP = [
  "id", "id_code", "parent_service_id", "client_id", "status", "name", "qty", "pricing_id", "package_group_id",
  "override_price", "override_currency", "coupon_id", "date_added", "date_renews", "date_last_renewed",
  "date_suspended", "date_canceled", "suspension_reason", "cancellation_reason", "renewal_price",
] as const;
const PACKAGE_KEEP = ["id", "id_code", "name", "module_id", "status", "single_term", "taxable"] as const;
const OPTION_KEEP = ["id", "option_id", "option_name", "option_value_name", "value", "qty", "price", "setup_fee"] as const;

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Trims a Blesta service object to what a support agent needs (drops package descriptions, email templates, meta). */
export function compactService(svc: ServiceRecord): Record<string, unknown> {
  const out = pick(svc, SERVICE_KEEP);
  const pkg = svc.package;
  if (pkg && typeof pkg === "object") out.package = pick(pkg as Record<string, unknown>, PACKAGE_KEEP);
  if (svc.package_pricing && typeof svc.package_pricing === "object") out.package_pricing = svc.package_pricing;
  if (Array.isArray(svc.fields)) {
    out.fields = (svc.fields as Array<Record<string, unknown>>)
      .filter((f) => f && !Number(f.encrypted))
      .map((f) => ({ key: f.key, value: f.value }));
  }
  if (Array.isArray(svc.options)) {
    out.options = (svc.options as Array<Record<string, unknown>>).map((o) => pick(o, OPTION_KEEP));
  }
  return out;
}

export function registerServiceTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "get_client_services",
    {
      title: "Get client services",
      description:
        "List a customer's services (hosting accounts, domains, add-ons) with status, package/pricing, renewal date and price. " +
        "Wraps Services.getList (paged, default status 'active') and, when `include_renewal_price` is set, Services.getRenewalPrice per service. " +
        "Pass `service_id` instead of `client_id` to fetch a single service (Services.get), including module fields such as domain/username. " +
        "Results are compacted by default; set `full` for the raw Blesta objects.",
      inputSchema: z.object({
        client_id: z.number().int().positive().optional().describe("Numeric client ID whose services to list"),
        service_id: z.number().int().positive().optional().describe("Fetch this single service in full instead of listing"),
        status: z
          .enum(SERVICE_STATUSES)
          .default("active")
          .describe("Status filter for listing: active, canceled, pending, suspended, in_review, scheduled_cancellation, all"),
        page: z.number().int().min(1).default(1).describe("Result page, starting at 1"),
        include_children: z.boolean().default(true).describe("Include add-on (child) services in the list"),
        include_renewal_price: z
          .boolean()
          .default(false)
          .describe("Also compute the next renewal price for each listed service (one extra API call per service)"),
        full: z
          .boolean()
          .default(false)
          .describe("Return complete Blesta service objects (package descriptions, email templates, meta). Default is a compact view."),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, service_id, status, page, include_children, include_renewal_price, full }) => {
      const view = (svc: ServiceRecord) => (full ? svc : compactService(svc));
      if (service_id) {
        const service = await api.get<ServiceRecord | false>("services", "get", { service_id });
        if (isMissing(service)) return fail(`No service found with id ${service_id}.`);
        if (!include_renewal_price) return ok(view(service as ServiceRecord));
        const renewal_price = await api.get("services", "getRenewalPrice", { service_id });
        return ok(view({ ...(service as ServiceRecord), renewal_price }));
      }
      if (!client_id) return fail("Provide `client_id` (list services) or `service_id` (single service).");

      const params = {
        client_id,
        status,
        page,
        order_by: { date_added: "DESC" },
        children: include_children,
      };
      const [list, total] = await Promise.all([
        api.get<ServiceRecord[] | false>("services", "getList", params),
        api.get<number>("services", "getListCount", { client_id, status, children: include_children }),
      ]);
      let results: ServiceRecord[] = Array.isArray(list) ? list : [];

      if (include_renewal_price && results.length) {
        results = await Promise.all(
          results.map(async (svc) => {
            if (typeof svc.id !== "number" && typeof svc.id !== "string") return svc;
            try {
              const renewal_price = await api.get("services", "getRenewalPrice", { service_id: Number(svc.id) });
              return { ...svc, renewal_price };
            } catch {
              return { ...svc, renewal_price: null };
            }
          })
        );
      }
      return ok({ client_id, status, page, total_matches: total, results: results.map(view) });
    })
  );

  server.registerTool(
    "search_services",
    {
      title: "Search services",
      description:
        "Find services across all clients by domain, hostname, username, package name or service number. Wraps Services.search " +
        "(with `search_fields` to include module field values such as the domain). Returns compact service records with client_id.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Domain, username, package name or service number"),
        page: z.number().int().min(1).default(1),
        search_fields: z.boolean().default(true).describe("Also match module field values (domain, username, ...)"),
        full: z.boolean().default(false).describe("Raw Blesta service objects"),
      }),
      annotations: READ,
    },
    guard(async ({ query, page, search_fields, full }) => {
      const list = await api.get<ServiceRecord[] | false>("services", "search", { query, page, search_fields });
      const results = Array.isArray(list) ? list : [];
      return ok({ query, page, total: results.length, results: full ? results : results.map(compactService) });
    })
  );

  server.registerTool(
    "get_service_actions",
    {
      title: "Get service actions",
      description:
        "Which operations Blesta allows on a service in its current state (e.g. suspend, unsuspend, cancel, uncancel, change_renew_date, ...). " +
        "Wraps Services.get + Services.getActions(current_status).",
      inputSchema: z.object({ service_id: z.number().int().positive() }),
      annotations: READ,
    },
    guard(async ({ service_id }) => {
      const svc = await api.get<ServiceRecord | false>("services", "get", { service_id });
      if (isMissing(svc)) return fail(`No service found with id ${service_id}.`);
      const status = String((svc as ServiceRecord).status);
      const actions = await api.get("services", "getActions", { current_status: status });
      return ok({ service_id, status, actions });
    })
  );

  const staffParam = z.number().int().positive().optional().describe("Staff member performing the action; defaults to BLESTA_STAFF_ID");

  server.registerTool(
    "suspend_service",
    {
      title: "Suspend service",
      description:
        "Suspend a service (and, when `use_module` is true, tell the provisioning module to suspend the account). Wraps Services.suspend." +
        writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        reason: z.string().optional().describe("Suspension reason shown to staff (and client, depending on template)"),
        use_module: z.boolean().default(true).describe("Also suspend on the server/module, not only in billing"),
        staff_id: staffParam,
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ service_id, reason, use_module, staff_id }) => {
      const vars: Record<string, unknown> = { use_module: use_module ? "true" : "false" };
      const staff = resolveStaffId(staff_id);
      if (staff) vars.staff_id = staff;
      if (reason) vars.suspension_reason = reason;
      await api.put("services", "suspend", { service_id, vars });
      const svc = await api.get<ServiceRecord | false>("services", "get", { service_id });
      return ok(isMissing(svc) ? { service_id, status: "unknown" } : compactService(svc as ServiceRecord));
    })
  );

  server.registerTool(
    "unsuspend_service",
    {
      title: "Unsuspend service",
      description: "Reactivate a suspended service (and on the module when `use_module` is true). Wraps Services.unsuspend." + writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        use_module: z.boolean().default(true),
        staff_id: staffParam,
      }),
      annotations: WRITE,
    },
    guard(async ({ service_id, use_module, staff_id }) => {
      const vars: Record<string, unknown> = { use_module: use_module ? "true" : "false" };
      const staff = resolveStaffId(staff_id);
      if (staff) vars.staff_id = staff;
      await api.put("services", "unsuspend", { service_id, vars });
      const svc = await api.get<ServiceRecord | false>("services", "get", { service_id });
      return ok(isMissing(svc) ? { service_id, status: "unknown" } : compactService(svc as ServiceRecord));
    })
  );

  server.registerTool(
    "cancel_service",
    {
      title: "Cancel service",
      description:
        "Cancel a service now, at end of the current term, or on a given date. Wraps Services.cancel. " +
        "`when`: 'end_of_term' (default, safest), 'now' (immediate, module deprovisions if use_module), or an ISO 8601 date with timezone. " +
        "Scheduled cancellations are executed by Blesta's cron and can be undone before then with blesta_call services/unCancel." +
        writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        when: z.string().default("end_of_term").describe("'end_of_term', 'now', or ISO 8601 date with timezone"),
        reason: z.string().optional().describe("Cancellation reason"),
        use_module: z.boolean().default(true).describe("Deprovision on the module when cancelling immediately"),
        notify_client: z.boolean().default(true).describe("Email the client about the cancellation"),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ service_id, when, reason, use_module, notify_client }) => {
      const date_canceled = when === "now" ? new Date(Date.now() - 60_000).toISOString() : when;
      const vars: Record<string, unknown> = {
        date_canceled,
        use_module: use_module ? "true" : "false",
        notify_cancel: notify_client ? "true" : "false",
        reapply_payments: true,
      };
      if (reason) vars.cancellation_reason = reason;
      await api.put("services", "cancel", { service_id, vars });
      const svc = await api.get<ServiceRecord | false>("services", "get", { service_id });
      return ok({ requested: when, service: isMissing(svc) ? { service_id } : compactService(svc as ServiceRecord) });
    })
  );
}
