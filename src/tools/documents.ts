import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BlestaClient } from "../client.js";
import { guard, ok, fail, type ToolResult } from "../format.js";
import { READ } from "../common.js";

/**
 * Invoice documents. PDF rendering lives in Blesta's InvoiceDelivery component, which the stock API
 * does not route. The free "Component API" plugin (https://docs.blesta.com/integrations/plugins/component-api/)
 * exposes it as ComponentApi.ComponentApiCaller/call and streams the PDF bytes back.
 */

const COMPONENT_API_MODEL = "ComponentApi.ComponentApiCaller";
const COMPONENT_API_HINT =
  "The Component API plugin is required: download component_api.zip from " +
  "https://docs.blesta.com/integrations/plugins/component-api/, unzip into plugins/, install under Settings > Company > Plugins > Available.";

interface InvoiceRecord {
  id: number;
  id_code?: string;
  client_id?: number | string;
  status?: string;
}

/** Keeps only a safe basename: no directories, no control characters, .pdf extension. */
function safePdfName(name: string): string {
  const base = basename(name).replace(/[\x00-\x1f<>:"|?*]/g, "_").trim() || "invoice";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export function defaultDownloadDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLESTA_DOWNLOAD_DIR?.trim() || join(tmpdir(), "blesta-mcp");
}

export function registerDocumentTools(server: McpServer, api: BlestaClient): void {
  server.registerTool(
    "download_invoice_pdf",
    {
      title: "Download invoice PDF",
      description:
        "Render one or more invoices to a PDF using Blesta's own invoice template and save the file locally. " +
        "Several invoice IDs are combined into a single document. Returns the saved path; set `include_base64` to also " +
        "embed the PDF in the result. Requires the Blesta Component API plugin (wraps InvoiceDelivery.downloadInvoices). " +
        "Nothing is emailed and nothing in Blesta changes.",
      inputSchema: z.object({
        invoice_ids: z.array(z.number().int().positive()).min(1).max(20).describe("Numeric invoice IDs (not id_code)"),
        output_dir: z
          .string()
          .optional()
          .describe("Directory to save into; default BLESTA_DOWNLOAD_DIR or the OS temp dir under blesta-mcp/"),
        filename: z.string().optional().describe("File name; default <invoice_number>.pdf (or invoices-<ids>.pdf)"),
        language: z.string().optional().describe("Invoice language such as en_us; default is the client's language"),
        include_base64: z
          .boolean()
          .default(false)
          .describe("Also return the PDF bytes as an embedded base64 resource (large; only when the caller needs the bytes)"),
      }),
      annotations: READ,
    },
    guard(async ({ invoice_ids, output_dir, filename, language, include_base64 }): Promise<ToolResult> => {
      const ids = [...new Set(invoice_ids)];
      const invoices: { invoice_id: number; invoice_number: string; client_id: number | string | undefined; status: string | undefined }[] = [];
      for (const invoice_id of ids) {
        const inv = await api.get<InvoiceRecord | false>("invoices", "get", { invoice_id });
        if (!inv || typeof inv !== "object") return fail(`Invoice ${invoice_id} not found.`);
        invoices.push({ invoice_id, invoice_number: inv.id_code ?? String(invoice_id), client_id: inv.client_id, status: inv.status });
      }

      const params: Record<string, unknown> = { invoice_ids: ids };
      if (language) params.options = { language };
      const res = await api.callRaw(COMPONENT_API_MODEL, "call", {
        component: "InvoiceDelivery",
        method: "downloadInvoices",
        params,
      });

      const isPdf = res.body.subarray(0, 5).toString("latin1") === "%PDF-";
      if (!isPdf) {
        const text = res.body.toString("utf8").slice(0, 400);
        return fail(
          `Blesta did not return a PDF (content-type "${res.contentType}"): ${text || "(empty body)"}\n${COMPONENT_API_HINT}`
        );
      }

      const dir = resolve(output_dir?.trim() || defaultDownloadDir());
      await mkdir(dir, { recursive: true });
      const name = safePdfName(
        filename ?? (ids.length === 1 ? invoices[0].invoice_number : `invoices-${ids.join("-")}`)
      );
      const path = join(dir, name);
      await writeFile(path, res.body);

      const summary = { path, bytes: res.body.length, invoices, language: language ?? "client default" };
      const result = ok(summary);
      if (include_base64) {
        result.content.push({
          type: "resource",
          resource: { uri: pathToFileURL(path).href, mimeType: "application/pdf", blob: res.body.toString("base64") },
        });
      }
      return result;
    })
  );
}
