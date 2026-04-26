import type http from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./lib/logger";
import { isUsernameTaken, verifyToken } from "./accounts";

type User = {
  id: string;
  nickname: string;
  isAnonymous: boolean;
  isAuthenticated: boolean;
};

type PublicMessage = {
  id: string;
  user: User;
  text: string;
  timestamp: number;
  silent?: boolean;
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
  return Array.from(users.values()).sort((a, b) =>
    a.nickname.localeCompare(b.nickname),
  );
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sanitizeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 2000);
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
  const safe = ip && ip !== "unknown" ? ip : `손님${Math.floor(1000 + Math.random() * 9000)}`;
  return `익명(${safe})`;
}

export function attachChatServer(server: http.Server): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: { origin: "*" },
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

        if (
          isAnonymous &&
          isUsernameTaken(nickname) &&
          // anonymous IP-style names won't collide with usernames
          // (parens disallowed), but be defensive
          !/^익명\(/.test(nickname)
        ) {
          nickname = `${nickname}#${Math.floor(100 + Math.random() * 900)}`;
        }

        const user: User = {
          id: socket.id,
          nickname,
          isAnonymous,
          isAuthenticated,
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
          text: `${nickname} 님이 입장했습니다.`,
          timestamp: Date.now(),
        };
        pushHistory({ kind: "system", message: sysMsg });
        socket.to("global").emit("system", sysMsg);

        io.emit("users", listUsers());

        logger.info({ id: socket.id, nickname, mode }, "user registered");
      },
    );

    socket.on(
      "message:public",
      (
        payload: { text?: string; silent?: boolean } | undefined,
        ack?: (response: { ok: boolean; error?: string }) => void,
      ) => {
        const user = users.get(socket.id);
        if (!user) {
          ack?.({ ok: false, error: "먼저 닉네임을 설정해주세요." });
          return;
        }
        const text = sanitizeText(payload?.text);
        if (!text) {
          ack?.({ ok: false, error: "메시지를 입력해주세요." });
          return;
        }
        const msg: PublicMessage = {
          id: makeId(),
          user,
          text,
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
          | { toId?: string; text?: string; silent?: boolean }
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
        if (!toId || !users.has(toId)) {
          ack?.({ ok: false, error: "받는 사용자를 찾을 수 없습니다." });
          return;
        }
        if (toId === socket.id) {
          ack?.({ ok: false, error: "자기 자신에게는 보낼 수 없습니다." });
          return;
        }
        if (!text) {
          ack?.({ ok: false, error: "메시지를 입력해주세요." });
          return;
        }
        const msg: PrivateMessage = {
          id: makeId(),
          fromId: socket.id,
          fromNickname: user.nickname,
          toId,
          text,
          timestamp: Date.now(),
          silent: Boolean(payload?.silent),
        };
        io.to(toId).emit("message:private", msg);
        ack?.({ ok: true, message: msg });
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
