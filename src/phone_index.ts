/**
 * Phone-number index for clients.
 *
 * Blesta's Clients.search matches id_code, company, name, address1, email and note text, but never
 * the contact_numbers table, and no API method searches phone numbers. The only way to answer
 * "which client has this number" is to read the numbers of every contact. That costs one call per
 * contact, so the result is kept: in memory while the server runs and, unless disabled, in a
 * private file that survives restarts.
 *
 * Build order: Clients.getAll (one unpaged call) gives every client with its primary contact ID;
 * stage 1 reads Contacts.getNumbers for those primary contacts; stage 2 reads Contacts.getAll per
 * client and the numbers of every non-primary contact. Lookups are served from whatever has been
 * read so far, so a caller is usually answered long before the build finishes.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BlestaClient } from "./client.js";

export interface PhoneEntry {
  client_id: number;
  contact_id: number;
  /** Number exactly as stored in Blesta. */
  number: string;
  type?: string;
  location?: string;
  primary: boolean;
}

export interface PhoneIndexStatus {
  status: "empty" | "building" | "ready";
  /** How much of the install the served data covers. */
  coverage: "none" | "primary_contacts" | "all_contacts";
  built_at: string | null;
  clients: number;
  numbers: number;
  progress?: { stage: string; done: number; total: number };
  source: "none" | "disk" | "live";
  error?: string;
}

export interface PhoneIndexOptions {
  /** Cache file, or null to keep the index in memory only. */
  file: string | null;
  ttlMs: number;
  concurrency: number;
  /** A miss triggers one rebuild when the data is older than this. */
  missRefreshMs: number;
}

const MIN_DIGITS = 7;

/**
 * Digit keys for one stored number field. Fields are messy in practice ("03-1234567 ext 2",
 * two numbers separated by a slash, even an e-mail address), so the value is split on letters and
 * list separators, reduced to digits, stripped of leading zeros (trunk prefix) and kept only when
 * at least 7 digits remain.
 */
export function phoneKeys(raw: unknown): string[] {
  const out: string[] = [];
  for (const chunk of String(raw ?? "").split(/[/,;|]|\p{L}+/u)) {
    const digits = chunk.replace(/\D/g, "").replace(/^0+/, "");
    if (digits.length >= MIN_DIGITS) out.push(digits);
  }
  return out;
}

/** Key for a search query, or null when the query is not phone-like (letters, or fewer than 7 digits). */
export function phoneQueryKey(query: string): string | null {
  if (/\p{L}|@/u.test(query)) return null;
  const digits = query.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= MIN_DIGITS ? digits : null;
}

/** Country-agnostic match: equal, or one is a suffix of the other (covers +CC prefixes and missing area codes). */
export function phoneKeyMatches(a: string, b: string): boolean {
  return a === b || a.endsWith(b) || b.endsWith(a);
}

interface Indexed extends PhoneEntry {
  keys: string[];
}

interface DiskFormat {
  version: 1;
  api_url: string;
  built_at: number;
  coverage: "primary_contacts" | "all_contacts";
  clients: number;
  entries: PhoneEntry[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

export function phoneIndexOptionsFromEnv(apiUrl: string, env: NodeJS.ProcessEnv = process.env): PhoneIndexOptions {
  const raw = env.BLESTA_PHONE_INDEX_FILE?.trim();
  let file: string | null;
  if (raw && ["0", "off", "false", "none"].includes(raw.toLowerCase())) {
    file = null;
  } else if (raw) {
    file = raw;
  } else {
    const cacheRoot = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
    const tag = createHash("sha256").update(apiUrl).digest("hex").slice(0, 12);
    file = join(cacheRoot, "blesta-mcp", `phone-index-${tag}.json`);
  }
  const num = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    file,
    ttlMs: num(env.BLESTA_PHONE_INDEX_TTL_HOURS, 24, 0.05, 24 * 365) * 3_600_000,
    concurrency: Math.round(num(env.BLESTA_INDEX_CONCURRENCY, 8, 1, 32)),
    missRefreshMs: 60 * 60_000,
  };
}

export class PhoneIndex {
  /** Last completed data set. */
  private served: Indexed[] = [];
  /** Data of the build in progress; searched together with `served`. */
  private pending: Indexed[] = [];
  private coverage: PhoneIndexStatus["coverage"] = "none";
  private builtAt: number | null = null;
  private clients = 0;
  private source: PhoneIndexStatus["source"] = "none";
  private building: Promise<void> | null = null;
  private progress: PhoneIndexStatus["progress"];
  private lastError: string | undefined;
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly api: BlestaClient,
    private readonly opts: PhoneIndexOptions
  ) {}

  status(): PhoneIndexStatus {
    return {
      status: this.building ? "building" : this.builtAt ? "ready" : "empty",
      coverage: this.coverage,
      built_at: this.builtAt ? new Date(this.builtAt).toISOString() : null,
      clients: this.clients,
      numbers: Math.max(this.served.length, this.pending.length),
      ...(this.building && this.progress ? { progress: this.progress } : {}),
      source: this.source,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * Finds entries for a query key. Starts or refreshes the index when needed and waits up to
   * `waitMs` for a match or for the build to finish, whichever comes first.
   */
  async lookup(key: string, o: { waitMs: number; refresh?: boolean }): Promise<{ matches: PhoneEntry[]; index: PhoneIndexStatus }> {
    await (this.loaded ??= this.load());
    const stale = this.builtAt !== null && Date.now() - this.builtAt > this.opts.ttlMs;
    if (o.refresh || this.builtAt === null || stale || this.coverage !== "all_contacts") this.start();

    const deadline = Date.now() + o.waitMs;
    let retried = false;
    for (;;) {
      const matches = this.find(key);
      if (matches.length) return { matches, index: this.status() };
      if (!this.building) {
        // A miss on old data may just mean the client is new: rebuild once, then answer.
        const age = this.builtAt ? Date.now() - this.builtAt : Infinity;
        if (!retried && !this.lastError && age > this.opts.missRefreshMs) {
          retried = true;
          this.start();
          continue;
        }
        return { matches, index: this.status() };
      }
      if (Date.now() >= deadline) return { matches, index: this.status() };
      await sleep(200);
    }
  }

  private all(): Indexed[] {
    return this.pending.length ? [...this.served, ...this.pending] : this.served;
  }

  private find(key: string): PhoneEntry[] {
    const seen = new Set<string>();
    const out: PhoneEntry[] = [];
    for (const e of this.all()) {
      if (!e.keys.some((k) => phoneKeyMatches(key, k))) continue;
      const id = `${e.contact_id}:${e.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const { keys: _keys, ...entry } = e;
      out.push(entry);
    }
    return out;
  }

  private start(): void {
    if (this.building) return;
    this.lastError = undefined;
    this.building = this.build()
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.pending = [];
        this.building = null;
        this.progress = undefined;
      });
  }

  private async numbersOf(contact_id: number, client_id: number, primary: boolean): Promise<void> {
    let rows: unknown;
    try {
      rows = await this.api.get("contacts", "getNumbers", { contact_id });
    } catch {
      return; // one unreadable contact must not abort the whole build
    }
    if (!Array.isArray(rows)) return;
    for (const r of rows as Array<{ number?: unknown; type?: string; location?: string }>) {
      const keys = phoneKeys(r.number);
      if (!keys.length) continue;
      this.pending.push({ client_id, contact_id, number: String(r.number), type: r.type, location: r.location, primary, keys });
    }
  }

  private async build(): Promise<void> {
    const rows = await this.api.get<Array<{ id: number | string; contact_id?: number | string }> | false>("clients", "getAll");
    const clients = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ id: Number(r.id), contact_id: Number(r.contact_id) }))
      .filter((c) => Number.isFinite(c.id));
    this.pending = [];

    // Stage 1: primary contacts, known from the client list without further lookups.
    this.progress = { stage: "primary contacts", done: 0, total: clients.length };
    await pool(clients, this.opts.concurrency, async (c) => {
      if (Number.isFinite(c.contact_id)) await this.numbersOf(c.contact_id, c.id, true);
      this.progress!.done++;
    });
    if (this.coverage === "none") {
      // First build ever: make the primary numbers durable before the slower stage.
      this.served = [...this.pending];
      this.coverage = "primary_contacts";
      this.builtAt = Date.now();
      this.clients = clients.length;
      this.source = "live";
      await this.save();
    }

    // Stage 2: additional contacts of each client.
    this.progress = { stage: "other contacts", done: 0, total: clients.length };
    await pool(clients, this.opts.concurrency, async (c) => {
      try {
        const contacts = await this.api.get<Array<{ id: number | string }> | false>("contacts", "getAll", { client_id: c.id });
        for (const ct of Array.isArray(contacts) ? contacts : []) {
          const id = Number(ct.id);
          if (Number.isFinite(id) && id !== c.contact_id) await this.numbersOf(id, c.id, false);
        }
      } catch {
        /* skip this client */
      }
      this.progress!.done++;
    });

    this.served = this.pending;
    this.pending = [];
    this.coverage = "all_contacts";
    this.builtAt = Date.now();
    this.clients = clients.length;
    this.source = "live";
    await this.save();
  }

  private async load(): Promise<void> {
    if (!this.opts.file) return;
    try {
      const data = JSON.parse(await readFile(this.opts.file, "utf8")) as DiskFormat;
      if (data.version !== 1 || data.api_url !== this.api.apiUrl || !Array.isArray(data.entries)) return;
      this.served = data.entries.map((e) => ({ ...e, keys: phoneKeys(e.number) })).filter((e) => e.keys.length);
      this.coverage = data.coverage;
      this.builtAt = data.built_at;
      this.clients = data.clients;
      this.source = "disk";
    } catch {
      /* no cache yet, or unreadable: build from scratch */
    }
  }

  /** Atomic, private write: the file holds customer phone numbers. */
  private async save(): Promise<void> {
    const file = this.opts.file;
    if (!file || this.coverage === "none" || this.builtAt === null) return;
    const data: DiskFormat = {
      version: 1,
      api_url: this.api.apiUrl,
      built_at: this.builtAt,
      coverage: this.coverage,
      clients: this.clients,
      entries: this.served.map(({ keys: _keys, ...e }) => e),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await unlink(tmp).catch(() => undefined);
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsConstants;
      const fh = await open(tmp, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o600);
      try {
        await fh.writeFile(JSON.stringify(data));
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
    } catch (err) {
      this.lastError = `phone index not saved: ${err instanceof Error ? err.message : String(err)}`;
      await unlink(tmp).catch(() => undefined);
    }
  }
}
