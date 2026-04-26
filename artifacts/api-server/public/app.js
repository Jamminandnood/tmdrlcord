/* global io */
(function () {
  "use strict";

  const COLORS = [
    "#5865f2",
    "#23a559",
    "#f0b232",
    "#f23f42",
    "#9b59b6",
    "#e91e63",
    "#1abc9c",
    "#e67e22",
    "#3498db",
    "#16a085",
  ];

  const state = {
    socket: null,
    me: null,
    users: [],
    activeChannel: { type: "global", id: "global", name: "전체 채팅방" },
    messages: { global: [] }, // global + dm:userId => [messages]
    unread: {},
    notifyEnabled: false,
    silentMode: false,
    typingTimers: new Map(),
  };

  // ===== Utility =====

  function $(selector) {
    return document.querySelector(selector);
  }

  function colorFromName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  function initials(name) {
    if (!name) return "?";
    return name.trim().slice(0, 2).toUpperCase();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function dmKey(userId) {
    return "dm:" + userId;
  }

  function channelKey(channel) {
    if (channel.type === "global") return "global";
    return dmKey(channel.id);
  }

  function ensureBucket(key) {
    if (!state.messages[key]) state.messages[key] = [];
    return state.messages[key];
  }

  // ===== Notifications =====

  function loadPrefs() {
    try {
      const n = localStorage.getItem("notifyEnabled");
      const s = localStorage.getItem("silentMode");
      state.notifyEnabled = n === "1";
      state.silentMode = s === "1";
    } catch (_) {
      // ignore storage errors
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem("notifyEnabled", state.notifyEnabled ? "1" : "0");
      localStorage.setItem("silentMode", state.silentMode ? "1" : "0");
    } catch (_) {
      // ignore
    }
  }

  function updateNotifyButton() {
    const btn = $("#notifyToggle");
    const label = $("#notifyLabel");
    if (state.notifyEnabled) {
      btn.classList.add("on");
      btn.classList.remove("off");
      label.textContent = "켜짐";
    } else {
      btn.classList.add("off");
      btn.classList.remove("on");
      label.textContent = "꺼짐";
    }
  }

  function updateSilentButton() {
    const btn = $("#silentToggle");
    const label = $("#silentLabel");
    if (state.silentMode) {
      btn.classList.add("on");
      btn.classList.remove("off");
      label.textContent = "켜짐";
    } else {
      btn.classList.add("off");
      btn.classList.remove("on");
      label.textContent = "꺼짐";
    }
  }

  async function toggleNotifications() {
    if (!("Notification" in window)) {
      alert("이 브라우저는 알림 기능을 지원하지 않습니다.");
      return;
    }
    if (state.notifyEnabled) {
      // User is opting out — turn off
      state.notifyEnabled = false;
      savePrefs();
      updateNotifyButton();
      return;
    }
    // Try to enable
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission === "granted") {
      state.notifyEnabled = true;
    } else {
      state.notifyEnabled = false;
      alert(
        "브라우저 설정에서 알림이 차단되어 있습니다. 주소창 옆 자물쇠 아이콘에서 알림을 허용해주세요.",
      );
    }
    savePrefs();
    updateNotifyButton();
  }

  function toggleSilent() {
    state.silentMode = !state.silentMode;
    savePrefs();
    updateSilentButton();
  }

  function showBrowserNotification(title, body, opts) {
    if (!state.notifyEnabled) return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && opts && opts.skipIfFocused) {
      return;
    }
    try {
      // The silent flag is what the user requested as "무음 모드"
      const n = new Notification(title, {
        body,
        silent: state.silentMode,
        tag: opts && opts.tag,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch (e) {
      console.warn("notification failed", e);
    }
  }

  // ===== Rendering =====

  function renderUsers() {
    const list = $("#userList");
    const meId = state.me ? state.me.id : null;
    const others = state.users.filter((u) => u.id !== meId);
    const me = state.users.find((u) => u.id === meId);

    $("#userCount").textContent = state.users.length;

    list.innerHTML = "";

    if (me) {
      list.appendChild(buildUserRow(me, true));
    }
    others.forEach((u) => list.appendChild(buildUserRow(u, false)));
  }

  function buildUserRow(user, isSelf) {
    const row = document.createElement("div");
    row.className = "user-item";
    row.dataset.userId = user.id;
    if (
      state.activeChannel.type === "dm" &&
      state.activeChannel.id === user.id
    ) {
      row.classList.add("active");
    }

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.style.background = colorFromName(user.nickname);
    avatar.textContent = initials(user.nickname);

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = user.nickname;

    row.appendChild(avatar);
    row.appendChild(name);

    if (isSelf) {
      const tag = document.createElement("span");
      tag.className = "user-self";
      tag.textContent = "나";
      row.appendChild(tag);
    } else {
      const unread = state.unread[dmKey(user.id)] || 0;
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "unread-badge";
        badge.textContent = String(unread);
        row.appendChild(badge);
      }
      row.addEventListener("click", () => openDm(user));
    }

    return row;
  }

  function renderChannelHeader() {
    const ch = state.activeChannel;
    const titleIcon = $("#chatTitleIcon");
    const title = $("#chatTitle");
    const subtitle = $("#chatSubtitle");
    const leaveBtn = $("#leaveDmBtn");

    if (ch.type === "global") {
      titleIcon.textContent = "#";
      titleIcon.classList.remove("hidden");
      title.textContent = "전체 채팅방";
      subtitle.textContent = "누구나 참여 가능한 공개 채널";
      leaveBtn.classList.add("hidden");
      $("#channelGlobal").classList.add("active");
    } else {
      titleIcon.textContent = "@";
      title.textContent = ch.name;
      subtitle.textContent = "1:1 비밀 채팅 (다른 사용자에게 보이지 않습니다)";
      leaveBtn.classList.remove("hidden");
      $("#channelGlobal").classList.remove("active");
    }
  }

  function renderMessages() {
    const container = $("#messages");
    const key = channelKey(state.activeChannel);
    const list = ensureBucket(key);
    container.innerHTML = "";

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        state.activeChannel.type === "global"
          ? "<h3>전체 채팅방에 오신 것을 환영합니다</h3><p>첫 메시지를 보내보세요.</p>"
          : "<h3>" +
            escapeHtml(state.activeChannel.name) +
            " 님과의 비밀 대화</h3><p>이곳에서 나눈 대화는 두 사람만 볼 수 있어요.</p>";
      container.appendChild(empty);
      return;
    }

    list.forEach((m) => container.appendChild(buildMessageNode(m)));
    container.scrollTop = container.scrollHeight;
  }

  function appendMessage(key, message) {
    const list = ensureBucket(key);
    list.push(message);
    if (channelKey(state.activeChannel) === key) {
      const container = $("#messages");
      const empty = container.querySelector(".empty-state");
      if (empty) container.removeChild(empty);
      const node = buildMessageNode(message);
      container.appendChild(node);
      container.scrollTop = container.scrollHeight;
    }
  }

  function buildMessageNode(m) {
    if (m.kind === "system") {
      const node = document.createElement("div");
      node.className = "system-message";
      node.textContent = m.text;
      return node;
    }

    const wrap = document.createElement("div");
    wrap.className = "message";
    if (m.kind === "private-incoming") wrap.classList.add("private-incoming");
    if (m.kind === "private-outgoing") wrap.classList.add("private-outgoing");
    if (state.me && m.authorId === state.me.id) wrap.classList.add("self");

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.style.background = colorFromName(m.author);
    avatar.textContent = initials(m.author);

    const body = document.createElement("div");
    body.className = "message-body";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const author = document.createElement("span");
    author.className = "message-author";
    author.style.color = colorFromName(m.author);
    author.textContent = m.author;

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(m.timestamp);

    meta.appendChild(author);
    meta.appendChild(time);

    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = m.text;

    body.appendChild(meta);
    body.appendChild(text);

    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  // ===== Channel switching =====

  function openGlobal() {
    state.activeChannel = {
      type: "global",
      id: "global",
      name: "전체 채팅방",
    };
    state.unread.global = 0;
    renderChannelHeader();
    renderMessages();
    renderUsers();
    $("#typingIndicator").textContent = "";
    $("#messageInput").focus();
  }

  function openDm(user) {
    state.activeChannel = { type: "dm", id: user.id, name: user.nickname };
    state.unread[dmKey(user.id)] = 0;
    renderChannelHeader();
    renderMessages();
    renderUsers();
    $("#typingIndicator").textContent = "";
    $("#messageInput").focus();
  }

  // ===== Socket handlers =====

  function setupSocket() {
    const socket = io({ autoConnect: true });
    state.socket = socket;

    socket.on("connect_error", (err) => {
      $("#loginError").textContent = "서버 연결에 실패했습니다: " + err.message;
    });

    socket.on("users", (users) => {
      state.users = users;
      renderUsers();
    });

    socket.on("system", (sys) => {
      const item = {
        kind: "system",
        text: sys.text,
        timestamp: sys.timestamp,
      };
      ensureBucket("global").push(item);
      if (state.activeChannel.type === "global") {
        const container = $("#messages");
        const empty = container.querySelector(".empty-state");
        if (empty) container.removeChild(empty);
        container.appendChild(buildMessageNode(item));
        container.scrollTop = container.scrollHeight;
      }
    });

    socket.on("message:public", (msg) => {
      const isMe = state.me && msg.user.id === state.me.id;
      const item = {
        kind: "public",
        author: msg.user.nickname,
        authorId: msg.user.id,
        text: msg.text,
        timestamp: msg.timestamp,
      };
      appendMessage("global", item);

      if (!isMe) {
        if (
          state.activeChannel.type !== "global" ||
          document.visibilityState !== "visible"
        ) {
          state.unread.global = (state.unread.global || 0) + 1;
        }
        if (!msg.silent) {
          showBrowserNotification(
            "#전체 채팅방 · " + msg.user.nickname,
            msg.text,
            { tag: "public", skipIfFocused: false },
          );
        }
      }
    });

    socket.on("message:private", (msg) => {
      const item = {
        kind: "private-incoming",
        author: msg.fromNickname,
        authorId: msg.fromId,
        text: msg.text,
        timestamp: msg.timestamp,
      };
      const key = dmKey(msg.fromId);
      appendMessage(key, item);

      const isViewing =
        state.activeChannel.type === "dm" &&
        state.activeChannel.id === msg.fromId;
      if (!isViewing || document.visibilityState !== "visible") {
        state.unread[key] = (state.unread[key] || 0) + 1;
        renderUsers();
      }

      if (!msg.silent) {
        showBrowserNotification(
          "DM · " + msg.fromNickname,
          msg.text,
          { tag: key, skipIfFocused: false },
        );
      }
    });

    socket.on("typing", ({ userId, nickname, isTyping }) => {
      if (state.activeChannel.type !== "global") return;
      const indicator = $("#typingIndicator");
      const existing = state.typingTimers.get(userId);
      if (existing) clearTimeout(existing);
      if (isTyping) {
        indicator.textContent = nickname + " 님이 입력 중...";
        state.typingTimers.set(
          userId,
          setTimeout(() => {
            indicator.textContent = "";
            state.typingTimers.delete(userId);
          }, 2500),
        );
      } else {
        indicator.textContent = "";
        state.typingTimers.delete(userId);
      }
    });

    socket.on("disconnect", () => {
      $("#typingIndicator").textContent = "서버와의 연결이 끊어졌습니다.";
    });
  }

  function register(nickname, anonymous) {
    return new Promise((resolve) => {
      state.socket.emit(
        "register",
        { nickname, anonymous },
        (response) => resolve(response),
      );
    });
  }

  // ===== Sending =====

  function send(text) {
    if (!text.trim()) return;
    const silent = state.silentMode;
    if (state.activeChannel.type === "global") {
      state.socket.emit(
        "message:public",
        { text, silent },
        (resp) => {
          if (!resp || !resp.ok) console.warn("send failed", resp);
        },
      );
    } else {
      const targetId = state.activeChannel.id;
      const targetName = state.activeChannel.name;
      state.socket.emit(
        "message:private",
        { toId: targetId, text, silent },
        (resp) => {
          if (resp && resp.ok && state.me) {
            // Show our own outgoing DM locally (server only echoes to recipient)
            const item = {
              kind: "private-outgoing",
              author: state.me.nickname,
              authorId: state.me.id,
              text,
              timestamp: Date.now(),
            };
            appendMessage(dmKey(targetId), item);
          } else {
            alert(
              "DM 전송에 실패했습니다: " +
                ((resp && resp.error) || "알 수 없는 오류"),
            );
            // If recipient disconnected, fall back to global
            if (!state.users.find((u) => u.id === targetId)) {
              alert(targetName + " 님이 오프라인입니다.");
              openGlobal();
            }
          }
        },
      );
    }
  }

  // ===== Wiring =====

  function bindUi() {
    loadPrefs();
    updateNotifyButton();
    updateSilentButton();

    $("#notifyToggle").addEventListener("click", toggleNotifications);
    $("#silentToggle").addEventListener("click", toggleSilent);
    $("#leaveDmBtn").addEventListener("click", openGlobal);
    $("#channelGlobal").addEventListener("click", openGlobal);

    const loginForm = $("#loginForm");
    const nickInput = $("#nicknameInput");
    const anonBtn = $("#anonymousBtn");
    const loginErr = $("#loginError");

    async function performRegister(nickname, anonymous) {
      loginErr.textContent = "";
      if (!state.socket) setupSocket();

      // wait briefly for socket to connect if needed
      if (!state.socket.connected) {
        await new Promise((resolve) => {
          if (state.socket.connected) return resolve();
          const t = setTimeout(() => resolve(), 4000);
          state.socket.once("connect", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }

      const resp = await register(nickname, anonymous);
      if (!resp || !resp.ok) {
        loginErr.textContent = (resp && resp.error) || "입장에 실패했습니다.";
        return;
      }
      state.me = resp.user;
      state.users = resp.users || [];
      $("#meNick").textContent = state.me.nickname;
      const meAv = $("#meAvatar");
      meAv.textContent = initials(state.me.nickname);
      meAv.style.background = colorFromName(state.me.nickname);

      $("#loginOverlay").classList.add("hidden");
      $("#app").classList.remove("hidden");

      openGlobal();
    }

    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = nickInput.value.trim();
      if (!value) {
        loginErr.textContent =
          "닉네임을 입력하거나 '익명으로 입장' 버튼을 누르세요.";
        return;
      }
      performRegister(value, false);
    });

    anonBtn.addEventListener("click", () => {
      performRegister("", true);
    });

    // Composer
    const messageForm = $("#messageForm");
    const messageInput = $("#messageInput");

    let typingSent = false;
    let typingDebounce = null;

    messageInput.addEventListener("input", () => {
      if (state.activeChannel.type !== "global" || !state.socket) return;
      if (!typingSent) {
        state.socket.emit("typing", { isTyping: true });
        typingSent = true;
      }
      clearTimeout(typingDebounce);
      typingDebounce = setTimeout(() => {
        state.socket.emit("typing", { isTyping: false });
        typingSent = false;
      }, 1500);
    });

    messageForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = messageInput.value;
      if (!text.trim()) return;
      send(text);
      messageInput.value = "";
      if (typingSent && state.socket) {
        state.socket.emit("typing", { isTyping: false });
        typingSent = false;
        clearTimeout(typingDebounce);
      }
    });

    // Pre-create socket so the connection happens before login completes
    setupSocket();
  }

  document.addEventListener("DOMContentLoaded", bindUi);
})();
