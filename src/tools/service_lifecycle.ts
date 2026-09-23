import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";
import { READ, WRITE, DESTRUCTIVE, resolveStaffId, writeNote } from "../common.js";
import { compactService } from "./services.js";

/**
 * Service lifecycle: create, inspect, change package (upgrade/downgrade), edit, uncancel, move,
 * invoice, delete, module fields and queued service changes.
 *
 * Facts from app/models/services.php that shape these tools:
 *  - Services.edit performs at most ONE module action per call (package change OR field edit).
 *  - Changing pricing_id requires resending every configurable option (configoptions[option_id] = value|qty).
 *  - Services.add defaults status to "pending" and then forces use_module=false; only status=active with
 *    use_module=true provisions on the module.
 *  - Services.delete accepts only pending / in_review / canceled services whose children are all canceled.
 *  - Proration is not in the model: the admin UI computes it with ServiceChanges.getPresenter, which does not
 *    serialize over the API. These tools apply changes immediately and report old/new pricing instead.
 *  - Services.validate / validateServiceEdit run the same rules without writing, giving a real dry run.
 */

const USE_MODULE = (b: boolean) => (b ? "true" : "false");

interface Pricing {
  id: number | string;
  term?: number | string;
  period?: string;
  price?: string;
  price_renews?: string | null;
  setup_fee?: string;
  cancel_fee?: string;
  currency?: string;
}

interface PackageRecord {
  id: number | string;
  name?: string;
  status?: string;
  module_id?: number | string;
  pricing?: Pricing[];
}

interface ServiceRecord {
  id: number;
  client_id: number | string;
  status: string;
  pricing_id: number | string;
  qty?: number | string;
  package_group_id?: number | string | null;
  parent_service_id?: number | string | null;
  package?: PackageRecord;
  package_pricing?: Pricing;
  fields?: Array<{ key: string; value?: unknown; encrypted?: string | number }>;
  options?: Array<{ option_id: number | string; value?: string | null; qty?: number | string }>;
  [key: string]: unknown;
}

function compactPricing(p: Pricing) {
  return {
    pricing_id: p.id,
    term: p.term,
    period: p.period,
    price: p.price,
    price_renews: p.price_renews ?? null,
    setup_fee: p.setup_fee,
    currency: p.currency,
  };
}

async function fetchService(api: BlestaClient, service_id: number): Promise<ServiceRecord | null> {
  const svc = await api.get<ServiceRecord | false>("services", "get", { service_id });
  return svc && typeof svc === "object" ? svc : null;
}

/** Mirrors PackageOptions::formatServiceOptions: {option_id: value ?? qty}. */
function currentConfigOptions(svc: ServiceRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of svc.options ?? []) {
    out[String(o.option_id)] = o.value !== null && o.value !== undefined ? o.value : o.qty;
  }
  return out;
}

/**
 * Resolves a pricing ID to its package. Uses Services.getPackagePricing + Packages.get rather than
 * Packages.getByPricingId, which fails on IonCube-encoded installs ("Failed to retrieve the default value").
 */
async function pricingById(api: BlestaClient, pricing_id: number): Promise<{ pkg: PackageRecord; pricing: Pricing } | null> {
  const row = await api.get<(Pricing & { package_id?: number | string }) | false>("services", "getPackagePricing", { pricing_id });
  if (!row || typeof row !== "object" || row.package_id === undefined) return null;
  const pkg = await api.get<PackageRecord | false>("packages", "get", { package_id: row.package_id });
  if (!pkg || typeof pkg !== "object") return null;
  const pricing = (pkg.pricing ?? []).find((p) => Number(p.id) === pricing_id) ?? row;
  return { pkg, pricing };
}

/**
 * Plaintext module fields currently stored on the service, keyed for re-submission. Modules validate
 * their required fields (e.g. `domain`) on every edit that is not bypassed, so they must travel with
 * the request. Encrypted fields (passwords) cannot be read back and are left out.
 */
function currentModuleFields(svc: ServiceRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of svc.fields ?? []) {
    if (f && f.key && !Number(f.encrypted) && f.value !== undefined && f.value !== null) out[f.key] = f.value;
  }
  return out;
}

async function couponIdByCode(api: BlestaClient, code: string): Promise<number | null> {
  const c = await api.get<{ id: number } | false>("coupons", "getByCode", { code });
  return c && typeof c === "object" ? Number(c.id) : null;
}

/** Runs Services.validate / validateServiceEdit; Blesta answers HTTP 400 with field errors when invalid. */
function dryRunResult(what: string, vars: Record<string, unknown>) {
  return ok({ dry_run: true, valid: true, would_call: what, vars });
}

export function registerServiceLifecycleTools(server: McpServer, api: BlestaClient): void {
  // ---------------------------------------------------------------- reads
  server.registerTool(
    "get_service",
    {
      title: "Get service",
      description:
        "Everything about one service: record, package and pricing, configurable options, pricing info (price, setup fee, " +
        "cancel fee, tax), next expected invoice date, child services, allowed actions and queued (pending) service changes. " +
        "Wraps Services.get, getOptions, getPricingInfo, getNextInvoiceDate, getAllChildren, getActions and ServiceChanges.getAll. " +
        "Module fields are included with encrypted values hidden; set `full` for the raw Services.get record.",
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        full: z.boolean().default(false).describe("Return the raw service record instead of the compact view"),
      }),
      annotations: READ,
    },
    guard(async ({ service_id, full }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      const [options, pricing_info, next_invoice_date, children, actions, pending_changes] = await Promise.all([
        api.get<unknown[]>("services", "getOptions", { service_id }),
        api.get<Record<string, unknown> | false>("services", "getPricingInfo", { service_id }),
        api.get<string | null>("services", "getNextInvoiceDate", { service_id, format: "Y-m-d H:i:s" }),
        api.get<ServiceRecord[]>("services", "getAllChildren", { parent_service_id: service_id, status: "all" }),
        api.get<Record<string, string>>("services", "getActions", { current_status: svc.status }),
        api.get<unknown[]>("service_changes", "getAll", { status: "pending", service_id }),
      ]);
      return ok({
        service: full ? svc : compactService(svc),
        pricing_info: isMissing(pricing_info) ? null : pricing_info,
        next_invoice_date: next_invoice_date ?? null,
        options: Array.isArray(options) ? options : [],
        children: (Array.isArray(children) ? children : []).map(compactService),
        available_actions: actions ?? {},
        pending_changes: Array.isArray(pending_changes) ? pending_changes : [],
      });
    })
  );

  server.registerTool(
    "list_compatible_packages",
    {
      title: "List compatible packages",
      description:
        "Packages (with their pricing terms) a service can be upgraded or downgraded to: same module, same package group. " +
        "Wraps Packages.getCompatiblePackages(package_id, module_id, type). The service's current pricing is marked. " +
        "Pick a `pricing_id` from the result for change_service_package.",
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        type: z.enum(["standard", "addon"]).default("standard").describe("Package group type to search"),
        currency: z.string().length(3).optional().describe("Only list pricing in this currency"),
        status: z.enum(["active", "inactive", "restricted", "all"]).default("active").describe("Package status filter"),
        name: z.string().max(200).optional().describe("Only packages whose name contains this text (case-insensitive)"),
        limit: z.number().int().min(1).max(200).default(40).describe("Packages per page; large groups exceed the output cap otherwise"),
        offset: z.number().int().min(0).default(0).describe("Skip this many matching packages (use next_offset to page)"),
      }),
      annotations: READ,
    },
    guard(async ({ service_id, type, currency, status, name, limit, offset }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      if (!svc.package?.id || svc.package.module_id === undefined) {
        return fail(`Service ${service_id} has no package/module information.`);
      }
      const list = await api.get<PackageRecord[]>("packages", "getCompatiblePackages", {
        package_id: svc.package.id,
        module_id: svc.package.module_id,
        type,
      });
      const cur = String(svc.pricing_id);
      const packages = (Array.isArray(list) ? list : [])
        .filter((p) => status === "all" || p.status === status)
        .map((p) => ({
          package_id: p.id,
          name: p.name,
          status: p.status,
          is_current_package: String(p.id) === String(svc.package?.id),
          pricing: (p.pricing ?? [])
            .filter((pr) => !currency || (pr.currency ?? "").toUpperCase() === currency.toUpperCase())
            .map((pr) => ({ ...compactPricing(pr), is_current: String(pr.id) === cur })),
        }))
        .filter((p) => p.pricing.length > 0)
        .filter((p) => !name || String(p.name ?? "").toLowerCase().includes(name.toLowerCase()));
      // Groups can hold well over a hundred packages; page so the result stays parseable JSON under the output cap.
      const page = packages.slice(offset, offset + limit);
      const nextOffset = offset + limit < packages.length ? offset + limit : null;
      return ok({
        service_id,
        current_pricing_id: svc.pricing_id,
        total: packages.length,
        count: page.length,
        offset,
        next_offset: nextOffset,
        packages: page,
      });
    })
  );

  // ---------------------------------------------------------------- create / delete
  server.registerTool(
    "create_service",
    {
      title: "Create service",
      description:
        "Add a service for a client from a package pricing (Services.add). Default `status` is pending and NOTHING is provisioned; " +
        "pass `status: \"active\"` with `provision: true` to have the module create the account. Optional coupon, configurable " +
        "options, module fields (e.g. domain, username), price override and an invoice for the new service " +
        "(Invoices.createFromServices). Set `dry_run` to validate with Services.validate without creating anything." +
        writeNote(api),
      inputSchema: z.object({
        client_id: z.number().int().positive(),
        pricing_id: z.number().int().positive().describe("Package pricing ID (see list_packages with include_pricing)"),
        qty: z.number().int().positive().default(1),
        status: z.enum(["pending", "active", "in_review", "suspended", "canceled"]).default("pending"),
        provision: z
          .boolean()
          .default(false)
          .describe("use_module=true: let the module create the account. Only effective with status active"),
        configoptions: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe("Configurable options: {package_option_id: value_or_qty}"),
        module_fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Module-specific service fields, e.g. {\"cpanel_domain\": \"example.com\"}"),
        coupon_code: z.string().optional(),
        module_row_id: z.number().int().positive().optional().describe("Server/module row; default chosen by the module"),
        parent_service_id: z.number().int().positive().optional().describe("Make this an add-on of that service"),
        package_group_id: z.number().int().positive().optional(),
        override_price: z.number().nonnegative().optional(),
        override_currency: z.string().length(3).optional(),
        date_renews: z.string().optional().describe("ISO 8601; default computed from the term"),
        staff_id: z.number().int().positive().optional().describe("Default BLESTA_STAFF_ID"),
        notify: z.boolean().default(false).describe("Email the client the service creation notice"),
        invoice: z
          .object({
            due_date: z.string().optional().describe("ISO 8601; default now"),
            allow_pro_rata: z.boolean().default(true),
            term_cycles: z.number().int().positive().default(1),
          })
          .optional()
          .describe("Also create an invoice for the new service"),
        dry_run: z.boolean().default(false),
      }),
      annotations: WRITE,
    },
    guard(async (a) => {
      const priced = await pricingById(api, a.pricing_id);
      if (!priced) return fail(`Pricing ${a.pricing_id} not found on any package.`);
      const vars: Record<string, unknown> = {
        client_id: a.client_id,
        pricing_id: a.pricing_id,
        qty: a.qty,
        status: a.status,
        use_module: USE_MODULE(a.provision && a.status === "active"),
      };
      const staff_id = resolveStaffId(a.staff_id);
      if (staff_id) vars.staff_id = staff_id;
      if (a.configoptions && Object.keys(a.configoptions).length) vars.configoptions = a.configoptions;
      if (a.module_row_id) vars.module_row_id = a.module_row_id;
      if (a.parent_service_id) vars.parent_service_id = a.parent_service_id;
      if (a.package_group_id) vars.package_group_id = a.package_group_id;
      if (a.override_price !== undefined) vars.override_price = a.override_price.toFixed(4);
      if (a.override_currency) vars.override_currency = a.override_currency.toUpperCase();
      if (a.date_renews) vars.date_renews = a.date_renews;
      let packages: number[] | undefined;
      if (a.coupon_code) {
        const coupon_id = await couponIdByCode(api, a.coupon_code);
        if (!coupon_id) return fail(`Coupon "${a.coupon_code}" not found.`);
        vars.coupon_id = coupon_id;
        packages = [Number(priced.pkg.id)];
      }
      if (a.module_fields) Object.assign(vars, a.module_fields);

      if (a.dry_run) {
        await api.get("services", "validate", packages ? { vars, packages } : { vars });
        return dryRunResult("services/add", vars);
      }

      const service_id = await api.post<number>("services", "add", {
        vars,
        ...(packages ? { packages } : {}),
        notify: a.notify,
      });
      let invoice: unknown = null;
      let invoice_error: string | undefined;
      if (a.invoice) {
        try {
          const invoice_id = await api.post<number>("invoices", "createFromServices", {
            client_id: a.client_id,
            service_ids: [service_id],
            currency: a.override_currency?.toUpperCase() ?? priced.pricing.currency,
            due_date: a.invoice.due_date ?? new Date().toISOString(),
            allow_pro_rata: a.invoice.allow_pro_rata,
            services_renew: false,
            service_transfers: [],
            term_cycles: a.invoice.term_cycles,
          });
          invoice = await api.get("invoices", "get", { invoice_id });
        } catch (e) {
          invoice_error = e instanceof Error ? e.message : String(e);
        }
      }
      const svc = await fetchService(api, service_id);
      return ok({
        service_id,
        provisioned: vars.use_module === "true",
        service: svc ? compactService(svc) : null,
        invoice,
        ...(invoice_error ? { invoice_error, note: "Service was created but the invoice was not." } : {}),
      });
    })
  );

  server.registerTool(
    "delete_service",
    {
      title: "Delete service",
      description:
        "Permanently delete a service record (Services.delete). Blesta only allows this for pending, in_review or canceled " +
        "services whose child services are all canceled; the module is not contacted. To end an active service use cancel_service." +
        writeNote(api),
      inputSchema: z.object({ service_id: z.number().int().positive() }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ service_id }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      if (!["pending", "in_review", "canceled"].includes(svc.status)) {
        return fail(`Service ${service_id} is ${svc.status}; only pending, in_review or canceled services can be deleted. Cancel it first.`);
      }
      const children = await api.get<ServiceRecord[]>("services", "getAllChildren", { parent_service_id: service_id, status: "all" });
      const live = (Array.isArray(children) ? children : []).filter((c) => c.status !== "canceled");
      if (live.length) {
        return fail(`Service ${service_id} has ${live.length} non-canceled child service(s): ${live.map((c) => c.id).join(", ")}.`);
      }
      await api.delete("services", "delete", { service_id, validate: true });
      const after = await fetchService(api, service_id);
      return ok({ service_id, deleted: after === null, previous_status: svc.status });
    })
  );

  // ---------------------------------------------------------------- change / edit
  server.registerTool(
    "change_service_package",
    {
      title: "Change service package (upgrade/downgrade)",
      description:
        "Move a service to another package pricing (upgrade, downgrade or term change) via Services.edit with a new `pricing_id`. " +
        "By default the module is told to change the package (use_module). Current configurable options are resent " +
        "automatically; pass `configoptions` to change some. The change applies immediately and is NOT prorated or invoiced: " +
        "Blesta computes proration only in the admin UI. The result shows old and new pricing so you can create an invoice " +
        "or credit with create_invoice / record_manual_payment if needed. `dry_run` validates with Services.validateServiceEdit." +
        writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        pricing_id: z.number().int().positive().describe("Target pricing ID from list_compatible_packages"),
        qty: z.number().int().positive().optional().describe("Default: current quantity"),
        configoptions: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe("Option overrides {package_option_id: value_or_qty}, merged over the current options"),
        module_fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Module fields the module requires for the change (stored plaintext fields are resent automatically)"),
        use_module: z.boolean().default(true).describe("false = change only Blesta's record, do not touch the module"),
        dry_run: z.boolean().default(false),
      }),
      annotations: WRITE,
    },
    guard(async ({ service_id, pricing_id, qty, configoptions, module_fields, use_module, dry_run }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      if (Number(svc.pricing_id) === pricing_id) return fail(`Service ${service_id} already uses pricing ${pricing_id}.`);
      const target = await pricingById(api, pricing_id);
      if (!target) return fail(`Pricing ${pricing_id} not found on any package.`);
      const options = { ...currentConfigOptions(svc), ...(configoptions ?? {}) };
      const vars: Record<string, unknown> = {
        ...(use_module ? currentModuleFields(svc) : {}),
        ...(module_fields ?? {}),
        pricing_id,
        qty: qty ?? Number(svc.qty ?? 1),
        use_module: USE_MODULE(use_module),
      };
      if (Object.keys(options).length) vars.configoptions = options;

      const change = {
        from: { package: svc.package?.name, package_id: svc.package?.id, ...(svc.package_pricing ? compactPricing(svc.package_pricing) : { pricing_id: svc.pricing_id }) },
        to: { package: target.pkg.name, package_id: target.pkg.id, ...compactPricing(target.pricing) },
      };
      if (dry_run) {
        await api.get("services", "validateServiceEdit", { service_id, vars, bypass_module: !use_module });
        return ok({ dry_run: true, valid: true, would_call: "services/edit", vars, change });
      }
      await api.put("services", "edit", { service_id, vars, bypass_module: !use_module, notify: false });
      const after = await fetchService(api, service_id);
      return ok({
        service_id,
        change,
        service: after ? compactService(after) : null,
        note: "Package changed immediately without proration. Create an invoice or credit separately if the price difference should be billed.",
      });
    })
  );

  server.registerTool(
    "update_service",
    {
      title: "Update service",
      description:
        "Edit service fields via Services.edit: status (activate a pending service with `provision: true` to create it on the module), " +
        "renew date, quantity, price override, coupon, module row, or module-specific fields. Package/pricing changes belong to " +
        "change_service_package (Blesta allows one module action per edit). Without `provision` the module is bypassed and " +
        "only Blesta's record changes. `dry_run` validates only." +
        writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        status: z.enum(["active", "pending", "in_review", "suspended", "canceled"]).optional(),
        provision: z
          .boolean()
          .default(false)
          .describe("use_module=true: apply the change on the module too (required to provision when activating)"),
        date_renews: z.string().optional().describe("ISO 8601"),
        date_last_renewed: z.string().optional(),
        date_paid_through: z.string().nullable().optional(),
        qty: z.number().int().positive().optional(),
        override_price: z.number().nonnegative().optional().describe("Set together with override_currency (clearing an override is not possible over the API)"),
        override_currency: z.string().length(3).optional(),
        coupon_code: z.string().min(1).optional().describe("Coupon code to attach (removing a coupon is not possible over the API)"),
        module_row_id: z.number().int().positive().optional(),
        module_fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Module-specific fields to pass to the module (with provision: true)"),
        notify: z.boolean().default(false).describe("Send the activation email when status becomes active"),
        dry_run: z.boolean().default(false),
      }),
      annotations: WRITE,
    },
    guard(async (a) => {
      const svc = await fetchService(api, a.service_id);
      if (!svc) return fail(`Service ${a.service_id} not found.`);
      const vars: Record<string, unknown> = {
        ...(a.provision ? currentModuleFields(svc) : {}),
        use_module: USE_MODULE(a.provision),
      };
      const baseKeys = Object.keys(vars).length;
      if (a.status) vars.status = a.status;
      if (a.date_renews) vars.date_renews = a.date_renews;
      if (a.date_last_renewed) vars.date_last_renewed = a.date_last_renewed;
      if (a.date_paid_through !== undefined) vars.date_paid_through = a.date_paid_through;
      if (a.qty !== undefined) vars.qty = a.qty;
      if ((a.override_price === undefined) !== (a.override_currency === undefined)) {
        return fail("override_price and override_currency must be given together.");
      }
      if (a.override_price !== undefined) vars.override_price = a.override_price.toFixed(4);
      if (a.override_currency !== undefined) vars.override_currency = a.override_currency.toUpperCase();
      if (a.coupon_code !== undefined) {
        const coupon_id = await couponIdByCode(api, a.coupon_code);
        if (!coupon_id) return fail(`Coupon "${a.coupon_code}" not found.`);
        vars.coupon_id = coupon_id;
      }
      if (a.module_row_id) vars.module_row_id = a.module_row_id;
      if (a.module_fields) Object.assign(vars, a.module_fields);
      if (Object.keys(vars).length === baseKeys) return fail("Nothing to update: pass at least one field.");

      if (a.dry_run) {
        await api.get("services", "validateServiceEdit", { service_id: a.service_id, vars, bypass_module: !a.provision });
        return dryRunResult("services/edit", vars);
      }
      await api.put("services", "edit", { service_id: a.service_id, vars, bypass_module: !a.provision, notify: a.notify });
      const after = await fetchService(api, a.service_id);
      const updated = Object.keys(vars).filter((k) => k !== "use_module" && !(k in currentModuleFields(svc) && !(a.module_fields && k in a.module_fields)));
      return ok({ service_id: a.service_id, updated, service: after ? compactService(after) : null });
    })
  );

  server.registerTool(
    "uncancel_service",
    {
      title: "Uncancel service",
      description:
        "Reactivate a canceled or scheduled-for-cancellation service (Services.unCancel). With `use_module` the module is asked to " +
        "recreate/unsuspend the account." + writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        use_module: z.boolean().default(true),
      }),
      annotations: WRITE,
    },
    guard(async ({ service_id, use_module }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      await api.put("services", "unCancel", { service_id, vars: { use_module: USE_MODULE(use_module) } });
      const after = await fetchService(api, service_id);
      return ok({ service_id, previous_status: svc.status, service: after ? compactService(after) : null });
    })
  );

  server.registerTool(
    "move_service",
    {
      title: "Move service to another client",
      description: "Transfer a service to a different client account (Services.move). Child services move with it." + writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        client_id: z.number().int().positive().describe("Destination client"),
      }),
      annotations: WRITE,
    },
    guard(async ({ service_id, client_id }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      if (Number(svc.client_id) === client_id) return fail(`Service ${service_id} already belongs to client ${client_id}.`);
      const client = await api.get<{ id: number } | false>("clients", "get", { client_id });
      if (isMissing(client)) return fail(`Client ${client_id} not found.`);
      await api.put("services", "move", { service_id, client_id });
      const after = await fetchService(api, service_id);
      return ok({ service_id, from_client_id: svc.client_id, to_client_id: client_id, service: after ? compactService(after) : null });
    })
  );

  server.registerTool(
    "invoice_service",
    {
      title: "Invoice services",
      description:
        "Create an invoice for one or more services of the same client (Invoices.createFromServices): the initial invoice for a " +
        "new service, or a renewal invoice (`renewal: true`) for `term_cycles` terms. Pro-rata pricing follows the package settings " +
        "unless `allow_pro_rata` is false. Returns the new invoice." + writeNote(api),
      inputSchema: z.object({
        service_ids: z.array(z.number().int().positive()).min(1).max(50),
        renewal: z.boolean().default(false).describe("true = renewal invoice, false = first invoice for new services"),
        due_date: z.string().optional().describe("ISO 8601; default now"),
        currency: z.string().length(3).optional().describe("Default: the first service's pricing currency"),
        allow_pro_rata: z.boolean().default(true),
        term_cycles: z.number().int().positive().default(1),
      }),
      annotations: WRITE,
    },
    guard(async ({ service_ids, renewal, due_date, currency, allow_pro_rata, term_cycles }) => {
      const ids = [...new Set(service_ids)];
      const services: ServiceRecord[] = [];
      for (const id of ids) {
        const svc = await fetchService(api, id);
        if (!svc) return fail(`Service ${id} not found.`);
        services.push(svc);
      }
      const clients = new Set(services.map((s) => String(s.client_id)));
      if (clients.size > 1) return fail(`Services belong to different clients (${[...clients].join(", ")}); invoice them separately.`);
      const client_id = Number(services[0].client_id);
      const cur = currency?.toUpperCase() ?? services[0].package_pricing?.currency;
      if (!cur) return fail("Could not determine the currency; pass `currency`.");
      const invoice_id = await api.post<number>("invoices", "createFromServices", {
        client_id,
        service_ids: ids,
        currency: cur,
        due_date: due_date ?? new Date().toISOString(),
        allow_pro_rata,
        services_renew: renewal,
        service_transfers: [],
        term_cycles,
      });
      const invoice = await api.get("invoices", "get", { invoice_id });
      return ok({ invoice_id, client_id, service_ids: ids, renewal, invoice });
    })
  );

  server.registerTool(
    "set_service_field",
    {
      title: "Set service field",
      description:
        "Set one module field stored on the service (e.g. cpanel_username) in Blesta's database: Services.editField when the key " +
        "exists, Services.addField otherwise. This does NOT contact the module; use update_service with module_fields and " +
        "provision: true to change the account itself." + writeNote(api),
      inputSchema: z.object({
        service_id: z.number().int().positive(),
        key: z.string().min(1).max(255),
        value: z.union([z.string(), z.number(), z.boolean()]),
        encrypted: z.boolean().default(false).describe("Store the value encrypted (passwords)"),
      }),
      annotations: WRITE,
    },
    guard(async ({ service_id, key, value, encrypted }) => {
      const svc = await fetchService(api, service_id);
      if (!svc) return fail(`Service ${service_id} not found.`);
      const exists = (svc.fields ?? []).some((f) => f.key === key);
      const vars = { key, value: String(value), encrypted: USE_MODULE(encrypted) };
      if (exists) await api.put("services", "editField", { service_id, vars });
      else await api.post("services", "addField", { service_id, vars });
      return ok({ service_id, key, action: exists ? "edited" : "added", encrypted });
    })
  );

  server.registerTool(
    "manage_service_change",
    {
      title: "Process or cancel a queued service change",
      description:
        "Queued service changes (upgrades waiting for payment, listed by get_service as pending_changes): `process` applies " +
        "the change now (ServiceChanges.process), `cancel` removes it (ServiceChanges.cancel), optionally voiding its invoice." +
        writeNote(api),
      inputSchema: z.object({
        service_change_id: z.number().int().positive(),
        action: z.enum(["process", "cancel"]),
        void_invoice: z.boolean().default(false).describe("With cancel: also void the invoice created for the change"),
      }),
      annotations: DESTRUCTIVE,
    },
    guard(async ({ service_change_id, action, void_invoice }) => {
      const change = await api.get<Record<string, unknown> | false>("service_changes", "get", { service_change_id });
      if (isMissing(change)) return fail(`Service change ${service_change_id} not found.`);
      if (action === "process") await api.put("service_changes", "process", { service_change_id });
      else await api.delete("service_changes", "cancel", { service_change_id, void_invoice });
      const after = await api.get<Record<string, unknown> | false>("service_changes", "get", { service_change_id });
      return ok({ service_change_id, action, before: change, after: isMissing(after) ? null : after });
    })
  );
}
