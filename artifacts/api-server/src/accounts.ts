import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "./lib/logger";

export type Account = {
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  isAdmin?: boolean;
  displayName?: string;
  bio?: string;
  avatarColor?: string;
  avatarUrl?: string;
  banned?: boolean;
  bannedAt?: number;
  bannedReason?: string;
  mutedUntil?: number;
};

export type PublicAccount = {
  username: string;
  displayName: string;
  isAdmin: boolean;
  bio: string;
  avatarColor?: string;
  avatarUrl?: string;
  banned: boolean;
  mutedUntil: number;
  createdAt: number;
};

export type AuthResult =
  | {
      ok: true;
      token: string;
      username: string;
      displayName: string;
      isAdmin: boolean;
    }
  | { ok: false; error: string };

const DATA_DIR = path.resolve(process.cwd(), ".data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

const accounts = new Map<string, Account>();
const tokens = new Map<string, string>();
const reservedUsernames = new Set<string>();

let loadPromise: Promise<void> | null = null;
let persistPromise: Promise<void> = Promise.resolve();

function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await fs.readFile(ACCOUNTS_FILE, "utf8");
      const list = JSON.parse(raw) as Account[];
      for (const a of list) {
        accounts.set(a.username.toLowerCase(), a);
      }
      logger.info({ count: accounts.size }, "accounts loaded");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        logger.error({ err }, "failed to load accounts");
      }
    }
  })();
  return loadPromise;
}

function persist(): Promise<void> {
  persistPromise = persistPromise.then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const list = Array.from(accounts.values());
      await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      logger.error({ err }, "failed to persist accounts");
    }
  });
  return persistPromise;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function issueToken(username: string): string {
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, username);
  return token;
}

function validateUsername(username: string): string | null {
  if (!username) return "닉네임을 입력해주세요.";
  if (username.length < 2 || username.length > 20)
    return "닉네임은 2~20자여야 합니다.";
  if (!/^[\p{L}\p{N}_\-.]+$/u.test(username))
    return "닉네임에는 글자, 숫자, _-. 만 사용할 수 있습니다.";
  return null;
}

function validateDisplayName(name: string): string | null {
  if (!name) return "표시 이름을 입력해주세요.";
  if (name.length < 1 || name.length > 24)
    return "표시 이름은 1~24자여야 합니다.";
  if (/[\u0000-\u001f\u007f]/.test(name))
    return "표시 이름에 제어 문자를 사용할 수 없습니다.";
  return null;
}

function validatePassword(password: string): string | null {
  if (!password) return "비밀번호를 입력해주세요.";
  if (password.length < 4) return "비밀번호는 4자 이상이어야 합니다.";
  if (password.length > 100) return "비밀번호가 너무 깁니다.";
  return null;
}

export function getAccount(username: string): Account | undefined {
  return accounts.get(username.toLowerCase());
}

export function publicAccount(account: Account): PublicAccount {
  return {
    username: account.username,
    displayName: account.displayName || account.username,
    isAdmin: !!account.isAdmin,
    bio: account.bio || "",
    avatarColor: account.avatarColor,
    avatarUrl: account.avatarUrl,
    banned: !!account.banned,
    mutedUntil: account.mutedUntil || 0,
    createdAt: account.createdAt,
  };
}

export function listPublicAccounts(): PublicAccount[] {
  return Array.from(accounts.values())
    .map(publicAccount)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function registerAccount(
  username: string,
  password: string,
): Promise<AuthResult> {
  await load();
  const u = (username ?? "").trim();
  const usernameErr = validateUsername(u);
  if (usernameErr) return { ok: false, error: usernameErr };
  const pwErr = validatePassword(password);
  if (pwErr) return { ok: false, error: pwErr };

  const key = u.toLowerCase();
  if (accounts.has(key) || reservedUsernames.has(key)) {
    return { ok: false, error: "이미 사용 중인 닉네임입니다." };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const account: Account = {
    username: u,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
    displayName: u,
    bio: "",
  };
  accounts.set(key, account);
  void persist();

  return {
    ok: true,
    token: issueToken(u),
    username: u,
    displayName: u,
    isAdmin: false,
  };
}

export async function loginAccount(
  username: string,
  password: string,
): Promise<AuthResult> {
  await load();
  const u = (username ?? "").trim();
  if (!u || !password) {
    return { ok: false, error: "닉네임과 비밀번호를 모두 입력해주세요." };
  }
  const account = accounts.get(u.toLowerCase());
  if (!account) {
    return { ok: false, error: "계정을 찾을 수 없습니다." };
  }
  if (account.banned) {
    return { ok: false, error: "이 계정은 차단되었습니다." };
  }
  const hash = hashPassword(password, account.salt);
  if (
    hash.length !== account.passwordHash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(account.passwordHash, "hex"),
    )
  ) {
    return { ok: false, error: "비밀번호가 올바르지 않습니다." };
  }
  return {
    ok: true,
    token: issueToken(account.username),
    username: account.username,
    displayName: account.displayName || account.username,
    isAdmin: !!account.isAdmin,
  };
}

export function verifyToken(token: string | undefined | null): string | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

export function revokeToken(token: string | undefined | null): void {
  if (!token) return;
  tokens.delete(token);
}

export function isUsernameTaken(username: string): boolean {
  return accounts.has(username.toLowerCase());
}

export function isAdminUsername(username: string): boolean {
  const account = accounts.get(username.toLowerCase());
  return Boolean(account?.isAdmin);
}

export type AccountUpdateResult = {
  ok: boolean;
  error?: string;
  account?: PublicAccount;
};

export async function updateAccountProfile(
  username: string,
  patch: {
    displayName?: string;
    bio?: string;
    avatarColor?: string;
    avatarUrl?: string | null;
  },
): Promise<AccountUpdateResult> {
  await load();
  const account = accounts.get(username.toLowerCase());
  if (!account) return { ok: false, error: "계정을 찾을 수 없습니다." };

  if (patch.displayName !== undefined) {
    const dn = patch.displayName.trim();
    const err = validateDisplayName(dn);
    if (err) return { ok: false, error: err };
    account.displayName = dn;
  }
  if (patch.bio !== undefined) {
    const bio = patch.bio.slice(0, 200);
    account.bio = bio;
  }
  if (patch.avatarColor !== undefined) {
    const c = patch.avatarColor.trim();
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) {
      return { ok: false, error: "올바른 색상 코드가 아닙니다." };
    }
    account.avatarColor = c || undefined;
  }
  if (patch.avatarUrl !== undefined) {
    if (patch.avatarUrl === null || patch.avatarUrl === "") {
      account.avatarUrl = undefined;
    } else if (
      typeof patch.avatarUrl === "string" &&
      patch.avatarUrl.startsWith("/objects/") &&
      patch.avatarUrl.length <= 500
    ) {
      account.avatarUrl = patch.avatarUrl;
    } else {
      return { ok: false, error: "올바르지 않은 이미지 경로입니다." };
    }
  }
  void persist();
  return { ok: true, account: publicAccount(account) };
}

export async function adminSetDisplayName(
  username: string,
  newDisplayName: string,
): Promise<AccountUpdateResult> {
  await load();
  const account = accounts.get(username.toLowerCase());
  if (!account) return { ok: false, error: "계정을 찾을 수 없습니다." };
  const err = validateDisplayName(newDisplayName.trim());
  if (err) return { ok: false, error: err };
  account.displayName = newDisplayName.trim();
  void persist();
  return { ok: true, account: publicAccount(account) };
}

export async function setAccountBanned(
  username: string,
  banned: boolean,
  reason?: string,
): Promise<AccountUpdateResult> {
  await load();
  const account = accounts.get(username.toLowerCase());
  if (!account) return { ok: false, error: "계정을 찾을 수 없습니다." };
  if (account.isAdmin && banned) {
    return { ok: false, error: "관리자 계정은 차단할 수 없습니다." };
  }
  account.banned = banned;
  if (banned) {
    account.bannedAt = Date.now();
    account.bannedReason = reason || "";
  } else {
    delete account.bannedAt;
    delete account.bannedReason;
  }
  void persist();
  return { ok: true, account: publicAccount(account) };
}

export async function setAccountMuted(
  username: string,
  mutedUntil: number,
): Promise<AccountUpdateResult> {
  await load();
  const account = accounts.get(username.toLowerCase());
  if (!account) return { ok: false, error: "계정을 찾을 수 없습니다." };
  if (account.isAdmin && mutedUntil > Date.now()) {
    return { ok: false, error: "관리자 계정은 음소거할 수 없습니다." };
  }
  account.mutedUntil = mutedUntil;
  void persist();
  return { ok: true, account: publicAccount(account) };
}

export async function seedAdminAccount(
  username: string,
  password: string,
): Promise<void> {
  const key = username.toLowerCase();
  reservedUsernames.add(key);

  await load();
  const existing = accounts.get(key);
  const salt = existing?.salt ?? crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);

  if (
    existing &&
    existing.passwordHash === passwordHash &&
    existing.isAdmin &&
    !existing.banned
  ) {
    return;
  }

  const account: Account = {
    username,
    passwordHash,
    salt,
    createdAt: existing?.createdAt ?? Date.now(),
    isAdmin: true,
    displayName: existing?.displayName ?? username,
    bio: existing?.bio ?? "",
    avatarColor: existing?.avatarColor,
  };
  accounts.set(key, account);
  await persist();
  logger.info({ username }, "admin account seeded");
}
