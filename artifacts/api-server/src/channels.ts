import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "./lib/logger";

export type Channel = {
  id: string;
  name: string;
  type: "global" | "public" | "private";
  createdBy: string;
  createdAt: number;
  allowedUsernames: string[];
};

const DATA_DIR = path.resolve(process.cwd(), ".data");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

const channels = new Map<string, Channel>();
let loadPromise: Promise<void> | null = null;
let persistChain: Promise<void> = Promise.resolve();

const GLOBAL_ID = "global";

function ensureGlobal(): void {
  if (!channels.has(GLOBAL_ID)) {
    channels.set(GLOBAL_ID, {
      id: GLOBAL_ID,
      name: "전체 채팅방",
      type: "global",
      createdBy: "system",
      createdAt: Date.now(),
      allowedUsernames: [],
    });
  }
}

function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await fs.readFile(CHANNELS_FILE, "utf8");
      const list = JSON.parse(raw) as Channel[];
      for (const c of list) {
        channels.set(c.id, {
          id: c.id,
          name: c.name,
          type: c.type,
          createdBy: c.createdBy,
          createdAt: c.createdAt,
          allowedUsernames: Array.isArray(c.allowedUsernames)
            ? c.allowedUsernames
            : [],
        });
      }
      logger.info({ count: channels.size }, "channels loaded");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        logger.error({ err }, "failed to load channels");
      }
    }
    ensureGlobal();
  })();
  return loadPromise;
}

function persist(): void {
  persistChain = persistChain.then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const list = Array.from(channels.values());
      await fs.writeFile(CHANNELS_FILE, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      logger.error({ err }, "failed to persist channels");
    }
  });
}

export async function loadChannels(): Promise<void> {
  await load();
}

export function listChannels(): Channel[] {
  return Array.from(channels.values()).sort((a, b) => {
    if (a.type === "global") return -1;
    if (b.type === "global") return 1;
    return a.createdAt - b.createdAt;
  });
}

export function getChannel(id: string): Channel | undefined {
  return channels.get(id);
}

export function canViewChannel(
  channel: Channel,
  ctx: { username?: string | null; isAdmin: boolean },
): boolean {
  if (channel.type !== "private") return true;
  if (ctx.isAdmin) return true;
  if (!ctx.username) return false;
  return channel.allowedUsernames.includes(ctx.username.toLowerCase());
}

export function visibleChannels(ctx: {
  username?: string | null;
  isAdmin: boolean;
}): Channel[] {
  return listChannels().filter((c) => canViewChannel(c, ctx));
}

export type ChannelOpResult = {
  ok: boolean;
  error?: string;
  channel?: Channel;
};

export function createChannel(opts: {
  name: string;
  type: "public" | "private";
  createdBy: string;
  allowedUsernames?: string[];
}): ChannelOpResult {
  const name = opts.name.trim();
  if (name.length < 1 || name.length > 30) {
    return { ok: false, error: "채널 이름은 1~30자여야 합니다." };
  }
  if (/[#@]/.test(name)) {
    return { ok: false, error: "채널 이름에 # 또는 @를 사용할 수 없습니다." };
  }
  for (const c of channels.values()) {
    if (c.name.toLowerCase() === name.toLowerCase()) {
      return { ok: false, error: "같은 이름의 채널이 이미 있습니다." };
    }
  }
  const channel: Channel = {
    id: crypto.randomBytes(8).toString("hex"),
    name,
    type: opts.type,
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    allowedUsernames:
      opts.type === "private"
        ? Array.from(
            new Set(
              (opts.allowedUsernames ?? []).map((u) => u.toLowerCase()).filter(Boolean),
            ),
          )
        : [],
  };
  channels.set(channel.id, channel);
  persist();
  return { ok: true, channel };
}

export function updateChannelMembers(
  id: string,
  allowedUsernames: string[],
): ChannelOpResult {
  const channel = channels.get(id);
  if (!channel) return { ok: false, error: "채널을 찾을 수 없습니다." };
  if (channel.type !== "private") {
    return { ok: false, error: "비공개 채널이 아닙니다." };
  }
  channel.allowedUsernames = Array.from(
    new Set(allowedUsernames.map((u) => u.toLowerCase()).filter(Boolean)),
  );
  persist();
  return { ok: true, channel };
}

export function deleteChannel(
  id: string,
): { ok: boolean; error?: string } {
  if (id === GLOBAL_ID) {
    return { ok: false, error: "전체 채팅방은 삭제할 수 없습니다." };
  }
  if (!channels.has(id)) return { ok: false, error: "채널을 찾을 수 없습니다." };
  channels.delete(id);
  persist();
  return { ok: true };
}

export const GLOBAL_CHANNEL_ID = GLOBAL_ID;
