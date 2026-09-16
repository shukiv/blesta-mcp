import type { BlestaClient } from "./client.js";

/** Staff ID recorded on notes, suspensions and manual payments; from BLESTA_STAFF_ID when the caller gives none. */
export function resolveStaffId(explicit: number | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (explicit !== undefined) return explicit;
  const v = env.BLESTA_STAFF_ID ? Number(env.BLESTA_STAFF_ID) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

let cachedCompanyId: number | undefined;

/** Company ID for catalog calls: explicit param, then BLESTA_COMPANY_ID, then the first company Blesta reports. */
export async function resolveCompanyId(api: BlestaClient, explicit?: number): Promise<number> {
  if (explicit) return explicit;
  const fromEnv = process.env.BLESTA_COMPANY_ID ? Number(process.env.BLESTA_COMPANY_ID) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (cachedCompanyId) return cachedCompanyId;
  const companies = await api.get<Array<{ id: number | string }> | false>("companies", "getAll");
  const first = Array.isArray(companies) && companies.length ? Number(companies[0].id) : NaN;
  if (!Number.isFinite(first)) throw new Error("Could not determine company_id; pass it explicitly or set BLESTA_COMPANY_ID.");
  cachedCompanyId = first;
  return first;
}

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function writeNote(api: BlestaClient): string {
  return api.readOnly ? " DISABLED: server runs with BLESTA_READ_ONLY=1; the call will be refused." : "";
}
