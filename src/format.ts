import { BlestaError } from "./client.js";

/** Shape returned by every tool handler (matches the MCP CallToolResult content array). */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Hard cap on serialized output so a large list never floods the model context. */
export const DEFAULT_MAX_CHARS = 60_000;

export function serialize(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars; narrow the query or page through results]`;
}

export function ok(value: unknown, maxChars?: number): ToolResult {
  return { content: [{ type: "text", text: serialize(value, maxChars) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a handler so BlestaError and unexpected exceptions become readable tool errors instead of protocol errors. */
export function guard<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof BlestaError) return fail(err.describe());
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Unexpected error: ${msg}`);
    }
  };
}

/** Blesta's PHP models return `false` for "not found"; normalise that for callers. */
export function isMissing(value: unknown): boolean {
  return value === false || value === null || value === undefined;
}
