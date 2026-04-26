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
  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

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
    pendingFile: null,
    pendingPreviewUrl: null,
  };

  // ===== Utility =====

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

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
    return new Date(ts).toLocaleTimeString("ko-KR", {
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

  function imageSrcFromObjectPath(objectPath) {
    if (!objectPath) return "";
    return "/api/storage" + objectPath;
  }

  // ===== Notifications =====

  function loadPrefs() {
    try {
      state.notifyEnabled = localStorage.getItem("notifyEnabled") === "1";
      state.silentMode = localStorage.getItem("silentMode") === "1";
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
    btn.classList.toggle("on", state.notifyEnabled);
    btn.classList.toggle("off", !state.notifyEnabled);
    label.textContent = state.notifyEnabled ? "켜짐" : "꺼짐";
  }

  function updateSilentButton() {
    const btn = $("#silentToggle");
    const label = $("#silentLabel");
    btn.classList.toggle("on", state.silentMode);
    btn.classList.toggle("off", !state.silentMode);
    label.textContent = state.silentMode ? "켜짐" : "꺼짐";
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

    if (me) list.appendChild(buildUserRow(me, true));
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

    if (user.isAdmin) {
      const badge = document.createElement("span");
      badge.className = "admin-badge";
      badge.textContent = "ADMIN";
      row.appendChild(badge);
    }

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
      container.appendChild(buildMessageNode(message));
      container.scrollTop = container.scrollHeight;
    }
  }

  function openLightbox(src) {
    const box = document.createElement("div");
    box.className = "lightbox";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    box.appendChild(img);
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
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
    wrap.dataset.messageId = m.id || "";
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
    meta.appendChild(author);

    if (m.authorIsAdmin) {
      const badge = document.createElement("span");
      badge.className = "admin-badge";
      badge.textContent = "ADMIN";
      meta.appendChild(badge);
    }

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(m.timestamp);
    meta.appendChild(time);

    body.appendChild(meta);

    if (m.deleted) {
      const note = document.createElement("div");
      note.className = "message-deleted";
      note.textContent =
        "[삭제된 메시지" +
        (m.deletedBy ? " · " + m.deletedBy + " 님이 삭제함" : "") +
        "]";
      body.appendChild(note);
    } else {
      if (m.text) {
        const text = document.createElement("div");
        text.className = "message-text";
        text.textContent = m.text;
        body.appendChild(text);
      }
      if (m.imageUrl) {
        const img = document.createElement("img");
        img.className = "message-image";
        img.src = imageSrcFromObjectPath(m.imageUrl);
        img.alt = "첨부 이미지";
        img.loading = "lazy";
        img.addEventListener("click", () => openLightbox(img.src));
        body.appendChild(img);
      }
    }

    wrap.appendChild(avatar);
    wrap.appendChild(body);

    // Admin can delete public messages (not their own DMs, not system, not already deleted)
    if (
      state.me &&
      state.me.isAdmin &&
      m.kind === "public" &&
      !m.deleted &&
      m.id
    ) {
      const actions = document.createElement("div");
      actions.className = "message-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "msg-action-btn";
      del.textContent = "🗑 삭제";
      del.addEventListener("click", () => deleteMessage(m.id));
      actions.appendChild(del);
      wrap.appendChild(actions);
    }

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
            id: msg.id,
            author: msg.user.nickname,
            authorId: msg.user.id,
            authorIsAdmin: !!msg.user.isAdmin,
            text: msg.text,
            imageUrl: msg.imageUrl,
            timestamp: msg.timestamp,
            deleted: !!msg.deleted,
            deletedBy: msg.deletedBy,
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
        id: msg.id,
        author: msg.user.nickname,
        authorId: msg.user.id,
        authorIsAdmin: !!msg.user.isAdmin,
        text: msg.text,
        imageUrl: msg.imageUrl,
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
            msg.text || "[이미지]",
            { tag: "public", skipIfFocused: false },
          );
        }
      }
    });

    socket.on("message:private", (msg) => {
      const item = {
        kind: "private-incoming",
        id: msg.id,
        author: msg.fromNickname,
        authorId: msg.fromId,
        text: msg.text,
        imageUrl: msg.imageUrl,
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
        showBrowserNotification("DM · " + msg.fromNickname, msg.text || "[이미지]", {
          tag: key,
          skipIfFocused: false,
        });
      }
    });

    socket.on("message:deleted", (info) => {
      const bucket = ensureBucket("global");
      const target = bucket.find((m) => m.id === info.id);
      if (target) {
        target.deleted = true;
        target.deletedBy = info.deletedBy;
        target.text = "";
        target.imageUrl = undefined;
      }
      if (state.activeChannel.type === "global") {
        const node = $("#messages").querySelector(
          '[data-message-id="' + info.id + '"]',
        );
        if (node && target) {
          const replacement = buildMessageNode(target);
          node.replaceWith(replacement);
        }
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
      try {
        const data = await res.json();
        return { ok: false, error: data.error || "서버 오류 (" + res.status + ")" };
      } catch (_) {
        return { ok: false, error: "서버 오류 (" + res.status + ")" };
      }
    }
    return res.json();
  }

  // ===== File upload =====

  function setPendingFile(file) {
    if (state.pendingPreviewUrl) {
      URL.revokeObjectURL(state.pendingPreviewUrl);
      state.pendingPreviewUrl = null;
    }
    state.pendingFile = file;
    const preview = $("#imagePreview");
    const attachBtn = $("#attachBtn");
    if (file) {
      const url = URL.createObjectURL(file);
      state.pendingPreviewUrl = url;
      $("#imagePreviewImg").src = url;
      $("#imagePreviewName").textContent =
        file.name + " (" + Math.round(file.size / 1024) + " KB)";
      preview.classList.remove("hidden");
      attachBtn.classList.add("has-file");
    } else {
      $("#imagePreviewImg").removeAttribute("src");
      $("#imagePreviewName").textContent = "";
      preview.classList.add("hidden");
      attachBtn.classList.remove("has-file");
    }
  }

  async function uploadPendingFile() {
    const file = state.pendingFile;
    if (!file) return null;
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new Error("파일이 너무 큽니다 (10MB 이하)");
    }

    const reqRes = await apiPost("/api/storage/uploads/request-url", {
      name: file.name,
      size: file.size,
      contentType: file.type,
    });
    if (!reqRes.ok && reqRes.error) {
      throw new Error(reqRes.error);
    }
    const { uploadURL, objectPath } = reqRes;
    if (!uploadURL || !objectPath) {
      throw new Error("업로드 URL을 받지 못했습니다.");
    }

    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!putRes.ok) {
      throw new Error("파일 업로드 실패 (" + putRes.status + ")");
    }
    return objectPath;
  }

  // ===== Sending =====

  async function send(text) {
    const hasFile = !!state.pendingFile;
    if (!text.trim() && !hasFile) return;

    const sendBtn = $("#messageForm .send-btn");
    sendBtn.disabled = true;

    let imageUrl;
    try {
      if (hasFile) {
        imageUrl = await uploadPendingFile();
      }
    } catch (err) {
      alert("이미지 업로드 실패: " + (err.message || err));
      sendBtn.disabled = false;
      return;
    }

    const silent = state.silentMode;

    if (state.activeChannel.type === "global") {
      state.socket.emit(
        "message:public",
        { text, imageUrl, silent },
        (resp) => {
          sendBtn.disabled = false;
          if (resp && resp.ok) {
            setPendingFile(null);
          } else {
            alert("전송 실패: " + ((resp && resp.error) || "알 수 없는 오류"));
          }
        },
      );
    } else {
      const targetId = state.activeChannel.id;
      const targetName = state.activeChannel.name;
      state.socket.emit(
        "message:private",
        { toId: targetId, text, imageUrl, silent },
        (resp) => {
          sendBtn.disabled = false;
          if (resp && resp.ok && state.me) {
            const item = {
              kind: "private-outgoing",
              id: resp.message ? resp.message.id : undefined,
              author: state.me.nickname,
              authorId: state.me.id,
              text,
              imageUrl,
              timestamp: Date.now(),
            };
            appendMessage(dmKey(targetId), item);
            setPendingFile(null);
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

  function deleteMessage(messageId) {
    if (!confirm("이 메시지를 삭제하시겠습니까?")) return;
    state.socket.emit("message:delete", { messageId }, (resp) => {
      if (!resp || !resp.ok) {
        alert("삭제 실패: " + ((resp && resp.error) || "알 수 없는 오류"));
      }
    });
  }

  // ===== Entry flows =====

  async function enterAsAccount(token) {
    await ensureSocketReady();
    return socketRegister({ mode: "account", token });
  }

  async function enterAsAnonymous() {
    await ensureSocketReady();
    return socketRegister({ mode: "anonymous" });
  }

  function showApp(resp, isAuthenticated) {
    state.me = resp.user;
    state.users = resp.users || [];
    loadHistory(resp.history || []);

    $("#meNick").textContent = state.me.nickname;
    const meAv = $("#meAvatar");
    meAv.textContent = initials(state.me.nickname);
    meAv.style.background = colorFromName(state.me.nickname);
    let status = isAuthenticated ? "로그인됨" : "익명";
    if (state.me.isAdmin) status = "관리자";
    $("#meStatus").textContent = status;

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
    setPendingFile(null);
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

    // File picker
    $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > MAX_UPLOAD_SIZE) {
        alert("파일 크기는 10MB 이하여야 합니다.");
        e.target.value = "";
        return;
      }
      setPendingFile(file);
      e.target.value = "";
    });
    $("#imagePreviewRemove").addEventListener("click", () => {
      setPendingFile(null);
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
      if (!text.trim() && !state.pendingFile) return;
      send(text);
      messageInput.value = "";
      if (typingSent && state.socket) {
        state.socket.emit("typing", { isTyping: false });
        typingSent = false;
        clearTimeout(typingDebounce);
      }
    });

    setupSocket();

    const token = getStoredToken();
    if (token) {
      enterAsAccount(token).then((reg) => {
        if (reg && reg.ok) {
          showApp(reg, true);
        } else {
          storeToken(null);
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", bindUi);
})();
