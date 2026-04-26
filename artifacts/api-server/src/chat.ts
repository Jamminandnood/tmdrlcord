import type http from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./lib/logger";

type User = {
  id: string;
  nickname: string;
};

type PublicMessage = {
  id: string;
  user: User;
  text: string;
  timestamp: number;
  silent?: boolean;
};

type PrivateMessage = {
  id: string;
  fromId: string;
  fromNickname: string;
  toId: string;
  text: string;
  timestamp: number;
  silent?: boolean;
};

const users = new Map<string, User>();

function listUsers(): User[] {
  return Array.from(users.values()).sort((a, b) =>
    a.nickname.localeCompare(b.nickname),
  );
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().slice(0, 20);
  return trimmed.replace(/[\u0000-\u001F\u007F]/g, "");
}

function sanitizeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 2000);
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
        payload: { nickname?: string; anonymous?: boolean } | undefined,
        ack?: (response: {
          ok: boolean;
          user?: User;
          error?: string;
          users?: User[];
        }) => void,
      ) => {
        if (registered) {
          ack?.({ ok: false, error: "이미 등록된 사용자입니다." });
          return;
        }

        let nickname = sanitizeNickname(payload?.nickname);
        if (!nickname || payload?.anonymous) {
          nickname = `익명${Math.floor(1000 + Math.random() * 9000)}`;
        }

        const taken = Array.from(users.values()).some(
          (u) => u.nickname.toLowerCase() === nickname.toLowerCase(),
        );
        if (taken) {
          nickname = `${nickname}_${Math.floor(100 + Math.random() * 900)}`;
        }

        const user: User = { id: socket.id, nickname };
        users.set(socket.id, user);
        registered = true;

        socket.join("global");

        ack?.({ ok: true, user, users: listUsers() });

        socket.to("global").emit("system", {
          id: makeId(),
          text: `${nickname} 님이 입장했습니다.`,
          timestamp: Date.now(),
        });

        io.emit("users", listUsers());

        logger.info({ id: socket.id, nickname }, "user registered");
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
      socket.to("global").emit("system", {
        id: makeId(),
        text: `${user.nickname} 님이 퇴장했습니다.`,
        timestamp: Date.now(),
      });
      io.emit("users", listUsers());
      logger.info({ id: socket.id, nickname: user.nickname }, "user left");
    });
  });

  return io;
}
