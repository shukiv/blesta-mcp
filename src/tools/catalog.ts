import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, isMissing } from "../format.js";
import { READ, resolveCompanyId } from "../common.js";

const PACKAGE_KEEP = ["id", "id_code", "name", "status", "module_id", "qty", "single_term", "taxable", "hidden", "pricing", "groups"];

function compactPackage(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PACKAGE_KEEP) if (k in p) out[k] = p[k];
  if (Array.isArray(p.pricing)) {
    out.pricing = (p.pricing as Array<Record<string, unknown>>).map((pr) => ({
      pricing_id: pr.pricing_id ?? pr.id,
      term: pr.term,
      period: pr.period,
      price: pr.price,
      price_renews: pr.price_renews,
      setup_fee: pr.setup_fee,
      currency: pr.currency,
    }));
  }
  if (Array.isArray(p.groups)) out.groups = (p.groups as Array<Record<string, unknown>>).map((g) => ({ id: g.id, name: g.name }));
  return out;
}

export function registerCatalogTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "list_packages",
    {
      title: "List packages",
      description:
        "Product catalog: packages and package groups. Wraps Packages.getAll (compact view) and Packages.getAllGroups. " +
        "Packages.getAll does not return prices; set `include_pricing` (max 25 packages per call, so filter by name or group first) " +
        "to fetch Packages.get for each and attach `pricing` per term/period/currency. Pass `full` for raw objects incl. descriptions.",
      inputSchema: z.object({
        status: z.enum(["active", "inactive", "restricted"]).optional().describe("Default: all statuses"),
        type: z.enum(["standard", "addon"]).optional(),
        name: z.string().optional().describe("Partial package name filter"),
        package_group_id: z.number().int().positive().optional(),
        include_hidden: z.boolean().default(true),
        include_pricing: z.boolean().default(false).describe("Fetch prices for each package (one Packages.get call each; max 25 packages)"),
        company_id: z.number().int().positive().optional().describe("Defaults to BLESTA_COMPANY_ID or the first company"),
        full: z.boolean().default(false).describe("Raw package objects (descriptions, email templates, module meta)"),
      }),
      annotations: READ,
    },
    guard(async ({ status, type, name, package_group_id, include_hidden, include_pricing, company_id, full }) => {
      const cid = await resolveCompanyId(api, company_id);
      const filters: Record<string, unknown> = {};
      if (name) filters.name = name;
      if (package_group_id) filters.package_group_id = package_group_id;
      if (!include_hidden) filters.hidden = 0;
      const [pkgs, groups] = await Promise.all([
        api.get<Array<Record<string, unknown>> | false>("packages", "getAll", { company_id: cid, order: { name: "ASC" }, status, type, filters }),
        api.get<Array<Record<string, unknown>> | false>("packages", "getAllGroups", { company_id: cid }),
      ]);
      let list = Array.isArray(pkgs) ? pkgs : [];
      if (include_pricing) {
        if (list.length > 25) return fail(`include_pricing allowed for at most 25 packages; this query matched ${list.length}. Narrow with name, package_group_id, type or status.`);
        list = await Promise.all(
          list.map(async (p) => {
            const fullPkg = await api.get<Record<string, unknown> | false>("packages", "get", { package_id: Number(p.id) });
            return isMissing(fullPkg) ? p : { ...p, pricing: (fullPkg as Record<string, unknown>).pricing };
          })
        );
      }
      return ok({
        company_id: cid,
        total: list.length,
        groups: Array.isArray(groups) ? groups.map((g) => ({ id: g.id, name: g.name, type: g.type })) : [],
        packages: full ? list : list.map(compactPackage),
      });
    })
  );

  server.registerTool(
    "get_package",
    {
      title: "Get package",
      description: "One package in full: pricing per term, description, module, configurable option groups, groups. Wraps Packages.get.",
      inputSchema: z.object({ package_id: z.number().int().positive() }),
      annotations: READ,
    },
    guard(async ({ package_id }) => {
      const pkg = await api.get("packages", "get", { package_id });
      if (isMissing(pkg)) return fail(`No package found with id ${package_id}.`);
      return ok(pkg);
    })
  );

  server.registerTool(
    "list_quotations",
    {
      title: "List quotations",
      description:
        "Quotes (estimates) for a client or across all clients, by status. Wraps Quotations.getList / getListCount. " +
        "Statuses: draft, pending, approved, invoiced, expired, dead, lost, all.",
      inputSchema: z.object({
        client_id: z.number().int().positive().optional(),
        status: z.enum(["draft", "pending", "approved", "invoiced", "expired", "dead", "lost", "all"]).default("pending"),
        page: z.number().int().min(1).default(1),
      }),
      annotations: READ,
    },
    guard(async ({ client_id, status, page }) => {
      const [results, total] = await Promise.all([
        api.get("quotations", "getList", { client_id, status, page, order_by: { date_expires: "ASC" } }),
        api.get<number>("quotations", "getListCount", { client_id, status }),
      ]);
      return ok({ client_id, status, page, total_matches: total, results: results || [] });
    })
  );

  server.registerTool(
    "get_quotation",
    {
      title: "Get quotation",
      description: "One quote with its line items and any invoices generated from it. Wraps Quotations.get, getLineItems, getInvoices.",
      inputSchema: z.object({ quotation_id: z.number().int().positive() }),
      annotations: READ,
    },
    guard(async ({ quotation_id }) => {
      const quote = await api.get<Record<string, unknown> | false>("quotations", "get", { quotation_id });
      if (isMissing(quote)) return fail(`No quotation found with id ${quotation_id}.`);
      const [lines, invoices] = await Promise.all([
        api.get("quotations", "getLineItems", { quotation_id }),
        api.get("quotations", "getInvoices", { quotation_id }),
      ]);
      return ok({ ...(quote as Record<string, unknown>), line_items: lines || [], invoices: invoices || [] });
    })
  );

  server.registerTool(
    "lookup_coupon",
    {
      title: "Lookup coupon",
      description:
        "Validate a promo code: existence, status, start/end dates, usage limits, discount amounts per currency, eligible packages. " +
        "Wraps Coupons.getByCode; with `package_ids`, also Coupons.getForPackages to check applicability.",
      inputSchema: z.object({
        code: z.string().min(1),
        package_ids: z.array(z.number().int().positive()).optional().describe("Check the coupon applies to these packages"),
      }),
      annotations: READ,
    },
    guard(async ({ code, package_ids }) => {
      const coupon = await api.get<Record<string, unknown> | false>("coupons", "getByCode", { code });
      if (isMissing(coupon)) return ok({ code, found: false });
      const c = coupon as Record<string, unknown>;
      const now = Date.now();
      const start = c.start_date ? Date.parse(String(c.start_date).replace(" ", "T") + "Z") : NaN;
      const end = c.end_date ? Date.parse(String(c.end_date).replace(" ", "T") + "Z") : NaN;
      const maxQty = Number(c.max_qty ?? 0);
      const usedQty = Number(c.used_qty ?? 0);
      const checks = {
        status_active: c.status === "active",
        within_dates: (Number.isNaN(start) || start <= now) && (Number.isNaN(end) || end >= now),
        usage_available: maxQty === 0 || usedQty < maxQty,
      };
      let applies_to_packages: unknown;
      if (package_ids?.length) {
        const r = await api.get("coupons", "getForPackages", { code, packages: package_ids });
        applies_to_packages = !isMissing(r);
      }
      return ok({
        code,
        found: true,
        usable_now: Object.values(checks).every(Boolean) && (applies_to_packages ?? true),
        checks,
        ...(applies_to_packages !== undefined ? { applies_to_packages } : {}),
        coupon: c,
      });
    })
  );
}
