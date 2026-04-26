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

  const TOKEN_KEY = "rc:token";
  const USERNAME_KEY = "rc:username";

  const state = {
    socket: null,
    me: null,
    users: [],
    activeChannel: { type: "global", id: "global", name: "전체 채팅방" },
    messages: { global: [] },
    unread: {},
    notifyEnabled: false,
    silentMode: false,
    typingTimers: new Map(),
  };

  // ===== Utility =====

  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.from(document.querySelectorAll(selector));
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

  function getStoredToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || null;
    } catch (_) {
      return null;
    }
  }

  function storeToken(token, username) {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        if (username) localStorage.setItem(USERNAME_KEY, username);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
      }
    } catch (_) {
      // ignore
    }
  }

  // ===== Notifications =====

  function loadPrefs() {
    try {
      const n = localStorage.getItem("notifyEnabled");
      const s = localStorage.getItem("silentMode");
      state.notifyEnabled = n === "1";
      state.silentMode = s === "1";
    } catch (_) {
      // ignore
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
      state.notifyEnabled = false;
      savePrefs();
      updateNotifyButton();
      return;
    }
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

  function loadHistory(historyItems) {
    const bucket = ensureBucket("global");
    bucket.length = 0;
    if (Array.isArray(historyItems)) {
      historyItems.forEach((entry) => {
        if (entry.kind === "system") {
          bucket.push({
            kind: "system",
            text: entry.message.text,
            timestamp: entry.message.timestamp,
          });
        } else if (entry.kind === "public") {
          const msg = entry.message;
          bucket.push({
            kind: "public",
            author: msg.user.nickname,
            authorId: msg.user.id,
            text: msg.text,
            timestamp: msg.timestamp,
          });
        }
      });
    }
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
        showBrowserNotification("DM · " + msg.fromNickname, msg.text, {
          tag: key,
          skipIfFocused: false,
        });
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

  function ensureSocketReady() {
    if (!state.socket) setupSocket();
    if (state.socket.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(), 4000);
      state.socket.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  function socketRegister(payload) {
    return new Promise((resolve) => {
      state.socket.emit("register", payload, (response) => resolve(response));
    });
  }

  // ===== Auth API =====

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: "서버 오류 (" + res.status + ")" };
    }
    return res.json();
  }

  // ===== Sending =====

  function send(text) {
    if (!text.trim()) return;
    const silent = state.silentMode;
    if (state.activeChannel.type === "global") {
      state.socket.emit("message:public", { text, silent }, (resp) => {
        if (!resp || !resp.ok) console.warn("send failed", resp);
      });
    } else {
      const targetId = state.activeChannel.id;
      const targetName = state.activeChannel.name;
      state.socket.emit(
        "message:private",
        { toId: targetId, text, silent },
        (resp) => {
          if (resp && resp.ok && state.me) {
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
            if (!state.users.find((u) => u.id === targetId)) {
              alert(targetName + " 님이 오프라인입니다.");
              openGlobal();
            }
          }
        },
      );
    }
  }

  // ===== Entry flows =====

  async function enterAsAccount(token) {
    await ensureSocketReady();
    const resp = await socketRegister({ mode: "account", token });
    return resp;
  }

  async function enterAsAnonymous() {
    await ensureSocketReady();
    const resp = await socketRegister({ mode: "anonymous" });
    return resp;
  }

  function showApp(resp, isAuthenticated) {
    state.me = resp.user;
    state.users = resp.users || [];
    loadHistory(resp.history || []);

    $("#meNick").textContent = state.me.nickname;
    const meAv = $("#meAvatar");
    meAv.textContent = initials(state.me.nickname);
    meAv.style.background = colorFromName(state.me.nickname);
    $("#meStatus").textContent = isAuthenticated ? "로그인됨" : "익명";

    $("#loginOverlay").classList.add("hidden");
    $("#app").classList.remove("hidden");

    openGlobal();
  }

  function logout() {
    storeToken(null);
    if (state.socket) {
      try {
        state.socket.disconnect();
      } catch (_) {
        // ignore
      }
      state.socket = null;
    }
    state.me = null;
    state.users = [];
    state.messages = { global: [] };
    state.unread = {};
    $("#app").classList.add("hidden");
    $("#loginOverlay").classList.remove("hidden");
    $("#loginError").textContent = "";
  }

  // ===== Wiring =====

  function bindAuthTabs() {
    const tabs = $$(".auth-tab");
    const panes = $$(".auth-pane");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const which = tab.dataset.tab;
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        panes.forEach((p) =>
          p.classList.toggle("active", p.dataset.pane === which),
        );
        $("#loginError").textContent = "";
      });
    });
  }

  function bindUi() {
    loadPrefs();
    updateNotifyButton();
    updateSilentButton();
    bindAuthTabs();

    $("#notifyToggle").addEventListener("click", toggleNotifications);
    $("#silentToggle").addEventListener("click", toggleSilent);
    $("#leaveDmBtn").addEventListener("click", openGlobal);
    $("#channelGlobal").addEventListener("click", openGlobal);
    $("#logoutBtn").addEventListener("click", logout);

    const loginErr = $("#loginError");

    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      loginErr.textContent = "";
      const username = $("#loginUsername").value.trim();
      const password = $("#loginPassword").value;
      if (!username || !password) {
        loginErr.textContent = "닉네임과 비밀번호를 모두 입력해주세요.";
        return;
      }
      const res = await apiPost("/api/auth/login", { username, password });
      if (!res.ok) {
        loginErr.textContent = res.error || "로그인 실패";
        return;
      }
      storeToken(res.token, res.username);
      const reg = await enterAsAccount(res.token);
      if (!reg || !reg.ok) {
        loginErr.textContent = (reg && reg.error) || "입장 실패";
        return;
      }
      showApp(reg, true);
    });

    $("#registerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      loginErr.textContent = "";
      const username = $("#registerUsername").value.trim();
      const password = $("#registerPassword").value;
      const confirm = $("#registerPasswordConfirm").value;
      if (password !== confirm) {
        loginErr.textContent = "비밀번호가 일치하지 않습니다.";
        return;
      }
      const res = await apiPost("/api/auth/register", { username, password });
      if (!res.ok) {
        loginErr.textContent = res.error || "회원가입 실패";
        return;
      }
      storeToken(res.token, res.username);
      const reg = await enterAsAccount(res.token);
      if (!reg || !reg.ok) {
        loginErr.textContent = (reg && reg.error) || "입장 실패";
        return;
      }
      showApp(reg, true);
    });

    $("#anonymousBtn").addEventListener("click", async () => {
      loginErr.textContent = "";
      const reg = await enterAsAnonymous();
      if (!reg || !reg.ok) {
        loginErr.textContent = (reg && reg.error) || "입장 실패";
        return;
      }
      showApp(reg, false);
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

    setupSocket();

    // Auto-login if a token exists
    const token = getStoredToken();
    if (token) {
      enterAsAccount(token).then((reg) => {
        if (reg && reg.ok) {
          showApp(reg, true);
        } else {
          // Token invalid (e.g. server restarted) — clear it
          storeToken(null);
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", bindUi);
})();
