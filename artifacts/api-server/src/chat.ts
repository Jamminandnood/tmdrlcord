import type http from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./lib/logger";
import { isAdminUsername, isUsernameTaken, verifyToken } from "./accounts";

type User = {
  id: string;
  nickname: string;
  isAnonymous: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
};

type PublicMessage = {
  id: string;
  user: User;
  text: string;
  imageUrl?: string;
  timestamp: number;
  silent?: boolean;
  deleted?: boolean;
  deletedBy?: string;
};

type SystemMessage = {
  id: string;
  text: string;
  timestamp: number;
};

type HistoryItem =
  | { kind: "public"; message: PublicMessage }
  | { kind: "system"; message: SystemMessage };

type PrivateMessage = {
  id: string;
  fromId: string;
  fromNickname: string;
  toId: string;
  text: string;
  imageUrl?: string;
  timestamp: number;
  silent?: boolean;
};

const HISTORY_LIMIT = 100;
const users = new Map<string, User>();
const history: HistoryItem[] = [];

function pushHistory(item: HistoryItem): void {
  history.push(item);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
}

function listUsers(): User[] {
  return Array.from(users.values()).sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return a.nickname.localeCompare(b.nickname);
  });
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

export function attachChatServer(server: http.Server): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e6,
  });

  io.on("connection", (socket: Socket) => {
    let registered = false;

    socket.on(
      "register",
      (
        payload:
          | { mode?: "anonymous" | "account"; token?: string }
          | undefined,
        ack?: (response: {
          ok: boolean;
          user?: User;
          error?: string;
          users?: User[];
          history?: HistoryItem[];
        }) => void,
      ) => {
        if (registered) {
          ack?.({ ok: false, error: "이미 등록된 사용자입니다." });
          return;
        }

        const mode = payload?.mode === "account" ? "account" : "anonymous";
        let nickname = "";
        let isAuthenticated = false;
        let isAnonymous = false;
        let isAdmin = false;

        if (mode === "account") {
          const username = verifyToken(payload?.token);
          if (!username) {
            ack?.({
              ok: false,
              error: "로그인 세션이 만료되었습니다. 다시 로그인해주세요.",
            });
            return;
          }
          nickname = username;
          isAuthenticated = true;
          isAdmin = isAdminUsername(username);
        } else {
          const ip = getClientIp(socket);
          nickname = buildAnonymousNickname(ip);
          isAnonymous = true;
        }

        const taken = Array.from(users.values()).some(
          (u) => u.nickname.toLowerCase() === nickname.toLowerCase(),
        );
        if (taken) {
          if (isAuthenticated) {
            ack?.({
              ok: false,
              error: "같은 계정으로 이미 다른 곳에서 접속 중입니다.",
            });
            return;
          }
          nickname = `${nickname}#${Math.floor(100 + Math.random() * 900)}`;
        }

        if (isAnonymous && isUsernameTaken(nickname)) {
          nickname = `${nickname}#${Math.floor(100 + Math.random() * 900)}`;
        }

        const user: User = {
          id: socket.id,
          nickname,
          isAnonymous,
          isAuthenticated,
          isAdmin,
        };
        users.set(socket.id, user);
        registered = true;

        socket.join("global");

        ack?.({
          ok: true,
          user,
          users: listUsers(),
          history: history.slice(),
        });

        const sysMsg: SystemMessage = {
          id: makeId(),
          text: `${nickname}${isAdmin ? " (관리자)" : ""} 님이 입장했습니다.`,
          timestamp: Date.now(),
        };
        pushHistory({ kind: "system", message: sysMsg });
        socket.to("global").emit("system", sysMsg);

        io.emit("users", listUsers());

        logger.info({ id: socket.id, nickname, mode, isAdmin }, "user registered");
      },
    );

    socket.on(
      "message:public",
      (
        payload:
          | { text?: string; imageUrl?: string; silent?: boolean }
          | undefined,
        ack?: (response: { ok: boolean; error?: string }) => void,
      ) => {
        const user = users.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 닉네임을 설정해주세요." });
          return;
        }
        const text = sanitizeText(payload?.text);
        const imageUrl = sanitizeImageUrl(payload?.imageUrl);
        if (!text && !imageUrl) {
          ack?.({ ok: false, error: "메시지를 입력해주세요." });
          return;
        }
        const msg: PublicMessage = {
          id: makeId(),
          user,
          text,
          ...(imageUrl ? { imageUrl } : {}),
          timestamp: Date.now(),
          silent: Boolean(payload?.silent),
        };
        pushHistory({ kind: "public", message: msg });
        io.to("global").emit("message:public", msg);
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
        const user = users.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 닉네임을 설정해주세요." });
          return;
        }
        const toId = typeof payload?.toId === "string" ? payload.toId : "";
        const text = sanitizeText(payload?.text);
        const imageUrl = sanitizeImageUrl(payload?.imageUrl);
        if (!toId || !users.has(toId)) {
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
        const msg: PrivateMessage = {
          id: makeId(),
          fromId: socket.id,
          fromNickname: user.nickname,
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
        payload: { messageId?: string } | undefined,
        ack?: (response: { ok: boolean; error?: string }) => void,
      ) => {
        const user = users.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 입장해주세요." });
          return;
        }
        if (!user.isAdmin) {
          ack?.({ ok: false, error: "관리자만 메시지를 삭제할 수 있습니다." });
          return;
        }
        const messageId =
          typeof payload?.messageId === "string" ? payload.messageId : "";
        if (!messageId) {
          ack?.({ ok: false, error: "messageId가 필요합니다." });
          return;
        }
        const entry = history.find(
          (h) => h.kind === "public" && h.message.id === messageId,
        );
        if (!entry || entry.kind !== "public") {
          ack?.({ ok: false, error: "메시지를 찾을 수 없습니다." });
          return;
        }
        entry.message.deleted = true;
        entry.message.deletedBy = user.nickname;
        entry.message.text = "";
        delete entry.message.imageUrl;

        io.to("global").emit("message:deleted", {
          id: messageId,
          deletedBy: user.nickname,
        });
        ack?.({ ok: true });
        logger.info(
          { messageId, by: user.nickname },
          "message deleted by admin",
        );
      },
    );

    socket.on("typing", (payload: { isTyping?: boolean } | undefined) => {
      const user = users.get(socket.id);
      if (!user) return;
      socket.to("global").emit("typing", {
        userId: user.id,
        nickname: user.nickname,
        isTyping: Boolean(payload?.isTyping),
      });
    });

    socket.on("disconnect", () => {
      const user = users.get(socket.id);
      if (!user) return;
      users.delete(socket.id);
      const sysMsg: SystemMessage = {
        id: makeId(),
        text: `${user.nickname} 님이 퇴장했습니다.`,
        timestamp: Date.now(),
      };
      pushHistory({ kind: "system", message: sysMsg });
      socket.to("global").emit("system", sysMsg);
      io.emit("users", listUsers());
      logger.info({ id: socket.id, nickname: user.nickname }, "user left");
    });
  });

  return io;
}
