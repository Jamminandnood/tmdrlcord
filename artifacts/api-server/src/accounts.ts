import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "./lib/logger";

type Account = {
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
};

export type AuthResult =
  | { ok: true; token: string; username: string }
  | { ok: false; error: string };

const DATA_DIR = path.resolve(process.cwd(), ".data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

const accounts = new Map<string, Account>();
const tokens = new Map<string, string>();

let loadPromise: Promise<void> | null = null;

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

async function persist(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const list = Array.from(accounts.values());
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(list, null, 2), "utf8");
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

function validatePassword(password: string): string | null {
  if (!password) return "비밀번호를 입력해주세요.";
  if (password.length < 4) return "비밀번호는 4자 이상이어야 합니다.";
  if (password.length > 100) return "비밀번호가 너무 깁니다.";
  return null;
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
  if (accounts.has(key)) {
    return { ok: false, error: "이미 사용 중인 닉네임입니다." };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const account: Account = {
    username: u,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  };
  accounts.set(key, account);
  try {
    await persist();
  } catch (err) {
    logger.error({ err }, "failed to persist accounts");
  }

  return { ok: true, token: issueToken(u), username: u };
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
  return { ok: true, token: issueToken(account.username), username: account.username };
}

export function verifyToken(token: string | undefined | null): string | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

export function isUsernameTaken(username: string): boolean {
  return accounts.has(username.toLowerCase());
}
