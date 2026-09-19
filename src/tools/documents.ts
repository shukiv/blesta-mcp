import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
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

/**
 * Keeps only a safe basename: directory parts (both separators) dropped, control and
 * shell-hostile characters replaced, dot-only names refused, length capped, .pdf extension.
 */
export function safePdfName(name: string): string {
  let base = basename(name.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!base || base === "pdf") base = "invoice";
  if (base.length > 120) base = base.slice(0, 120);
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/** Root directory below which every PDF is written. */
export function downloadRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.BLESTA_DOWNLOAD_DIR?.trim() || join(tmpdir(), "blesta-mcp"));
}

/**
 * Resolves the requested output directory and refuses anything outside the download root, so a
 * caller (or a prompt-injected instruction) cannot direct writes elsewhere on the host.
 * Relative paths are taken relative to the root; absolute paths must already be inside it.
 */
export async function resolveOutputDir(requested: string | undefined, root = downloadRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(root);
  const inside = (p: string): boolean => p === rootReal || p.startsWith(rootReal + sep);
  const refuse = (): never => {
    throw new Error(
      `output_dir must be inside the download root ${rootReal} (set BLESTA_DOWNLOAD_DIR to move the root).`
    );
  };
  // Lexical check first, so nothing is created outside the root even transiently.
  const wanted = requested?.trim() ? resolve(rootReal, requested.trim()) : rootReal;
  if (!inside(wanted)) refuse();
  // Create one component at a time and refuse to descend through a symlink, so a planted link
  // inside the root cannot make mkdir create or reach directories elsewhere.
  let current = rootReal;
  for (const part of wanted.slice(rootReal.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let st;
    try {
      st = await lstat(current);
    } catch {
      await mkdir(current, { mode: 0o700 });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) refuse();
  }
  const real = await realpath(current);
  if (!inside(real)) refuse();
  return real;
}

/**
 * Writes the PDF without following a pre-existing symlink at the target (O_NOFOLLOW), so a
 * planted link in a shared temp directory cannot redirect the write. Overwrites a regular file.
 */
async function writePdf(path: string, body: Buffer): Promise<void> {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fsConstants;
  let fh;
  try {
    fh = await open(path, O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing to write ${path}: it is a symbolic link.`);
    }
    throw e;
  }
  try {
    await fh.writeFile(body);
  } finally {
    await fh.close();
  }
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
          .describe(
            "Subdirectory (relative to the download root) to save into. The root is BLESTA_DOWNLOAD_DIR or <os temp>/blesta-mcp; paths outside it are refused"
          ),
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

      let dir: string;
      try {
        dir = await resolveOutputDir(output_dir);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      const name = safePdfName(
        filename ?? (ids.length === 1 ? invoices[0].invoice_number : `invoices-${ids.join("-")}`)
      );
      const path = join(dir, name);
      await writePdf(path, res.body);

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
