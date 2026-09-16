import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient, HttpMethod } from "../client.js";
import { guard, ok } from "../format.js";

/** Picks the HTTP verb Blesta expects for a method name when the caller does not say. */
export function inferHttpMethod(method: string): HttpMethod {
  if (/^(add|create|process|apply|send|auth|systemEncrypt|systemDecrypt|verify)/.test(method)) return "POST";
  if (/^(edit|set|update|cancel|suspend|unsuspend|renew|void|unapply|mark|reset|increment|decrement)/.test(method)) return "PUT";
  if (/^(delete|remove|unset|purge)/.test(method)) return "DELETE";
  return "GET";
}

export function registerGenericTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "blesta_call",
    {
      title: "Call any Blesta API method",
      description:
        "Escape hatch: call any public model method of the Blesta API as {model}/{method}. Parameters are passed BY NAME and must match " +
        "the PHP method's argument names (see https://source-docs.blesta.com/classes/{Model}.html). Nested arrays/objects are supported " +
        "(e.g. params: {\"vars\": {\"client_id\": 1, \"lines\": [{\"description\": \"x\", \"amount\": \"5.00\"}]}}). " +
        "Plugin models use \"plugin.model\" (e.g. \"support_manager.support_manager_tickets\"). " +
        "If `http_method` is omitted it is inferred from the method name (get*/search* -> GET, add* -> POST, edit*/set* -> PUT, delete* -> DELETE). " +
        "Timestamps must include a timezone (e.g. 2026-01-31T12:00:00Z). " +
        "If Blesta answers HTTP 500 'Failed to retrieve the default value', resend with every optional argument explicitly set. " +
        "Any valid API key has full administrative power; prefer the purpose-built tools when one exists." +
        (api.readOnly ? " NOTE: this server runs in read-only mode, only GET calls are allowed." : ""),
      inputSchema: z.object({
        model: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/)
          .describe("Model name in snake_case as used in the URL, e.g. clients, invoices, services, transactions, or plugin.model"),
        method: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .describe("Public method name, e.g. get, getList, add, edit"),
        params: z.record(z.string(), z.unknown()).default({}).describe("Named arguments for the method; nested objects/arrays allowed"),
        http_method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("Override the inferred HTTP verb"),
        max_chars: z.number().int().min(1000).max(200_000).optional().describe("Cap on returned JSON size (default 60000)"),
      }),
      annotations: { readOnlyHint: api.readOnly, destructiveHint: !api.readOnly, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ model, method, params, http_method, max_chars }) => {
      const verb = http_method ?? inferHttpMethod(method);
      const result = await api.call(model, method, params, verb);
      return ok({ request: `${verb} ${model}/${method}`, response: result }, max_chars);
    })
  );
}
