/**
 * Minimal HTTP client for the Blesta API.
 *
 * Behaviour mirrors the official PHP SDK (phillipsdata/blesta_sdk):
 *  - URL:      {base}/api/{model}/{method}.json
 *  - Auth:     BLESTA-API-USER / BLESTA-API-KEY headers
 *  - Params:   PHP http_build_query encoding (nested arrays as a[b][0][c]=v)
 *              GET/DELETE -> query string, POST/PUT -> form-encoded body
 *  - Success:  HTTP 200 with {"response": <value>}
 *  - Failure:  non-200 with {"message": "...", "errors": {field: {code: msg}}}
 */

import { readFileSync } from "node:fs";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type Params = Record<string, unknown>;

export interface BlestaClientOptions {
  /** Install URL or API URL, e.g. https://billing.example.com or https://billing.example.com/api/ */
  url: string;
  user: string;
  key: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** When true, any non-GET request is rejected before it is sent. */
  readOnly?: boolean;
  /** Set to false to allow plain-http URLs (only sensible for local testing). */
  requireHttps?: boolean;
  /**
   * Blesta.system_key from config/blesta.php. Optional. When set, systemEncrypt/systemDecrypt/systemHash
   * are called with explicit key/iv, which is required on IonCube-encoded installs where omitted
   * optional arguments fail with "Failed to retrieve the default value".
   */
  systemKey?: string;
  /** Public base URL of the install used when building customer-facing links; defaults to `url`. */
  publicUrl?: string;
}

export class BlestaError extends Error {
  readonly status: number;
  readonly errors: Record<string, Record<string, string>> | undefined;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BlestaError";
    this.status = status;
    this.body = body;
    const b = body as { errors?: unknown } | null;
    this.errors =
      b && typeof b === "object" && b.errors && typeof b.errors === "object"
        ? (b.errors as Record<string, Record<string, string>>)
        : undefined;
  }

  /** Human readable multi-line summary suitable for returning to an LLM. */
  describe(): string {
    const lines = [`Blesta API error (HTTP ${this.status}): ${this.message}`];
    if (this.errors) {
      for (const line of flattenErrors(this.errors)) lines.push(`  - ${line}`);
    }
    const response = (this.body as { response?: unknown } | null)?.response;
    if (this.status === 500 && typeof response === "string") {
      lines.push(`  response: ${response}`);
      if (response.includes("Failed to retrieve the default value")) {
        lines.push(
          "  hint: IonCube could not resolve a default argument. Retry with EVERY optional parameter of the method explicitly supplied. " +
            "For encryption/systemEncrypt and systemDecrypt set BLESTA_SYSTEM_KEY (Blesta.system_key from config/blesta.php)."
        );
      }
    }
    return lines.join("\n");
  }
}

/** Flattens Blesta's nested {field: {code: message}} error map into "field.code: message" lines. */
export function flattenErrors(errors: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (!errors || typeof errors !== "object") return out;
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      out.push(...flattenErrors(value, path));
    } else {
      out.push(`${path}: ${String(value)}`);
    }
  }
  return out;
}

/**
 * Encodes a nested value exactly like PHP's http_build_query:
 *   {vars: {client_id: 1, lines: [{amount: "5.99"}]}}
 *   -> vars[client_id]=1&vars[lines][0][amount]=5.99
 * Booleans become 1/0, null and undefined are skipped.
 */
export function phpQuery(params: Params): URLSearchParams {
  const qs = new URLSearchParams();
  const walk = (key: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "boolean") {
      qs.append(key, value ? "1" : "0");
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (value instanceof Date) {
      qs.append(key, value.toISOString());
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${key}[${k}]`, v);
      }
    } else {
      qs.append(key, String(value));
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return qs;
}

/** Normalises whatever the user configured into ".../api/". */
export function normalizeApiUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  if (!/\/api$/i.test(url)) url += "/api";
  return `${url}/`;
}

const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Methods that are called with POST (to keep their payload out of the URL) but have no side effects.
 * They stay allowed in read-only mode.
 */
const PURE_POST_METHODS = new Set(["encryption/systemEncrypt", "encryption/systemDecrypt"]);
const MODEL = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export class BlestaClient {
  readonly apiUrl: string;
  private readonly user: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  readonly readOnly: boolean;
  private readonly systemKey: string | undefined;
  /** Install root (no trailing "api/") used for customer-facing links. */
  readonly publicBase: string;

  constructor(opts: BlestaClientOptions) {
    this.apiUrl = normalizeApiUrl(opts.url);
    if (opts.requireHttps !== false && !this.apiUrl.startsWith("https://")) {
      throw new Error(
        "BLESTA_URL must use https:// (the API key travels in every request). Set BLESTA_ALLOW_HTTP=1 to override for local testing."
      );
    }
    this.user = opts.user;
    this.key = opts.key;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.readOnly = opts.readOnly ?? false;
    this.systemKey = opts.systemKey?.trim() || undefined;
    const pub = opts.publicUrl?.trim() ? normalizeApiUrl(opts.publicUrl) : this.apiUrl;
    this.publicBase = pub.replace(/api\/$/, "");
  }

  /** True when a Blesta.system_key was configured. */
  get hasSystemKey(): boolean {
    return this.systemKey !== undefined;
  }

  /**
   * AES-256-CBC encryption with the install's system key (AppModel::systemEncrypt).
   * Passes key/iv explicitly when BLESTA_SYSTEM_KEY is configured, otherwise relies on the PHP defaults.
   */
  systemEncrypt(value: string): Promise<string> {
    return this.post<string>("encryption", "systemEncrypt", this.withSystemKey({ value }));
  }

  /** Inverse of systemEncrypt (AppModel::systemDecrypt). */
  systemDecrypt(value: string): Promise<string> {
    return this.post<string>("encryption", "systemDecrypt", this.withSystemKey({ value }));
  }

  private withSystemKey(params: Params): Params {
    return this.systemKey ? { ...params, key: this.systemKey, iv: this.systemKey } : params;
  }

  /**
   * Calls {model}/{method} and returns the unwrapped "response" value.
   * Throws BlestaError for non-200 responses or transport failures.
   */
  async call<T = unknown>(
    model: string,
    method: string,
    params: Params = {},
    httpMethod: HttpMethod = "GET"
  ): Promise<T> {
    if (!MODEL.test(model)) throw new BlestaError(`Invalid model name: ${model}`, 0, null);
    if (!PATH_SEGMENT.test(method)) throw new BlestaError(`Invalid method name: ${method}`, 0, null);
    if (this.readOnly && httpMethod !== "GET" && !PURE_POST_METHODS.has(`${model}/${method}`)) {
      throw new BlestaError(
        `Server is running in read-only mode (BLESTA_READ_ONLY=1); ${httpMethod} ${model}/${method} was not sent.`,
        0,
        null
      );
    }

    const encoded = phpQuery(params).toString();
    let url = `${this.apiUrl}${model}/${method}.json`;
    const headers: Record<string, string> = {
      "BLESTA-API-USER": this.user,
      "BLESTA-API-KEY": this.key,
      Accept: "application/json",
    };
    const init: RequestInit = {
      method: httpMethod,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (httpMethod === "GET" || httpMethod === "DELETE") {
      if (encoded) url += `?${encoded}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = encoded;
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BlestaError(`Request to ${model}/${method} failed: ${msg}`, 0, null);
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }

    if (res.status !== 200) {
      const message =
        (body as { message?: string } | null)?.message ?? `HTTP ${res.status} ${res.statusText}`;
      throw new BlestaError(message, res.status, body);
    }

    if (body && typeof body === "object" && "response" in (body as object)) {
      return (body as { response: T }).response;
    }
    return body as T;
  }

  /**
   * Calls {model}/{method} and returns the raw HTTP response body (for endpoints that stream binary
   * data instead of JSON, e.g. the Component API plugin returning a PDF). GET only, so it is always
   * allowed in read-only mode. Non-200 responses are converted to BlestaError like `call`.
   */
  async callRaw(
    model: string,
    method: string,
    params: Params = {}
  ): Promise<{ status: number; contentType: string; body: Buffer }> {
    if (!MODEL.test(model)) throw new BlestaError(`Invalid model name: ${model}`, 0, null);
    if (!PATH_SEGMENT.test(method)) throw new BlestaError(`Invalid method name: ${method}`, 0, null);
    const encoded = phpQuery(params).toString();
    const url = `${this.apiUrl}${model}/${method}.json${encoded ? `?${encoded}` : ""}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { "BLESTA-API-USER": this.user, "BLESTA-API-KEY": this.key },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BlestaError(`Request to ${model}/${method} failed: ${msg}`, 0, null);
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = { message: body.toString("utf8").slice(0, 500) };
      }
      const message = (parsed as { message?: string } | null)?.message ?? `HTTP ${res.status} ${res.statusText}`;
      throw new BlestaError(message, res.status, parsed);
    }
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
  }

  get<T = unknown>(model: string, method: string, params?: Params): Promise<T> {
    return this.call<T>(model, method, params, "GET");
  }
  post<T = unknown>(model: string, method: string, params?: Params): Promise<T> {
    return this.call<T>(model, method, params, "POST");
  }
  put<T = unknown>(model: string, method: string, params?: Params): Promise<T> {
    return this.call<T>(model, method, params, "PUT");
  }
  delete<T = unknown>(model: string, method: string, params?: Params): Promise<T> {
    return this.call<T>(model, method, params, "DELETE");
  }
}

/** Resolves Blesta.system_key from BLESTA_SYSTEM_KEY or, preferably, a file named by BLESTA_SYSTEM_KEY_FILE. */
export function systemKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BLESTA_SYSTEM_KEY_FILE) {
    const value = readFileSync(env.BLESTA_SYSTEM_KEY_FILE, "utf8").trim();
    if (!value) throw new Error(`BLESTA_SYSTEM_KEY_FILE (${env.BLESTA_SYSTEM_KEY_FILE}) is empty`);
    return value;
  }
  return env.BLESTA_SYSTEM_KEY;
}

/** Builds a client from environment variables, throwing a clear error when something is missing. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): BlestaClient {
  const url = env.BLESTA_URL;
  const user = env.BLESTA_API_USER;
  const key = env.BLESTA_API_KEY;
  const missing = [!url && "BLESTA_URL", !user && "BLESTA_API_USER", !key && "BLESTA_API_KEY"].filter(
    Boolean
  );
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  const truthy = (v: string | undefined) => v === "1" || v === "true";
  return new BlestaClient({
    url: url!,
    user: user!,
    key: key!,
    timeoutMs: env.BLESTA_TIMEOUT_MS ? Number(env.BLESTA_TIMEOUT_MS) : undefined,
    readOnly: truthy(env.BLESTA_READ_ONLY),
    requireHttps: !truthy(env.BLESTA_ALLOW_HTTP),
    systemKey: systemKeyFromEnv(env),
    publicUrl: env.BLESTA_PUBLIC_URL,
  });
}
