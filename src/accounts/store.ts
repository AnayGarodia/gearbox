// Secret store + account registry. Secrets are stored in an AES-256-GCM
// encrypted file at ~/.gearbox/credentials.enc with a random key at
// ~/.gearbox/.enckey (0600). When running under Bun the OS keychain is also
// tried first (set GEARBOX_SECRET_STORE=file to skip it).
//
// HONEST THREAT MODEL: the key sits next to the data, so file mode is
// obfuscation against casual leakage (a stray `cat`, accidental commit),
// NOT protection against a local attacker who can read your home dir.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Account, AccountsFile } from "./types.ts";

const SERVICE = "gearbox";

// Same ~/.gearbox + GEARBOX_HOME convention as src/session.ts.
const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const ensure = () => mkdirSync(home(), { recursive: true });

type StoreMode = "auto" | "file" | "keychain";
const mode = (): StoreMode => {
  const m = process.env.GEARBOX_SECRET_STORE;
  return m === "file" || m === "keychain" ? m : "auto";
};

// ── secrets ──
export async function setSecret(ref: string, value: string): Promise<void> {
  // Under Bun try the OS keychain first (better security); fall back to file.
  if (typeof Bun !== "undefined" && mode() !== "file") {
    try {
      await (Bun as any).secrets.set({ service: SERVICE, name: ref, value });
      return;
    } catch (e) {
      if (mode() === "keychain") throw e;
    }
  }
  fileSet(ref, value);
}

export async function getSecret(ref: string): Promise<string | null> {
  if (typeof Bun !== "undefined" && mode() !== "file") {
    try {
      const v = await (Bun as any).secrets.get({ service: SERVICE, name: ref });
      if (v != null) return v;
    } catch {
      if (mode() === "keychain") return null;
    }
  }
  return fileGet(ref);
}

export async function deleteSecret(ref: string): Promise<void> {
  if (typeof Bun !== "undefined" && mode() !== "file") {
    try {
      await (Bun as any).secrets.delete({ service: SERVICE, name: ref });
    } catch {
      /* fall through to clear the file copy too */
    }
  }
  fileDelete(ref);
}

// ── encrypted-file fallback ──
const encFile = () => join(home(), "credentials.enc");
const keyFile = () => join(home(), ".enckey");

function masterKey(): Buffer {
  ensure();
  if (existsSync(keyFile())) return Buffer.from(readFileSync(keyFile(), "utf8").trim(), "base64");
  const k = randomBytes(32);
  writeFileSync(keyFile(), k.toString("base64"), { mode: 0o600 });
  return k;
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

function decrypt(blob: string): string | null {
  try {
    const [iv, tag, data] = blob.split(".").map((x) => Buffer.from(x, "base64"));
    const d = createDecipheriv("aes-256-gcm", masterKey(), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(data!), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function readEnc(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(encFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeEnc(m: Record<string, string>): void {
  ensure();
  writeFileSync(encFile(), JSON.stringify(m), { mode: 0o600 });
}
function fileSet(ref: string, v: string): void {
  const m = readEnc();
  m[ref] = encrypt(v);
  writeEnc(m);
}
function fileGet(ref: string): string | null {
  const blob = readEnc()[ref];
  return blob ? decrypt(blob) : null;
}
function fileDelete(ref: string): void {
  const m = readEnc();
  delete m[ref];
  writeEnc(m);
}

// ── account registry (non-secret; refs only) ──
const accountsFile = () => join(home(), "accounts.json");

export function loadAccounts(): AccountsFile {
  try {
    const f = JSON.parse(readFileSync(accountsFile(), "utf8"));
    if (f && Array.isArray(f.accounts)) return { version: 1, defaults: {}, ...f };
  } catch {
    /* none yet */
  }
  return { version: 1, accounts: [], defaults: {} };
}

export function saveAccounts(f: AccountsFile): void {
  try {
    ensure();
    writeFileSync(accountsFile(), JSON.stringify(f, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort, like session save */
  }
}

export function listAccounts(): Account[] {
  return loadAccounts().accounts;
}

export function accountsForProvider(provider: string): Account[] {
  return listAccounts().filter((a) => a.provider === provider && a.enabled);
}

export function getAccount(id: string): Account | undefined {
  return listAccounts().find((a) => a.id === id);
}

/** Normalize a label/id to a kebab slug, suffixing -2, -3… to avoid collisions. */
export function uniqueSlug(base: string, taken: string[]): string {
  const norm = base.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
  if (!taken.includes(norm)) return norm;
  for (let n = 2; ; n++) {
    const cand = `${norm}-${n}`;
    if (!taken.includes(cand)) return cand;
  }
}

export function accountBySlug(slug: string): Account | undefined {
  const s = slug.trim().toLowerCase();
  if (!s) return undefined;
  return listAccounts().find((a) => (a.slug ?? "") === s);
}

// Base for a slug: derived from the human-facing label (already set on the Account).
function deriveSlugBase(a: Account): string {
  return a.label;
}

/** Add (or replace by id) an account and persist. */
export function putAccount(account: Account): void {
  const f = loadAccounts();
  const i = f.accounts.findIndex((a) => a.id === account.id);
  if (!account.slug) {
    const taken = f.accounts.filter((a) => a.id !== account.id).map((a) => a.slug ?? "").filter(Boolean);
    // Prefer the existing slug for this id (stable across edits); else derive one.
    account.slug = (i >= 0 && f.accounts[i]!.slug) || uniqueSlug(deriveSlugBase(account), taken);
  }
  if (i >= 0) f.accounts[i] = account;
  else f.accounts.push(account);
  if (!f.defaults[account.provider]) f.defaults[account.provider] = account.id; // first of a provider = default
  saveAccounts(f);
}

export async function removeAccount(id: string): Promise<void> {
  const f = loadAccounts();
  const acc = f.accounts.find((a) => a.id === id);
  f.accounts = f.accounts.filter((a) => a.id !== id);
  for (const [p, aid] of Object.entries(f.defaults)) {
    if (aid === id) {
      const next = f.accounts.find((a) => a.provider === p);
      if (next) f.defaults[p] = next.id;
      else delete f.defaults[p];
    }
  }
  saveAccounts(f);
  // clear any secrets this account owned (refs are prefixed with the id)
  if (acc) for (const ref of secretRefs(acc)) await deleteSecret(ref);
}

export function setDefaultAccount(provider: string, id: string): void {
  const f = loadAccounts();
  if (!f.accounts.some((a) => a.id === id && a.provider === provider)) return;
  f.defaults[provider] = id;
  saveAccounts(f);
}

export function defaultAccount(provider: string): Account | undefined {
  const f = loadAccounts();
  const id = f.defaults[provider];
  const byDefault = id ? f.accounts.find((a) => a.id === id && a.enabled) : undefined;
  return byDefault ?? f.accounts.find((a) => a.provider === provider && a.enabled);
}

export function markUsed(id: string): void {
  const f = loadAccounts();
  const a = f.accounts.find((x) => x.id === id);
  if (a) {
    a.lastUsedAt = Date.now();
    saveAccounts(f);
  }
}

/** Secret-store refs this account owns (used to clean up on removal). */
export function secretRefs(a: Account): string[] {
  const refs: string[] = [];
  const auth = a.auth;
  if (auth.kind === "api-key" || auth.kind === "azure" || auth.kind === "openai-compat") refs.push(auth.ref);
  if (auth.kind === "aws") {
    refs.push(auth.accessKeyIdRef, auth.secretKeyRef);
    if (auth.sessionTokenRef) refs.push(auth.sessionTokenRef);
  }
  if (auth.kind === "vertex" && auth.serviceAccountRef) refs.push(auth.serviceAccountRef);
  return refs;
}
