import type http from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./lib/logger";
import {
  adminSetDisplayName,
  getAccount,
  isAdminUsername,
  isUsernameTaken,
  listPublicAccounts,
  publicAccount,
  setAccountBanned,
  setAccountMuted,
  updateAccountProfile,
  verifyToken,
  type PublicAccount,
} from "./accounts";
import {
  canViewChannel,
  createChannel,
  deleteChannel,
  getChannel,
  GLOBAL_CHANNEL_ID,
  loadChannels,
  updateChannelMembers,
  visibleChannels,
  type Channel,
} from "./channels";

type SessionUser = {
  id: string;
  username: string | null;
  nickname: string;
  isAnonymous: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  bio: string;
  avatarColor?: string;
  avatarUrl?: string;
  mutedUntil: number;
  currentChannelId: string;
};

type ChannelMessage = {
  id: string;
  channelId: string;
  user: PublicSessionUser;
  text: string;
  imageUrl?: string;
  timestamp: number;
  silent?: boolean;
  deleted?: boolean;
  deletedBy?: string;
};

type SystemMessage = {
  id: string;
  channelId: string;
  text: string;
  timestamp: number;
};

type HistoryItem =
  | { kind: "channel"; message: ChannelMessage }
  | { kind: "system"; message: SystemMessage };

type PrivateMessage = {
  id: string;
  fromId: string;
  fromNickname: string;
  fromUsername: string | null;
  toId: string;
  text: string;
  imageUrl?: string;
  timestamp: number;
  silent?: boolean;
};

export type PublicSessionUser = {
  id: string;
  username: string | null;
  nickname: string;
  isAnonymous: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  avatarColor?: string;
  avatarUrl?: string;
  bio: string;
  mutedUntil: number;
};

const HISTORY_LIMIT = 100;
const MUTE_DURATION_MS = 5 * 60 * 1000;

const sessions = new Map<string, SessionUser>();
const histories = new Map<string, HistoryItem[]>();

function ensureHistory(channelId: string): HistoryItem[] {
  let h = histories.get(channelId);
  if (!h) {
    h = [];
    histories.set(channelId, h);
  }
  return h;
}

function pushHistory(channelId: string, item: HistoryItem): void {
  const h = ensureHistory(channelId);
  h.push(item);
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sanitizeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 2000);
}

function sanitizeImageUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("/objects/")) return undefined;
  if (trimmed.length > 500) return undefined;
  return trimmed;
}

function getClientIp(socket: Socket): string {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return String(fwd[0]).split(",")[0]?.trim() || "unknown";
  }
  const addr = socket.handshake.address || "unknown";
  return addr.replace(/^::ffff:/, "");
}

function buildAnonymousNickname(ip: string): string {
  const safe =
    ip && ip !== "unknown"
      ? ip
      : `손님${Math.floor(1000 + Math.random() * 9000)}`;
  return `익명(${safe})`;
}

function toPublicUser(s: SessionUser): PublicSessionUser {
  return {
    id: s.id,
    username: s.username,
    nickname: s.nickname,
    isAnonymous: s.isAnonymous,
    isAuthenticated: s.isAuthenticated,
    isAdmin: s.isAdmin,
    avatarColor: s.avatarColor,
    avatarUrl: s.avatarUrl,
    bio: s.bio,
    mutedUntil: s.mutedUntil,
  };
}

function listOnlineUsers(): PublicSessionUser[] {
  return Array.from(sessions.values())
    .map(toPublicUser)
    .sort((a, b) => {
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      return a.nickname.localeCompare(b.nickname);
    });
}

function listOfflineMembers(): PublicAccount[] {
  const onlineUsernames = new Set(
    Array.from(sessions.values())
      .map((s) => s.username?.toLowerCase())
      .filter(Boolean) as string[],
  );
  return listPublicAccounts().filter(
    (a) => !onlineUsernames.has(a.username.toLowerCase()),
  );
}

function visibleChannelsFor(s: SessionUser): Channel[] {
  return visibleChannels({ username: s.username, isAdmin: s.isAdmin });
}

function historySliceForChannel(
  channelId: string,
  s: SessionUser,
): HistoryItem[] {
  const ch = getChannel(channelId);
  if (!ch) return [];
  if (!canViewChannel(ch, { username: s.username, isAdmin: s.isAdmin })) {
    return [];
  }
  return ensureHistory(channelId).slice();
}

function isMuted(s: SessionUser): { muted: boolean; remaining: number } {
  // Refresh from account each call so admin actions take effect immediately.
  if (s.username) {
    const a = getAccount(s.username);
    if (a) {
      s.mutedUntil = a.mutedUntil || 0;
      s.isAdmin = !!a.isAdmin;
    }
  }
  const remaining = s.mutedUntil - Date.now();
  return { muted: remaining > 0, remaining: Math.max(0, remaining) };
}

function broadcastUsers(io: SocketIOServer): void {
  io.emit("users:online", listOnlineUsers());
  io.emit("users:offline", listOfflineMembers());
}

function broadcastChannelsToAll(io: SocketIOServer): void {
  for (const sess of sessions.values()) {
    const sock = io.sockets.sockets.get(sess.id);
    if (!sock) continue;
    sock.emit("channels:list", visibleChannelsFor(sess));
  }
}

function refreshSessionFromAccount(s: SessionUser): void {
  if (!s.username) return;
  const account = getAccount(s.username);
  if (!account) return;
  s.nickname = account.displayName || account.username;
  s.bio = account.bio || "";
  s.avatarColor = account.avatarColor;
  s.avatarUrl = account.avatarUrl;
  s.isAdmin = !!account.isAdmin;
  s.mutedUntil = account.mutedUntil || 0;
}

export function attachChatServer(server: http.Server): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e6,
    pingInterval: 20000,
    pingTimeout: 25000,
  });

  // Make sure channels are loaded before serving.
  void loadChannels();

  io.on("connection", (socket: Socket) => {
    socket.on(
      "register",
      async (
        payload:
          | { mode?: "anonymous" | "account"; token?: string; nickname?: string }
          | undefined,
        ack?: (response: {
          ok: boolean;
          user?: PublicSessionUser;
          error?: string;
          users?: PublicSessionUser[];
          offlineUsers?: PublicAccount[];
          channels?: Channel[];
          activeChannelId?: string;
          history?: HistoryItem[];
        }) => void,
      ) => {
        await loadChannels();

        // If already registered, drop previous session and start fresh.
        const prev = sessions.get(socket.id);
        if (prev) {
          sessions.delete(socket.id);
        }

        const mode = payload?.mode === "account" ? "account" : "anonymous";
        let nickname = "";
        let username: string | null = null;
        let isAuthenticated = false;
        let isAnonymous = false;
        let isAdmin = false;
        let bio = "";
        let avatarColor: string | undefined;
        let avatarUrl: string | undefined;
        let mutedUntil = 0;

        if (mode === "account") {
          const verifiedUsername = verifyToken(payload?.token);
          if (!verifiedUsername) {
            ack?.({
              ok: false,
              error: "로그인 세션이 만료되었습니다. 다시 로그인해주세요.",
            });
            return;
          }
          const account = getAccount(verifiedUsername);
          if (!account) {
            ack?.({ ok: false, error: "계정을 찾을 수 없습니다." });
            return;
          }
          if (account.banned) {
            ack?.({ ok: false, error: "이 계정은 차단되었습니다." });
            return;
          }
          username = account.username;
          nickname = account.displayName || account.username;
          isAuthenticated = true;
          isAdmin = !!account.isAdmin;
          bio = account.bio || "";
          avatarColor = account.avatarColor;
          avatarUrl = account.avatarUrl;
          mutedUntil = account.mutedUntil || 0;

          // Disconnect any other socket logged in to the same account.
          for (const [sid, s] of sessions) {
            if (
              s.username &&
              s.username.toLowerCase() === username.toLowerCase()
            ) {
              const otherSocket = io.sockets.sockets.get(sid);
              sessions.delete(sid);
              if (otherSocket) {
                otherSocket.emit("forced:disconnect", {
                  reason: "다른 곳에서 로그인되었습니다.",
                });
                otherSocket.disconnect(true);
              }
            }
          }
        } else {
          isAnonymous = true;
          const requested = (payload?.nickname ?? "").trim();
          if (requested && requested.length >= 1 && requested.length <= 24) {
            nickname = requested.slice(0, 24);
          } else {
            const ip = getClientIp(socket);
            nickname = buildAnonymousNickname(ip);
          }
        }

        // Resolve nickname conflicts (only for anonymous/non-account users).
        if (!isAuthenticated) {
          let candidate = nickname;
          let attempt = 0;
          const taken = (n: string): boolean => {
            const lower = n.toLowerCase();
            if (isUsernameTaken(n)) return true;
            for (const s of sessions.values()) {
              if (s.nickname.toLowerCase() === lower) return true;
            }
            return false;
          };
          while (taken(candidate) && attempt < 6) {
            candidate = `${nickname}#${Math.floor(100 + Math.random() * 900)}`;
            attempt++;
          }
          nickname = candidate;
        }

        const user: SessionUser = {
          id: socket.id,
          username,
          nickname,
          isAnonymous,
          isAuthenticated,
          isAdmin,
          bio,
          avatarColor,
          avatarUrl,
          mutedUntil,
          currentChannelId: GLOBAL_CHANNEL_ID,
        };
        sessions.set(socket.id, user);
        socket.join(`channel:${GLOBAL_CHANNEL_ID}`);

        const channels = visibleChannelsFor(user);
        ack?.({
          ok: true,
          user: toPublicUser(user),
          users: listOnlineUsers(),
          offlineUsers: listOfflineMembers(),
          channels,
          activeChannelId: GLOBAL_CHANNEL_ID,
          history: historySliceForChannel(GLOBAL_CHANNEL_ID, user),
        });

        const sysMsg: SystemMessage = {
          id: makeId(),
          channelId: GLOBAL_CHANNEL_ID,
          text: `${nickname}${isAdmin ? " (관리자)" : ""} 님이 입장했습니다.`,
          timestamp: Date.now(),
        };
        pushHistory(GLOBAL_CHANNEL_ID, { kind: "system", message: sysMsg });
        socket.to(`channel:${GLOBAL_CHANNEL_ID}`).emit("system", sysMsg);

        broadcastUsers(io);
        logger.info(
          { id: socket.id, nickname, mode, isAdmin, username },
          "user registered",
        );
      },
    );

    socket.on(
      "channel:select",
      (
        payload: { channelId?: string } | undefined,
        ack?: (resp: {
          ok: boolean;
          error?: string;
          channelId?: string;
          history?: HistoryItem[];
        }) => void,
      ) => {
        const user = sessions.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 입장해주세요." });
          return;
        }
        const channelId =
          typeof payload?.channelId === "string" ? payload.channelId : "";
        const channel = getChannel(channelId);
        if (!channel) {
          ack?.({ ok: false, error: "채널을 찾을 수 없습니다." });
          return;
        }
        if (
          !canViewChannel(channel, {
            username: user.username,
            isAdmin: user.isAdmin,
          })
        ) {
          ack?.({ ok: false, error: "이 채널을 볼 수 없습니다." });
          return;
        }

        if (user.currentChannelId && user.currentChannelId !== channelId) {
          socket.leave(`channel:${user.currentChannelId}`);
        }
        socket.join(`channel:${channelId}`);
        user.currentChannelId = channelId;

        ack?.({
          ok: true,
          channelId,
          history: historySliceForChannel(channelId, user),
        });
      },
    );

    socket.on(
      "message:channel",
      (
        payload:
          | {
              channelId?: string;
              text?: string;
              imageUrl?: string;
              silent?: boolean;
            }
          | undefined,
        ack?: (response: { ok: boolean; error?: string }) => void,
      ) => {
        const user = sessions.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 입장해주세요." });
          return;
        }
        const muteState = isMuted(user);
        if (muteState.muted) {
          const sec = Math.ceil(muteState.remaining / 1000);
          ack?.({
            ok: false,
            error: `채팅이 차단되었습니다. ${sec}초 후 다시 시도해주세요.`,
          });
          return;
        }
        const channelId =
          typeof payload?.channelId === "string" ? payload.channelId : "";
        const channel = getChannel(channelId);
        if (!channel) {
          ack?.({ ok: false, error: "채널을 찾을 수 없습니다." });
          return;
        }
        if (
          !canViewChannel(channel, {
            username: user.username,
            isAdmin: user.isAdmin,
          })
        ) {
          ack?.({ ok: false, error: "이 채널에 메시지를 보낼 수 없습니다." });
          return;
        }
        const text = sanitizeText(payload?.text);
        const imageUrl = sanitizeImageUrl(payload?.imageUrl);
        if (!text && !imageUrl) {
          ack?.({ ok: false, error: "메시지를 입력해주세요." });
          return;
        }

        refreshSessionFromAccount(user);

        const msg: ChannelMessage = {
          id: makeId(),
          channelId,
          user: toPublicUser(user),
          text,
          ...(imageUrl ? { imageUrl } : {}),
          timestamp: Date.now(),
          silent: Boolean(payload?.silent),
        };
        pushHistory(channelId, { kind: "channel", message: msg });
        io.to(`channel:${channelId}`).emit("message:channel", msg);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "message:private",
      (
        payload:
          | {
              toId?: string;
              text?: string;
              imageUrl?: string;
              silent?: boolean;
            }
          | undefined,
        ack?: (response: {
          ok: boolean;
          error?: string;
          message?: PrivateMessage;
        }) => void,
      ) => {
        const user = sessions.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 입장해주세요." });
          return;
        }
        const muteState = isMuted(user);
        if (muteState.muted) {
          const sec = Math.ceil(muteState.remaining / 1000);
          ack?.({
            ok: false,
            error: `채팅이 차단되었습니다. ${sec}초 후 다시 시도해주세요.`,
          });
          return;
        }
        const toId = typeof payload?.toId === "string" ? payload.toId : "";
        const text = sanitizeText(payload?.text);
        const imageUrl = sanitizeImageUrl(payload?.imageUrl);
        if (!toId || !sessions.has(toId)) {
          ack?.({ ok: false, error: "받는 사용자를 찾을 수 없습니다." });
          return;
        }
        if (toId === socket.id) {
          ack?.({ ok: false, error: "자기 자신에게는 보낼 수 없습니다." });
          return;
        }
        if (!text && !imageUrl) {
          ack?.({ ok: false, error: "메시지를 입력해주세요." });
          return;
        }
        refreshSessionFromAccount(user);
        const msg: PrivateMessage = {
          id: makeId(),
          fromId: socket.id,
          fromNickname: user.nickname,
          fromUsername: user.username,
          toId,
          text,
          ...(imageUrl ? { imageUrl } : {}),
          timestamp: Date.now(),
          silent: Boolean(payload?.silent),
        };
        io.to(toId).emit("message:private", msg);
        ack?.({ ok: true, message: msg });
      },
    );

    socket.on(
      "message:delete",
      (
        payload: { messageId?: string; channelId?: string } | undefined,
        ack?: (response: { ok: boolean; error?: string }) => void,
      ) => {
        const user = sessions.get(socket.id);
        if (!user || !user.isAdmin) {
          ack?.({ ok: false, error: "관리자만 메시지를 삭제할 수 있습니다." });
          return;
        }
        const messageId =
          typeof payload?.messageId === "string" ? payload.messageId : "";
        const channelId =
          typeof payload?.channelId === "string"
            ? payload.channelId
            : GLOBAL_CHANNEL_ID;
        const history = ensureHistory(channelId);
        const entry = history.find(
          (h) => h.kind === "channel" && h.message.id === messageId,
        );
        if (!entry || entry.kind !== "channel") {
          ack?.({ ok: false, error: "메시지를 찾을 수 없습니다." });
          return;
        }
        entry.message.deleted = true;
        entry.message.deletedBy = user.nickname;
        entry.message.text = "";
        delete entry.message.imageUrl;
        io.to(`channel:${channelId}`).emit("message:deleted", {
          channelId,
          id: messageId,
          deletedBy: user.nickname,
        });
        ack?.({ ok: true });
      },
    );

    // ===== Profile / nickname =====

    socket.on(
      "profile:update",
      async (
        payload:
          | {
              displayName?: string;
              bio?: string;
              avatarColor?: string;
              avatarUrl?: string | null;
            }
          | undefined,
        ack?: (resp: {
          ok: boolean;
          error?: string;
          user?: PublicSessionUser;
        }) => void,
      ) => {
        const user = sessions.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 입장해주세요." });
          return;
        }

        if (user.username) {
          // Account user — persist
          const result = await updateAccountProfile(user.username, {
            displayName: payload?.displayName,
            bio: payload?.bio,
            avatarColor: payload?.avatarColor,
            avatarUrl: payload?.avatarUrl,
          });
          if (!result.ok) {
            ack?.({ ok: false, error: result.error });
            return;
          }
          refreshSessionFromAccount(user);
        } else {
          // Anonymous — session only
          if (typeof payload?.displayName === "string") {
            const dn = payload.displayName.trim().slice(0, 24);
            if (dn.length === 0) {
              ack?.({ ok: false, error: "표시 이름을 입력해주세요." });
              return;
            }
            // Conflict check
            const lower = dn.toLowerCase();
            if (isUsernameTaken(dn)) {
              ack?.({ ok: false, error: "이미 사용 중인 닉네임입니다." });
              return;
            }
            for (const s of sessions.values()) {
              if (s.id !== user.id && s.nickname.toLowerCase() === lower) {
                ack?.({ ok: false, error: "이미 사용 중인 닉네임입니다." });
                return;
              }
            }
            user.nickname = dn;
          }
          if (typeof payload?.bio === "string") {
            user.bio = payload.bio.slice(0, 200);
          }
          if (typeof payload?.avatarColor === "string") {
            const c = payload.avatarColor.trim();
            if (!c || /^#[0-9a-fA-F]{6}$/.test(c)) {
              user.avatarColor = c || undefined;
            }
          }
          if (payload?.avatarUrl === null || payload?.avatarUrl === "") {
            user.avatarUrl = undefined;
          } else if (
            typeof payload?.avatarUrl === "string" &&
            payload.avatarUrl.startsWith("/objects/") &&
            payload.avatarUrl.length <= 500
          ) {
            user.avatarUrl = payload.avatarUrl;
          }
        }

        ack?.({ ok: true, user: toPublicUser(user) });
        broadcastUsers(io);
      },
    );

    // ===== Admin actions =====

    socket.on(
      "admin:rename",
      async (
        payload: { targetId?: string; newName?: string } | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const target = sessions.get(payload?.targetId ?? "");
        if (!target) {
          ack?.({ ok: false, error: "대상을 찾을 수 없습니다." });
          return;
        }
        const newName = (payload?.newName ?? "").trim();
        if (newName.length < 1 || newName.length > 24) {
          ack?.({ ok: false, error: "이름은 1~24자여야 합니다." });
          return;
        }
        const lower = newName.toLowerCase();
        for (const s of sessions.values()) {
          if (s.id !== target.id && s.nickname.toLowerCase() === lower) {
            ack?.({ ok: false, error: "이미 사용 중인 이름입니다." });
            return;
          }
        }
        if (target.username) {
          const result = await adminSetDisplayName(target.username, newName);
          if (!result.ok) {
            ack?.({ ok: false, error: result.error });
            return;
          }
          refreshSessionFromAccount(target);
        } else {
          target.nickname = newName;
        }
        ack?.({ ok: true });
        const targetSocket = io.sockets.sockets.get(target.id);
        targetSocket?.emit("forced:rename", {
          newName,
          by: me.nickname,
        });
        broadcastUsers(io);
      },
    );

    socket.on(
      "admin:mute",
      async (
        payload:
          | { targetId?: string; durationMs?: number }
          | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const target = sessions.get(payload?.targetId ?? "");
        if (!target) {
          ack?.({ ok: false, error: "대상을 찾을 수 없습니다." });
          return;
        }
        if (target.isAdmin) {
          ack?.({ ok: false, error: "관리자는 음소거할 수 없습니다." });
          return;
        }
        const duration =
          typeof payload?.durationMs === "number" && payload.durationMs > 0
            ? Math.min(payload.durationMs, 24 * 60 * 60 * 1000)
            : MUTE_DURATION_MS;
        const until = Date.now() + duration;
        if (target.username) {
          await setAccountMuted(target.username, until);
        }
        target.mutedUntil = until;
        ack?.({ ok: true });
        const targetSocket = io.sockets.sockets.get(target.id);
        targetSocket?.emit("forced:mute", {
          until,
          by: me.nickname,
          durationMs: duration,
        });
        broadcastUsers(io);
      },
    );

    socket.on(
      "admin:unmute",
      async (
        payload: { targetId?: string; username?: string } | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        let username = payload?.username || null;
        const target = payload?.targetId
          ? sessions.get(payload.targetId)
          : null;
        if (target) {
          target.mutedUntil = 0;
          username = target.username;
          const targetSocket = io.sockets.sockets.get(target.id);
          targetSocket?.emit("forced:unmute", { by: me.nickname });
        }
        if (username) {
          await setAccountMuted(username, 0);
        }
        ack?.({ ok: true });
        broadcastUsers(io);
      },
    );

    socket.on(
      "admin:kick",
      (
        payload: { targetId?: string; reason?: string } | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const target = sessions.get(payload?.targetId ?? "");
        if (!target) {
          ack?.({ ok: false, error: "대상을 찾을 수 없습니다." });
          return;
        }
        if (target.isAdmin) {
          ack?.({ ok: false, error: "관리자는 강퇴할 수 없습니다." });
          return;
        }
        const reason = (payload?.reason ?? "관리자에 의해 강퇴되었습니다.")
          .toString()
          .slice(0, 200);
        const targetSocket = io.sockets.sockets.get(target.id);
        targetSocket?.emit("forced:kick", { by: me.nickname, reason });
        sessions.delete(target.id);
        targetSocket?.disconnect(true);
        ack?.({ ok: true });
        broadcastUsers(io);
      },
    );

    socket.on(
      "admin:ban",
      async (
        payload:
          | { targetId?: string; username?: string; reason?: string }
          | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        let username = payload?.username || null;
        const target = payload?.targetId
          ? sessions.get(payload.targetId)
          : null;
        if (target) {
          if (target.isAdmin) {
            ack?.({ ok: false, error: "관리자는 차단할 수 없습니다." });
            return;
          }
          username = target.username;
        }
        if (!username) {
          ack?.({
            ok: false,
            error: "익명 사용자는 차단할 수 없습니다. 강퇴를 사용하세요.",
          });
          return;
        }
        const reason = (payload?.reason ?? "").toString().slice(0, 200);
        const result = await setAccountBanned(username, true, reason);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        if (target) {
          const targetSocket = io.sockets.sockets.get(target.id);
          targetSocket?.emit("forced:ban", {
            by: me.nickname,
            reason,
          });
          sessions.delete(target.id);
          targetSocket?.disconnect(true);
        }
        ack?.({ ok: true });
        broadcastUsers(io);
      },
    );

    socket.on(
      "admin:unban",
      async (
        payload: { username?: string } | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const username = (payload?.username ?? "").trim();
        if (!username) {
          ack?.({ ok: false, error: "사용자명이 필요합니다." });
          return;
        }
        const result = await setAccountBanned(username, false);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        ack?.({ ok: true });
        broadcastUsers(io);
      },
    );

    // ===== Channel admin =====

    socket.on(
      "admin:channel:create",
      (
        payload:
          | {
              name?: string;
              type?: "public" | "private";
              allowedUsernames?: string[];
            }
          | undefined,
        ack?: (resp: {
          ok: boolean;
          error?: string;
          channel?: Channel;
        }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const name = (payload?.name ?? "").toString();
        const type = payload?.type === "private" ? "private" : "public";
        const allowed = Array.isArray(payload?.allowedUsernames)
          ? payload!.allowedUsernames!
          : [];
        const result = createChannel({
          name,
          type,
          createdBy: me.username || me.nickname,
          allowedUsernames: allowed,
        });
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        ack?.({ ok: true, channel: result.channel });
        broadcastChannelsToAll(io);
      },
    );

    socket.on(
      "admin:channel:members",
      (
        payload: { channelId?: string; allowedUsernames?: string[] } | undefined,
        ack?: (resp: {
          ok: boolean;
          error?: string;
          channel?: Channel;
        }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const channelId = payload?.channelId ?? "";
        const allowed = Array.isArray(payload?.allowedUsernames)
          ? payload!.allowedUsernames!
          : [];
        const result = updateChannelMembers(channelId, allowed);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        ack?.({ ok: true, channel: result.channel });
        broadcastChannelsToAll(io);
      },
    );

    socket.on(
      "admin:channel:delete",
      (
        payload: { channelId?: string } | undefined,
        ack?: (resp: { ok: boolean; error?: string }) => void,
      ) => {
        const me = sessions.get(socket.id);
        if (!me || !me.isAdmin) {
          ack?.({ ok: false, error: "관리자만 사용할 수 있습니다." });
          return;
        }
        const channelId = payload?.channelId ?? "";
        const result = deleteChannel(channelId);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        // Move anyone currently viewing it back to global
        for (const s of sessions.values()) {
          if (s.currentChannelId === channelId) {
            s.currentChannelId = GLOBAL_CHANNEL_ID;
            const sock = io.sockets.sockets.get(s.id);
            sock?.leave(`channel:${channelId}`);
            sock?.join(`channel:${GLOBAL_CHANNEL_ID}`);
            sock?.emit("forced:channel-removed", { channelId });
          }
        }
        histories.delete(channelId);
        ack?.({ ok: true });
        broadcastChannelsToAll(io);
      },
    );

    // ===== Misc =====

    socket.on(
      "typing",
      (payload: { isTyping?: boolean; channelId?: string } | undefined) => {
        const user = sessions.get(socket.id);
        if (!user) return;
        const channelId =
          typeof payload?.channelId === "string"
            ? payload.channelId
            : user.currentChannelId;
        socket.to(`channel:${channelId}`).emit("typing", {
          channelId,
          userId: user.id,
          nickname: user.nickname,
          isTyping: Boolean(payload?.isTyping),
        });
      },
    );

    socket.on("ping:keepalive", (_payload, ack?: (r: { ok: boolean }) => void) => {
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      const user = sessions.get(socket.id);
      if (!user) return;
      sessions.delete(socket.id);
      const sysMsg: SystemMessage = {
        id: makeId(),
        channelId: GLOBAL_CHANNEL_ID,
        text: `${user.nickname} 님이 퇴장했습니다.`,
        timestamp: Date.now(),
      };
      pushHistory(GLOBAL_CHANNEL_ID, { kind: "system", message: sysMsg });
      socket.to(`channel:${GLOBAL_CHANNEL_ID}`).emit("system", sysMsg);
      broadcastUsers(io);
      logger.info({ id: socket.id, nickname: user.nickname }, "user left");
    });
  });

  return io;
}
