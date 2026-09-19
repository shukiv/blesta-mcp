#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { clientFromEnv } from "./client.js";
import { registerClientTools } from "./tools/clients.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerServiceTools } from "./tools/services.js";
import { registerPaymentTools } from "./tools/payments.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDocumentTools } from "./tools/documents.js";

const SERVER_NAME = "blesta-mcp";
const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const api = clientFromEnv();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for the Blesta billing system. IDs are numeric database ids; displayed invoice/client numbers (id_code) are different. " +
        "Start with search_clients or search_invoices to resolve a customer or invoice, then use get_* tools with the numeric id. " +
        "All timestamps returned are UTC in 'YYYY-MM-DD hh:mm:ss' format." +
        (api.readOnly ? " This server is READ-ONLY: no create/edit/delete calls will be sent." : ""),
    }
  );

  registerClientTools(server, api);
  registerInvoiceTools(server, api);
  registerServiceTools(server, api);
  registerPaymentTools(server, api, { clientUri: process.env.BLESTA_CLIENT_URI ?? "client/" });
  registerTransactionTools(server, api);
  registerCatalogTools(server, api);
  registerDocumentTools(server, api);
  registerGenericTools(server, api);
  return server;
}

// Fail fast with a readable message when configuration is missing.
try {
  clientFromEnv();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${SERVER_NAME}] ${msg}`);
  process.exit(1);
}

serveStdio(createServer);
