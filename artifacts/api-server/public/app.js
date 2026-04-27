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
  const ANON_NICK_KEY = "rc:anonNick";
  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

  const state = {
    socket: null,
    me: null,
    users: [],
    offlineUsers: [],
    channels: [],
    messages: {},
    unread: {},
    activeView: { kind: "channel", id: "global", name: "전체 채팅방" },
    notifyEnabled: false,
    silentMode: false,
    typingTimers: new Map(),
    pendingFile: null,
    pendingPreviewUrl: null,
    muteTimer: null,
    autoLoginAttempted: false,
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

  function userColor(u) {
    if (u && u.avatarColor) return u.avatarColor;
    return colorFromName((u && u.nickname) || (u && u.username) || "?");
  }

  function initials(name) {
    if (!name) return "?";
    const trimmed = name.trim();
    return trimmed.slice(0, 2).toUpperCase();
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function dmKey(userId) {
    return "dm:" + userId;
  }

  function viewKey(view) {
    return view.kind === "channel" ? "ch:" + view.id : "dm:" + view.id;
  }

  function ensureBucket(key) {
    if (!state.messages[key]) state.messages[key] = [];
    return state.messages[key];
  }

  function safeLocal(fn) {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  }
  const getStoredToken = () => safeLocal(() => localStorage.getItem(TOKEN_KEY)) || null;
  const getStoredAnonNick = () => safeLocal(() => localStorage.getItem(ANON_NICK_KEY)) || null;
  function storeToken(token, username) {
    safeLocal(() => {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        if (username) localStorage.setItem(USERNAME_KEY, username);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
      }
    });
  }
  function storeAnonNick(nick) {
    safeLocal(() => {
      if (nick) localStorage.setItem(ANON_NICK_KEY, nick);
      else localStorage.removeItem(ANON_NICK_KEY);
    });
  }

  function imageSrcFromObjectPath(objectPath) {
    if (!objectPath) return "";
    return "/api/storage" + objectPath;
  }

  // ===== Notifications =====

  function loadPrefs() {
    safeLocal(() => {
      state.notifyEnabled = localStorage.getItem("notifyEnabled") === "1";
      state.silentMode = localStorage.getItem("silentMode") === "1";
    });
  }

  function savePrefs() {
    safeLocal(() => {
      localStorage.setItem("notifyEnabled", state.notifyEnabled ? "1" : "0");
      localStorage.setItem("silentMode", state.silentMode ? "1" : "0");
    });
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
      alert("브라우저 설정에서 알림이 차단되어 있습니다.");
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

  // ===== Connection banner =====

  function setBanner(text, kind) {
    const b = $("#connBanner");
    if (!text) {
      b.classList.add("hidden");
      b.classList.remove("error");
      return;
    }
    b.textContent = text;
    b.classList.toggle("error", kind === "error");
    b.classList.remove("hidden");
  }

  // ===== Render: channels =====

  function renderChannels() {
    const list = $("#channelList");
    list.innerHTML = "";
    state.channels.forEach((c) => {
      const item = document.createElement("div");
      item.className = "channel-item";
      item.dataset.channelId = c.id;
      if (
        state.activeView.kind === "channel" &&
        state.activeView.id === c.id
      ) {
        item.classList.add("active");
      }
      const icon = document.createElement("span");
      icon.className = "hash";
      icon.textContent = c.type === "private" ? "🔒" : "#";
      const name = document.createElement("span");
      name.textContent = c.name;
      item.appendChild(icon);
      item.appendChild(name);

      const unread = state.unread["ch:" + c.id] || 0;
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "unread-badge";
        badge.textContent = String(unread);
        item.appendChild(badge);
      }

      if (state.me && state.me.isAdmin && c.type !== "global") {
        const actions = document.createElement("div");
        actions.className = "channel-actions";
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.title = "채널 삭제";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteChannelClick(c);
        });
        actions.appendChild(del);
        item.appendChild(actions);
      }

      item.addEventListener("click", () => openChannel(c));
      list.appendChild(item);
    });
  }

  // ===== Render: users =====

  function renderUsers() {
    const list = $("#userList");
    const offlineList = $("#offlineList");
    const meId = state.me ? state.me.id : null;
    const others = state.users.filter((u) => u.id !== meId);
    const me = state.users.find((u) => u.id === meId);

    $("#userCount").textContent = state.users.length;
    $("#offlineCount").textContent = state.offlineUsers.length;

    list.innerHTML = "";
    if (me) list.appendChild(buildUserRow(me, true, true));
    others.forEach((u) => list.appendChild(buildUserRow(u, false, true)));

    offlineList.innerHTML = "";
    state.offlineUsers.forEach((a) => {
      offlineList.appendChild(buildOfflineRow(a));
    });
  }

  function buildUserRow(user, isSelf, isOnline) {
    const row = document.createElement("div");
    row.className = "user-item " + (isOnline ? "online" : "offline");
    row.dataset.userId = user.id;
    if (
      state.activeView.kind === "dm" &&
      state.activeView.id === user.id
    ) {
      row.classList.add("active");
    }
    if (user.mutedUntil && user.mutedUntil > Date.now()) {
      row.classList.add("muted");
    }

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.style.background = userColor(user);
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
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openUserPopover(user, row, isOnline, isSelf);
    });

    return row;
  }

  function buildOfflineRow(account) {
    const row = document.createElement("div");
    row.className = "user-item offline";
    row.dataset.username = account.username;

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.style.background =
      account.avatarColor || colorFromName(account.displayName);
    avatar.textContent = initials(account.displayName);

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = account.displayName;

    row.appendChild(avatar);
    row.appendChild(name);

    if (account.isAdmin) {
      const badge = document.createElement("span");
      badge.className = "admin-badge";
      badge.textContent = "ADMIN";
      row.appendChild(badge);
    }
    if (account.banned) {
      const badge = document.createElement("span");
      badge.className = "admin-badge";
      badge.style.background = "#ed4245";
      badge.textContent = "BAN";
      row.appendChild(badge);
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openOfflineUserPopover(account, row);
    });

    return row;
  }

  // ===== Channel header =====

  function renderChannelHeader() {
    const v = state.activeView;
    const titleIcon = $("#chatTitleIcon");
    const title = $("#chatTitle");
    const subtitle = $("#chatSubtitle");
    const leaveBtn = $("#leaveDmBtn");
    const manageBtn = $("#manageMembersBtn");

    manageBtn.classList.add("hidden");

    if (v.kind === "channel") {
      const ch = state.channels.find((c) => c.id === v.id);
      const isPrivate = ch && ch.type === "private";
      titleIcon.textContent = isPrivate ? "🔒" : "#";
      title.textContent = (ch && ch.name) || v.name;
      subtitle.textContent = isPrivate
        ? "비공개 채널 (허용된 사람만 볼 수 있음)"
        : ch && ch.type === "global"
          ? "누구나 참여 가능한 공개 채널"
          : "공개 채널";
      leaveBtn.classList.add("hidden");
      if (state.me && state.me.isAdmin && isPrivate) {
        manageBtn.classList.remove("hidden");
      }
    } else {
      titleIcon.textContent = "@";
      title.textContent = v.name;
      subtitle.textContent = "1:1 비밀 채팅 (다른 사용자에게 보이지 않습니다)";
      leaveBtn.classList.remove("hidden");
    }
  }

  // ===== Render: messages =====

  function renderMessages() {
    const container = $("#messages");
    const key = viewKey(state.activeView);
    const list = ensureBucket(key);
    container.innerHTML = "";

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        state.activeView.kind === "channel"
          ? "<h3>" +
            escapeHtmlText(state.activeView.name) +
            " 에 오신 것을 환영합니다</h3><p>첫 메시지를 보내보세요.</p>"
          : "<h3>" +
            escapeHtmlText(state.activeView.name) +
            " 님과의 비밀 대화</h3><p>이곳에서 나눈 대화는 두 사람만 볼 수 있어요.</p>";
      container.appendChild(empty);
      return;
    }

    list.forEach((m) => container.appendChild(buildMessageNode(m)));
    container.scrollTop = container.scrollHeight;
  }

  function escapeHtmlText(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function appendMessage(key, message) {
    const list = ensureBucket(key);
    list.push(message);
    if (viewKey(state.activeView) === key) {
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
    avatar.style.background = m.authorColor || colorFromName(m.author);
    avatar.textContent = initials(m.author);

    const body = document.createElement("div");
    body.className = "message-body";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const author = document.createElement("span");
    author.className = "message-author";
    author.style.color = m.authorColor || colorFromName(m.author);
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

    // Author click → popover
    avatar.style.cursor = "pointer";
    author.style.cursor = "pointer";
    const openAuthorPopover = (e) => {
      if (!m.authorId) return;
      const u = state.users.find((x) => x.id === m.authorId);
      if (u) {
        openUserPopover(u, e.target, true, state.me && u.id === state.me.id);
      }
    };
    avatar.addEventListener("click", openAuthorPopover);
    author.addEventListener("click", openAuthorPopover);

    wrap.appendChild(avatar);
    wrap.appendChild(body);

    if (
      state.me &&
      state.me.isAdmin &&
      m.kind === "channel" &&
      !m.deleted &&
      m.id
    ) {
      const actions = document.createElement("div");
      actions.className = "message-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "msg-action-btn";
      del.textContent = "🗑 삭제";
      del.addEventListener("click", () => deleteMessage(m.id, m.channelId));
      actions.appendChild(del);
      wrap.appendChild(actions);
    }

    return wrap;
  }

  function loadHistoryInto(bucketKey, historyItems) {
    const bucket = ensureBucket(bucketKey);
    bucket.length = 0;
    if (Array.isArray(historyItems)) {
      historyItems.forEach((entry) => {
        if (entry.kind === "system") {
          bucket.push({
            kind: "system",
            text: entry.message.text,
            timestamp: entry.message.timestamp,
          });
        } else if (entry.kind === "channel") {
          const msg = entry.message;
          bucket.push({
            kind: "channel",
            id: msg.id,
            channelId: msg.channelId,
            author: msg.user.nickname,
            authorId: msg.user.id,
            authorIsAdmin: !!msg.user.isAdmin,
            authorColor: msg.user.avatarColor,
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

  function openChannel(channel) {
    state.activeView = {
      kind: "channel",
      id: channel.id,
      name: channel.name,
    };
    state.unread["ch:" + channel.id] = 0;
    renderChannelHeader();
    renderChannels();
    renderMessages();
    renderUsers();
    $("#typingIndicator").textContent = "";
    if (state.socket) {
      state.socket.emit(
        "channel:select",
        { channelId: channel.id },
        (resp) => {
          if (resp && resp.ok) {
            loadHistoryInto("ch:" + channel.id, resp.history);
            renderMessages();
          }
        },
      );
    }
    $("#messageInput").focus();
  }

  function openDm(user) {
    state.activeView = { kind: "dm", id: user.id, name: user.nickname };
    state.unread[dmKey(user.id)] = 0;
    renderChannelHeader();
    renderChannels();
    renderMessages();
    renderUsers();
    $("#typingIndicator").textContent = "";
    $("#messageInput").focus();
  }

  function openGlobal() {
    const global = state.channels.find((c) => c.type === "global");
    if (global) openChannel(global);
    else
      openChannel({ id: "global", name: "전체 채팅방", type: "global" });
  }

  // ===== Popovers =====

  let popoverTarget = null;
  function openUserPopover(user, anchorEl, isOnline, isSelf) {
    closePopover();
    popoverTarget = user.id;
    const pop = $("#userPopover");
    $("#popoverAvatar").textContent = initials(user.nickname);
    $("#popoverAvatar").style.background = userColor(user);
    $("#popoverName").textContent = user.nickname;
    let status = isOnline ? "온라인" : "오프라인";
    if (user.isAdmin) status = "관리자 · " + status;
    if (user.mutedUntil && user.mutedUntil > Date.now()) {
      const sec = Math.ceil((user.mutedUntil - Date.now()) / 1000);
      status += " · 음소거(" + sec + "초)";
    }
    $("#popoverStatus").textContent = status;
    const bio = $("#popoverBio");
    if (user.bio) {
      bio.textContent = user.bio;
      bio.classList.remove("empty");
    } else {
      bio.textContent = "(소개가 없습니다)";
      bio.classList.add("empty");
    }
    const actions = $("#popoverActions");
    actions.innerHTML = "";

    if (!isSelf && isOnline) {
      const dmBtn = document.createElement("button");
      dmBtn.textContent = "💬 1:1 메시지";
      dmBtn.addEventListener("click", () => {
        closePopover();
        openDm(user);
      });
      actions.appendChild(dmBtn);
    }

    if (state.me && state.me.isAdmin && !isSelf) {
      const renameBtn = document.createElement("button");
      renameBtn.textContent = "✏ 닉네임 강제 변경";
      renameBtn.addEventListener("click", () => {
        closePopover();
        openRenameModal(user);
      });
      actions.appendChild(renameBtn);

      if (!user.isAdmin) {
        const muted = user.mutedUntil && user.mutedUntil > Date.now();
        if (muted) {
          const unmuteBtn = document.createElement("button");
          unmuteBtn.textContent = "🔊 음소거 해제";
          unmuteBtn.addEventListener("click", () => {
            closePopover();
            state.socket.emit(
              "admin:unmute",
              { targetId: user.id },
              respHandler("음소거 해제"),
            );
          });
          actions.appendChild(unmuteBtn);
        } else {
          const muteBtn = document.createElement("button");
          muteBtn.textContent = "🔇 5분 채팅 차단";
          muteBtn.addEventListener("click", () => {
            closePopover();
            state.socket.emit(
              "admin:mute",
              { targetId: user.id, durationMs: 5 * 60 * 1000 },
              respHandler("음소거"),
            );
          });
          actions.appendChild(muteBtn);
        }

        const kickBtn = document.createElement("button");
        kickBtn.className = "danger";
        kickBtn.textContent = "👢 강퇴 (Kick)";
        kickBtn.addEventListener("click", () => {
          if (!confirm(user.nickname + " 님을 강퇴하시겠습니까?")) return;
          closePopover();
          state.socket.emit(
            "admin:kick",
            { targetId: user.id },
            respHandler("강퇴"),
          );
        });
        actions.appendChild(kickBtn);

        if (user.username && !user.isAnonymous) {
          const banBtn = document.createElement("button");
          banBtn.className = "danger";
          banBtn.textContent = "🚫 영구 차단 (Ban)";
          banBtn.addEventListener("click", () => {
            if (!confirm(user.nickname + " 님을 영구 차단하시겠습니까?")) return;
            closePopover();
            state.socket.emit(
              "admin:ban",
              { targetId: user.id },
              respHandler("차단"),
            );
          });
          actions.appendChild(banBtn);
        }
      }
    }

    if (actions.children.length === 0) {
      const note = document.createElement("div");
      note.style.color = "var(--text-muted)";
      note.style.fontSize = "12px";
      note.textContent = "사용 가능한 작업이 없습니다.";
      actions.appendChild(note);
    }

    pop.classList.remove("hidden");
    positionPopover(pop, anchorEl);
  }

  function openOfflineUserPopover(account, anchorEl) {
    closePopover();
    popoverTarget = "offline:" + account.username;
    const pop = $("#userPopover");
    $("#popoverAvatar").textContent = initials(account.displayName);
    $("#popoverAvatar").style.background =
      account.avatarColor || colorFromName(account.displayName);
    $("#popoverName").textContent = account.displayName;
    let status = "오프라인";
    if (account.isAdmin) status = "관리자 · " + status;
    if (account.banned) status += " · 차단됨";
    $("#popoverStatus").textContent = status;
    const bio = $("#popoverBio");
    if (account.bio) {
      bio.textContent = account.bio;
      bio.classList.remove("empty");
    } else {
      bio.textContent = "(소개가 없습니다)";
      bio.classList.add("empty");
    }
    const actions = $("#popoverActions");
    actions.innerHTML = "";

    if (state.me && state.me.isAdmin && !account.isAdmin) {
      if (account.banned) {
        const unbanBtn = document.createElement("button");
        unbanBtn.textContent = "✅ 차단 해제";
        unbanBtn.addEventListener("click", () => {
          closePopover();
          state.socket.emit(
            "admin:unban",
            { username: account.username },
            respHandler("차단 해제"),
          );
        });
        actions.appendChild(unbanBtn);
      } else {
        const banBtn = document.createElement("button");
        banBtn.className = "danger";
        banBtn.textContent = "🚫 영구 차단";
        banBtn.addEventListener("click", () => {
          if (!confirm(account.displayName + " 님을 영구 차단하시겠습니까?")) return;
          closePopover();
          state.socket.emit(
            "admin:ban",
            { username: account.username },
            respHandler("차단"),
          );
        });
        actions.appendChild(banBtn);
      }
      if (account.mutedUntil && account.mutedUntil > Date.now()) {
        const unmuteBtn = document.createElement("button");
        unmuteBtn.textContent = "🔊 음소거 해제";
        unmuteBtn.addEventListener("click", () => {
          closePopover();
          state.socket.emit(
            "admin:unmute",
            { username: account.username },
            respHandler("음소거 해제"),
          );
        });
        actions.appendChild(unmuteBtn);
      }
    }

    if (actions.children.length === 0) {
      const note = document.createElement("div");
      note.style.color = "var(--text-muted)";
      note.style.fontSize = "12px";
      note.textContent = "사용 가능한 작업이 없습니다.";
      actions.appendChild(note);
    }
    pop.classList.remove("hidden");
    positionPopover(pop, anchorEl);
  }

  function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.style.visibility = "hidden";
    pop.style.left = "0px";
    pop.style.top = "0px";
    pop.classList.remove("hidden");
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = rect.right + 8;
    let top = rect.top;
    if (left + pw > window.innerWidth - 8) {
      left = Math.max(8, rect.left - pw - 8);
    }
    if (top + ph > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - ph - 8);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.style.visibility = "";
  }

  function closePopover() {
    popoverTarget = null;
    $("#userPopover").classList.add("hidden");
  }

  function respHandler(label) {
    return (resp) => {
      if (!resp || !resp.ok) {
        alert(label + " 실패: " + ((resp && resp.error) || "알 수 없는 오류"));
      }
    };
  }

  // ===== Profile modal =====

  function openProfileModal() {
    if (!state.me) return;
    $("#profileDisplayName").value = state.me.nickname;
    $("#profileBio").value = state.me.bio || "";
    $("#profileColor").value = state.me.avatarColor || userColor(state.me);
    $("#profileError").textContent = "";
    $("#profileModal").classList.remove("hidden");
    $("#profileDisplayName").focus();
  }

  function closeProfileModal() {
    $("#profileModal").classList.add("hidden");
  }

  function saveProfile() {
    const displayName = $("#profileDisplayName").value.trim();
    const bio = $("#profileBio").value;
    const avatarColor = $("#profileColor").value;
    $("#profileError").textContent = "";
    state.socket.emit(
      "profile:update",
      { displayName, bio, avatarColor },
      (resp) => {
        if (!resp || !resp.ok) {
          $("#profileError").textContent =
            (resp && resp.error) || "저장에 실패했습니다.";
          return;
        }
        state.me = Object.assign({}, state.me, resp.user);
        if (state.me && state.me.isAnonymous) {
          storeAnonNick(state.me.nickname);
        }
        renderMeBar();
        closeProfileModal();
      },
    );
  }

  function resetProfileColor() {
    $("#profileColor").value = colorFromName(
      $("#profileDisplayName").value || "?",
    );
  }

  // ===== Channel modal =====

  function openChannelModal() {
    $("#channelName").value = "";
    $("#channelError").textContent = "";
    document.querySelectorAll('input[name="channelType"]').forEach((r) => {
      r.checked = r.value === "public";
    });
    refreshChannelMembersList();
    updateChannelTypeUI();
    $("#channelModal").classList.remove("hidden");
    $("#channelName").focus();
  }

  function closeChannelModal() {
    $("#channelModal").classList.add("hidden");
  }

  function updateChannelTypeUI() {
    const type = document.querySelector(
      'input[name="channelType"]:checked',
    ).value;
    $("#channelMembersLabel").classList.toggle("hidden", type !== "private");
  }

  function refreshChannelMembersList() {
    const list = $("#channelMembersList");
    list.innerHTML = "";
    const all = collectAllAccountUsers();
    if (all.length === 0) {
      const note = document.createElement("div");
      note.style.color = "var(--text-muted)";
      note.style.fontSize = "12px";
      note.style.padding = "6px";
      note.textContent = "가입한 사용자가 없습니다.";
      list.appendChild(note);
      return;
    }
    all.forEach((u) => {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = u.username;
      label.appendChild(cb);
      const span = document.createElement("span");
      span.textContent = u.displayName + (u.isAdmin ? " (관리자)" : "");
      label.appendChild(span);
      list.appendChild(label);
    });
  }

  function collectAllAccountUsers() {
    const map = new Map();
    state.users.forEach((u) => {
      if (u.username && !u.isAnonymous) {
        map.set(u.username.toLowerCase(), {
          username: u.username,
          displayName: u.nickname,
          isAdmin: u.isAdmin,
        });
      }
    });
    state.offlineUsers.forEach((a) => {
      if (!map.has(a.username.toLowerCase())) {
        map.set(a.username.toLowerCase(), {
          username: a.username,
          displayName: a.displayName,
          isAdmin: a.isAdmin,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  function submitChannelCreate() {
    const name = $("#channelName").value.trim();
    const type = document.querySelector(
      'input[name="channelType"]:checked',
    ).value;
    const allowedUsernames =
      type === "private"
        ? Array.from(
            $("#channelMembersList").querySelectorAll(
              "input[type=checkbox]:checked",
            ),
          ).map((cb) => cb.value)
        : [];
    $("#channelError").textContent = "";
    state.socket.emit(
      "admin:channel:create",
      { name, type, allowedUsernames },
      (resp) => {
        if (!resp || !resp.ok) {
          $("#channelError").textContent =
            (resp && resp.error) || "생성에 실패했습니다.";
          return;
        }
        closeChannelModal();
        if (resp.channel) {
          openChannel(resp.channel);
        }
      },
    );
  }

  function deleteChannelClick(channel) {
    if (!confirm("'" + channel.name + "' 채널을 삭제하시겠습니까? 메시지가 모두 사라집니다.")) return;
    state.socket.emit(
      "admin:channel:delete",
      { channelId: channel.id },
      (resp) => {
        if (!resp || !resp.ok) {
          alert("삭제 실패: " + ((resp && resp.error) || "알 수 없는 오류"));
        }
      },
    );
  }

  // ===== Members management modal =====

  function openMembersModal() {
    if (state.activeView.kind !== "channel") return;
    const channel = state.channels.find((c) => c.id === state.activeView.id);
    if (!channel || channel.type !== "private") return;
    $("#membersModalSub").textContent =
      "'" + channel.name + "' 채널을 볼 수 있는 멤버를 선택하세요.";
    $("#membersError").textContent = "";

    const list = $("#membersListEdit");
    list.innerHTML = "";
    const allowedSet = new Set(
      (channel.allowedUsernames || []).map((u) => u.toLowerCase()),
    );
    const all = collectAllAccountUsers();
    if (all.length === 0) {
      const note = document.createElement("div");
      note.style.color = "var(--text-muted)";
      note.style.fontSize = "12px";
      note.style.padding = "6px";
      note.textContent = "가입한 사용자가 없습니다.";
      list.appendChild(note);
    } else {
      all.forEach((u) => {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = u.username;
        cb.checked = allowedSet.has(u.username.toLowerCase());
        label.appendChild(cb);
        const span = document.createElement("span");
        span.textContent = u.displayName + (u.isAdmin ? " (관리자)" : "");
        label.appendChild(span);
        list.appendChild(label);
      });
    }
    $("#membersModal").classList.remove("hidden");
  }

  function closeMembersModal() {
    $("#membersModal").classList.add("hidden");
  }

  function saveMembers() {
    if (state.activeView.kind !== "channel") return;
    const channelId = state.activeView.id;
    const allowedUsernames = Array.from(
      $("#membersListEdit").querySelectorAll("input[type=checkbox]:checked"),
    ).map((cb) => cb.value);
    state.socket.emit(
      "admin:channel:members",
      { channelId, allowedUsernames },
      (resp) => {
        if (!resp || !resp.ok) {
          $("#membersError").textContent =
            (resp && resp.error) || "저장 실패";
          return;
        }
        closeMembersModal();
      },
    );
  }

  // ===== Rename modal =====

  let renameTarget = null;
  function openRenameModal(user) {
    renameTarget = user;
    $("#renameModalSub").textContent =
      "'" + user.nickname + "' 님의 새 이름을 입력하세요.";
    $("#renameInput").value = user.nickname;
    $("#renameError").textContent = "";
    $("#renameModal").classList.remove("hidden");
    $("#renameInput").focus();
    $("#renameInput").select();
  }
  function closeRenameModal() {
    renameTarget = null;
    $("#renameModal").classList.add("hidden");
  }
  function submitRename() {
    if (!renameTarget) return;
    const newName = $("#renameInput").value.trim();
    state.socket.emit(
      "admin:rename",
      { targetId: renameTarget.id, newName },
      (resp) => {
        if (!resp || !resp.ok) {
          $("#renameError").textContent =
            (resp && resp.error) || "변경에 실패했습니다.";
          return;
        }
        closeRenameModal();
      },
    );
  }

  // ===== Me bar =====

  function renderMeBar() {
    if (!state.me) return;
    $("#meNick").textContent = state.me.nickname;
    const meAv = $("#meAvatar");
    meAv.textContent = initials(state.me.nickname);
    meAv.style.background = userColor(state.me);
    let status = state.me.isAuthenticated ? "로그인됨" : "익명";
    if (state.me.isAdmin) status = "관리자";
    if (state.me.mutedUntil && state.me.mutedUntil > Date.now()) {
      const sec = Math.ceil((state.me.mutedUntil - Date.now()) / 1000);
      status += " · 음소거(" + sec + "초)";
    }
    $("#meStatus").textContent = status;
  }

  function updateMuteBanner() {
    const banner = $("#muteBanner");
    if (!state.me || !state.me.mutedUntil || state.me.mutedUntil <= Date.now()) {
      banner.classList.add("hidden");
      if (state.muteTimer) {
        clearInterval(state.muteTimer);
        state.muteTimer = null;
      }
      return;
    }
    const tick = () => {
      const remaining = state.me.mutedUntil - Date.now();
      if (remaining <= 0) {
        state.me.mutedUntil = 0;
        banner.classList.add("hidden");
        if (state.muteTimer) clearInterval(state.muteTimer);
        state.muteTimer = null;
        renderMeBar();
        return;
      }
      const sec = Math.ceil(remaining / 1000);
      banner.textContent =
        "🔇 채팅이 차단되었습니다. " + sec + "초 후 다시 보낼 수 있어요.";
    };
    banner.classList.remove("hidden");
    tick();
    if (state.muteTimer) clearInterval(state.muteTimer);
    state.muteTimer = setInterval(tick, 1000);
  }

  // ===== Socket =====

  function setupSocket() {
    if (state.socket) return state.socket;
    const socket = io({
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    state.socket = socket;

    socket.on("connect", () => {
      setBanner("");
      // Re-register on reconnect
      if (state.me) {
        const token = getStoredToken();
        const wasAuthenticated = state.me.isAuthenticated;
        const payload = wasAuthenticated
          ? { mode: "account", token }
          : { mode: "anonymous", nickname: state.me.nickname };
        socket.emit("register", payload, (resp) => {
          if (!resp || !resp.ok) {
            // Token may be expired — fall through to login screen
            if (wasAuthenticated) {
              storeToken(null);
              logout();
            }
            return;
          }
          handleRegisterResponse(resp, wasAuthenticated);
        });
      }
    });

    socket.on("connect_error", (err) => {
      $("#loginError").textContent =
        "서버 연결에 실패했습니다: " + err.message;
      if (state.me) {
        setBanner("⚠ 서버에 연결하는 중...", "error");
      }
    });

    socket.on("disconnect", (reason) => {
      if (state.me) {
        setBanner("⚠ 연결이 끊어졌습니다. 다시 연결 중... (" + reason + ")", "error");
      }
    });

    socket.on("reconnect_attempt", () => {
      if (state.me) setBanner("⚠ 다시 연결 중...", "error");
    });

    socket.on("users:online", (users) => {
      state.users = users;
      // Update self info from server
      if (state.me) {
        const me = users.find((u) => u.id === state.me.id);
        if (me) {
          state.me = Object.assign({}, state.me, me);
          renderMeBar();
          updateMuteBanner();
        }
      }
      renderUsers();
    });

    socket.on("users:offline", (offline) => {
      state.offlineUsers = offline;
      renderUsers();
    });

    socket.on("channels:list", (channels) => {
      state.channels = channels;
      renderChannels();
      // If currently viewing a channel that's no longer visible, drop to global
      if (
        state.activeView.kind === "channel" &&
        !channels.find((c) => c.id === state.activeView.id)
      ) {
        openGlobal();
      }
    });

    socket.on("system", (sys) => {
      const item = {
        kind: "system",
        text: sys.text,
        timestamp: sys.timestamp,
      };
      const key = "ch:" + sys.channelId;
      ensureBucket(key).push(item);
      if (
        state.activeView.kind === "channel" &&
        state.activeView.id === sys.channelId
      ) {
        const container = $("#messages");
        const empty = container.querySelector(".empty-state");
        if (empty) container.removeChild(empty);
        container.appendChild(buildMessageNode(item));
        container.scrollTop = container.scrollHeight;
      }
    });

    socket.on("message:channel", (msg) => {
      const isMe = state.me && msg.user.id === state.me.id;
      const item = {
        kind: "channel",
        id: msg.id,
        channelId: msg.channelId,
        author: msg.user.nickname,
        authorId: msg.user.id,
        authorIsAdmin: !!msg.user.isAdmin,
        authorColor: msg.user.avatarColor,
        text: msg.text,
        imageUrl: msg.imageUrl,
        timestamp: msg.timestamp,
      };
      const key = "ch:" + msg.channelId;
      appendMessage(key, item);

      const isViewing =
        state.activeView.kind === "channel" &&
        state.activeView.id === msg.channelId;
      if (!isMe) {
        if (!isViewing || document.visibilityState !== "visible") {
          state.unread[key] = (state.unread[key] || 0) + 1;
          renderChannels();
        }
        if (!msg.silent) {
          const channel = state.channels.find((c) => c.id === msg.channelId);
          showBrowserNotification(
            "#" + ((channel && channel.name) || "채널") + " · " + msg.user.nickname,
            msg.text || "[이미지]",
            { tag: key },
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
        state.activeView.kind === "dm" && state.activeView.id === msg.fromId;
      if (!isViewing || document.visibilityState !== "visible") {
        state.unread[key] = (state.unread[key] || 0) + 1;
        renderUsers();
      }

      if (!msg.silent) {
        showBrowserNotification(
          "DM · " + msg.fromNickname,
          msg.text || "[이미지]",
          { tag: key },
        );
      }
    });

    socket.on("message:deleted", (info) => {
      const key = "ch:" + info.channelId;
      const bucket = ensureBucket(key);
      const target = bucket.find((m) => m.id === info.id);
      if (target) {
        target.deleted = true;
        target.deletedBy = info.deletedBy;
        target.text = "";
        target.imageUrl = undefined;
      }
      if (
        state.activeView.kind === "channel" &&
        state.activeView.id === info.channelId
      ) {
        const node = $("#messages").querySelector(
          '[data-message-id="' + info.id + '"]',
        );
        if (node && target) {
          const replacement = buildMessageNode(target);
          node.replaceWith(replacement);
        }
      }
    });

    socket.on("typing", (info) => {
      if (state.activeView.kind !== "channel") return;
      if (state.activeView.id !== info.channelId) return;
      const indicator = $("#typingIndicator");
      const existing = state.typingTimers.get(info.userId);
      if (existing) clearTimeout(existing);
      if (info.isTyping) {
        indicator.textContent = info.nickname + " 님이 입력 중...";
        state.typingTimers.set(
          info.userId,
          setTimeout(() => {
            indicator.textContent = "";
            state.typingTimers.delete(info.userId);
          }, 2500),
        );
      } else {
        indicator.textContent = "";
        state.typingTimers.delete(info.userId);
      }
    });

    socket.on("forced:rename", (info) => {
      if (!state.me) return;
      state.me.nickname = info.newName;
      renderMeBar();
      alert("관리자(" + info.by + ")가 닉네임을 '" + info.newName + "'(으)로 변경했습니다.");
    });

    socket.on("forced:mute", (info) => {
      if (!state.me) return;
      state.me.mutedUntil = info.until;
      renderMeBar();
      updateMuteBanner();
    });

    socket.on("forced:unmute", () => {
      if (!state.me) return;
      state.me.mutedUntil = 0;
      renderMeBar();
      updateMuteBanner();
    });

    socket.on("forced:kick", (info) => {
      alert("관리자(" + info.by + ")에 의해 강퇴되었습니다.\n사유: " + (info.reason || "없음"));
      hardLogout();
    });

    socket.on("forced:ban", (info) => {
      alert("관리자(" + info.by + ")에 의해 영구 차단되었습니다.\n사유: " + (info.reason || "없음"));
      storeToken(null);
      hardLogout();
    });

    socket.on("forced:disconnect", (info) => {
      alert(info.reason || "연결이 종료되었습니다.");
    });

    socket.on("forced:channel-removed", () => {
      openGlobal();
    });

    return socket;
  }

  function ensureSocketReady() {
    if (!state.socket) setupSocket();
    if (state.socket.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(), 5000);
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
        (file.name || "붙여넣은 이미지") +
        " (" +
        Math.round(file.size / 1024) +
        " KB)";
      preview.classList.remove("hidden");
      attachBtn.classList.add("has-file");
    } else {
      $("#imagePreviewImg").removeAttribute("src");
      $("#imagePreviewName").textContent = "";
      preview.classList.add("hidden");
      attachBtn.classList.remove("has-file");
    }
  }

  function fileExtFromContentType(ct) {
    if (!ct) return "png";
    if (ct.includes("png")) return "png";
    if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
    if (ct.includes("gif")) return "gif";
    if (ct.includes("webp")) return "webp";
    return "png";
  }

  async function uploadPendingFile() {
    const file = state.pendingFile;
    if (!file) return null;
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new Error("파일이 너무 큽니다 (10MB 이하)");
    }
    const name =
      file.name && file.name.trim()
        ? file.name
        : "paste-" + Date.now() + "." + fileExtFromContentType(file.type);

    const reqRes = await apiPost("/api/storage/uploads/request-url", {
      name,
      size: file.size,
      contentType: file.type,
    });
    if (!reqRes.ok && reqRes.error) throw new Error(reqRes.error);
    const { uploadURL, objectPath } = reqRes;
    if (!uploadURL || !objectPath) throw new Error("업로드 URL을 받지 못했습니다.");

    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!putRes.ok) throw new Error("파일 업로드 실패 (" + putRes.status + ")");
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
      if (hasFile) imageUrl = await uploadPendingFile();
    } catch (err) {
      alert("이미지 업로드 실패: " + (err.message || err));
      sendBtn.disabled = false;
      return;
    }
    const silent = state.silentMode;

    if (state.activeView.kind === "channel") {
      state.socket.emit(
        "message:channel",
        { channelId: state.activeView.id, text, imageUrl, silent },
        (resp) => {
          sendBtn.disabled = false;
          if (resp && resp.ok) setPendingFile(null);
          else
            alert("전송 실패: " + ((resp && resp.error) || "알 수 없는 오류"));
        },
      );
    } else {
      const targetId = state.activeView.id;
      const targetName = state.activeView.name;
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
              authorColor: state.me.avatarColor,
              text,
              imageUrl,
              timestamp: Date.now(),
            };
            appendMessage(dmKey(targetId), item);
            setPendingFile(null);
          } else {
            alert(
              "DM 전송 실패: " + ((resp && resp.error) || "알 수 없는 오류"),
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

  function deleteMessage(messageId, channelId) {
    if (!confirm("이 메시지를 삭제하시겠습니까?")) return;
    state.socket.emit(
      "message:delete",
      { messageId, channelId },
      (resp) => {
        if (!resp || !resp.ok) {
          alert("삭제 실패: " + ((resp && resp.error) || "알 수 없는 오류"));
        }
      },
    );
  }

  // ===== Entry =====

  async function enterAsAccount(token) {
    await ensureSocketReady();
    return socketRegister({ mode: "account", token });
  }
  async function enterAsAnonymous(nickname) {
    await ensureSocketReady();
    return socketRegister({ mode: "anonymous", nickname });
  }

  function handleRegisterResponse(resp, isAuthenticated) {
    state.me = resp.user;
    state.users = resp.users || [];
    state.offlineUsers = resp.offlineUsers || [];
    state.channels = resp.channels || [];
    loadHistoryInto("ch:" + (resp.activeChannelId || "global"), resp.history || []);
    state.activeView = {
      kind: "channel",
      id: resp.activeChannelId || "global",
      name:
        (state.channels.find((c) => c.id === resp.activeChannelId) || {}).name ||
        "전체 채팅방",
    };

    renderMeBar();
    renderChannels();
    renderChannelHeader();
    renderUsers();
    renderMessages();
    updateMuteBanner();

    $("#addChannelBtn").classList.toggle(
      "hidden",
      !(state.me && state.me.isAdmin),
    );
    $("#loginOverlay").classList.add("hidden");
    $("#app").classList.remove("hidden");

    if (state.me && state.me.isAnonymous) {
      storeAnonNick(state.me.nickname);
    }
  }

  async function logout() {
    const token = getStoredToken();
    if (token) {
      try {
        await apiPost("/api/auth/logout", { token });
      } catch (_) {}
    }
    storeToken(null);
    hardLogout();
  }

  function hardLogout() {
    if (state.socket) {
      try {
        state.socket.disconnect();
      } catch (_) {}
      state.socket = null;
    }
    state.me = null;
    state.users = [];
    state.offlineUsers = [];
    state.channels = [];
    state.messages = {};
    state.unread = {};
    if (state.muteTimer) clearInterval(state.muteTimer);
    setPendingFile(null);
    $("#muteBanner").classList.add("hidden");
    setBanner("");
    $("#app").classList.add("hidden");
    $("#loginOverlay").classList.remove("hidden");
    $("#loginError").textContent = "";
  }

  // ===== Visibility / network reconnect =====

  function setupConnectionWatchers() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (state.socket && !state.socket.connected) {
        try {
          state.socket.connect();
        } catch (_) {}
      }
      // Force a quick keepalive to detect dead connections faster
      if (state.socket && state.socket.connected) {
        state.socket.timeout(3000).emit("ping:keepalive", null, (err) => {
          if (err) {
            try {
              state.socket.disconnect();
              state.socket.connect();
            } catch (_) {}
          }
        });
      }
    });
    window.addEventListener("online", () => {
      if (state.socket && !state.socket.connected) {
        try {
          state.socket.connect();
        } catch (_) {}
      }
    });
    window.addEventListener("offline", () => {
      if (state.me) setBanner("⚠ 인터넷 연결 끊김", "error");
    });
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

  function handlePastedImageFromEvent(e) {
    if (!e.clipboardData) return false;
    const items = e.clipboardData.items;
    if (!items) return false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        if (file.size > MAX_UPLOAD_SIZE) {
          alert("파일 크기는 10MB 이하여야 합니다.");
          continue;
        }
        e.preventDefault();
        setPendingFile(file);
        return true;
      }
    }
    return false;
  }

  function bindUi() {
    loadPrefs();
    updateNotifyButton();
    updateSilentButton();
    bindAuthTabs();
    setupConnectionWatchers();

    $("#notifyToggle").addEventListener("click", toggleNotifications);
    $("#silentToggle").addEventListener("click", toggleSilent);
    $("#leaveDmBtn").addEventListener("click", openGlobal);
    $("#logoutBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      logout();
    });
    $("#meBar").addEventListener("click", openProfileModal);

    $("#addChannelBtn").addEventListener("click", openChannelModal);
    $("#manageMembersBtn").addEventListener("click", openMembersModal);

    // Profile modal
    $("#profileCancel").addEventListener("click", closeProfileModal);
    $("#profileSave").addEventListener("click", saveProfile);
    $("#profileColorReset").addEventListener("click", resetProfileColor);
    $("#profileModal").addEventListener("click", (e) => {
      if (e.target === $("#profileModal")) closeProfileModal();
    });

    // Channel modal
    $("#channelCancel").addEventListener("click", closeChannelModal);
    $("#channelSave").addEventListener("click", submitChannelCreate);
    document.querySelectorAll('input[name="channelType"]').forEach((r) => {
      r.addEventListener("change", updateChannelTypeUI);
    });
    $("#channelModal").addEventListener("click", (e) => {
      if (e.target === $("#channelModal")) closeChannelModal();
    });

    // Members modal
    $("#membersCancel").addEventListener("click", closeMembersModal);
    $("#membersSave").addEventListener("click", saveMembers);
    $("#membersModal").addEventListener("click", (e) => {
      if (e.target === $("#membersModal")) closeMembersModal();
    });

    // Rename modal
    $("#renameCancel").addEventListener("click", closeRenameModal);
    $("#renameSave").addEventListener("click", submitRename);
    $("#renameModal").addEventListener("click", (e) => {
      if (e.target === $("#renameModal")) closeRenameModal();
    });

    // Popover close on outside click
    document.addEventListener("click", (e) => {
      const pop = $("#userPopover");
      if (pop.classList.contains("hidden")) return;
      if (pop.contains(e.target)) return;
      closePopover();
    });
    $("#popoverClose").addEventListener("click", closePopover);

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
      handleRegisterResponse(reg, true);
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
      handleRegisterResponse(reg, true);
    });

    $("#anonymousBtn").addEventListener("click", async () => {
      loginErr.textContent = "";
      const savedNick = getStoredAnonNick();
      const reg = await enterAsAnonymous(savedNick || undefined);
      if (!reg || !reg.ok) {
        loginErr.textContent = (reg && reg.error) || "입장 실패";
        return;
      }
      handleRegisterResponse(reg, false);
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
    $("#imagePreviewRemove").addEventListener("click", () => setPendingFile(null));

    const messageForm = $("#messageForm");
    const messageInput = $("#messageInput");

    let typingSent = false;
    let typingDebounce = null;

    messageInput.addEventListener("input", () => {
      if (state.activeView.kind !== "channel" || !state.socket) return;
      if (!typingSent) {
        state.socket.emit("typing", {
          isTyping: true,
          channelId: state.activeView.id,
        });
        typingSent = true;
      }
      clearTimeout(typingDebounce);
      typingDebounce = setTimeout(() => {
        state.socket.emit("typing", {
          isTyping: false,
          channelId: state.activeView.id,
        });
        typingSent = false;
      }, 1500);
    });

    // Paste image (Ctrl+V) anywhere in the chat area
    document.addEventListener("paste", (e) => {
      // Only when app is visible
      if ($("#app").classList.contains("hidden")) return;
      handlePastedImageFromEvent(e);
    });

    // Drag & drop image into composer area
    const dropZone = $(".chat-area");
    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
        }
      });
      dropZone.addEventListener("drop", (e) => {
        if (!e.dataTransfer) return;
        const file =
          e.dataTransfer.files && e.dataTransfer.files[0]
            ? e.dataTransfer.files[0]
            : null;
        if (file && file.type.startsWith("image/")) {
          e.preventDefault();
          if (file.size > MAX_UPLOAD_SIZE) {
            alert("파일 크기는 10MB 이하여야 합니다.");
            return;
          }
          setPendingFile(file);
        }
      });
    }

    messageForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = messageInput.value;
      if (!text.trim() && !state.pendingFile) return;
      send(text);
      messageInput.value = "";
      if (typingSent && state.socket) {
        state.socket.emit("typing", {
          isTyping: false,
          channelId: state.activeView.id,
        });
        typingSent = false;
        clearTimeout(typingDebounce);
      }
    });

    setupSocket();

    // Auto-login
    state.autoLoginAttempted = true;
    const token = getStoredToken();
    if (token) {
      enterAsAccount(token).then((reg) => {
        if (reg && reg.ok) handleRegisterResponse(reg, true);
        else storeToken(null);
      });
    }

    // Reposition popover on resize
    window.addEventListener("resize", closePopover);
  }

  document.addEventListener("DOMContentLoaded", bindUi);
})();
