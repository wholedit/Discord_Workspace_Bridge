// Setup page. Talks only to the local setup server (same origin), never to Discord directly.
"use strict";

const KEY = new URLSearchParams(location.search).get("k") || "";
const PORTAL = "https://discord.com/developers/applications";

async function call(name, body = {}) {
  const r = await fetch("/api/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Key": KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: "서버 응답을 읽지 못했습니다." }));
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

/** Tiny DOM helper. Text is always set as text (never as HTML). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
const code = (t) => h("code", {}, t);

function copyButton(text) {
  return h("button", { class: "ghost", onclick: (e) => navigator.clipboard.writeText(text).then(() => (e.target.textContent = "복사됨")) }, "복사");
}

/** replaceChildren, skipping empty parts (it would otherwise print "null"). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

/** Run an action with the button disabled and errors shown under it. */
async function act(btn, msgEl, fn) {
  if (btn) btn.disabled = true;
  if (msgEl) {
    msgEl.className = "msg muted spin";
    msgEl.textContent = "처리 중";
  }
  try {
    const r = await fn();
    if (msgEl) {
      msgEl.className = "msg";
      msgEl.textContent = "";
    }
    return r;
  } catch (e) {
    if (msgEl) {
      msgEl.className = "msg bad";
      msgEl.textContent = "✗ " + e.message;
    }
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- status cards

let S = null; // last /api/state
let checks = null;
const app = document.getElementById("app");
const cards = {
  checks: h("section", { class: "card" }),
  run: h("section", { class: "card" }),
  ws: h("section", { class: "card" }),
  mgr: h("section", { class: "card" }),
};
const wizardBox = h("section", { class: "card", hidden: true });

function wsStateText(w) {
  if (!S.supervisor.running) return ["⚪", "실행 관리자가 꺼져 있음", "muted"];
  switch (w.state) {
    case "running":
      return w.plugin === "connected" ? ["🟢", "실행 중 · 봇 온라인", "ok"] : w.plugin === "failed" ? ["🔴", "플러그인 연결 실패", "bad"] : ["🟡", "실행 중 · 봇 연결 중", "warn"];
    case "starting":
      return ["🟡", "시작 중", "warn"];
    case "restarting":
      return ["🟠", "재시작 대기 · " + w.detail, "warn"];
    case "needs-trust":
      return ["🔐", "폴더 신뢰 확인 필요", "warn"];
    case "failed":
      return ["🔴", "실패 · " + w.detail, "bad"];
    case "stopped":
      return ["⚪", "중지됨", "muted"];
    default:
      return ["🟡", "곧 시작됨", "muted"];
  }
}

function renderChecks() {
  const c = cards.checks;
  fill(c, h("h2", {}, "1. 이 PC 점검"));
  if (!checks) {
    c.append(h("p", { class: "muted spin" }, "Node, Claude Code 로그인, Bun, 공식 디스코드 플러그인을 확인하는 중"));
    return;
  }
  const bad = checks.filter((r) => !r.ok).length;
  c.append(
    h(
      "ul",
      { class: "list" },
      checks.map((r) =>
        h(
          "li",
          { class: "check" },
          h("span", { class: r.ok ? "ok" : "bad" }, r.ok ? "✓" : "✗"),
          h("span", {}, h("b", {}, r.name), " ", h("span", { class: "muted" }, r.detail)),
          !r.ok && r.fix ? h("span", { class: "fix" }, r.fix) : null,
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h("span", { class: bad ? "bad grow" : "ok grow" }, bad ? `고칠 항목 ${bad}개. 고친 뒤 다시 점검하세요.` : "모두 준비됐습니다."),
      h("button", { class: "ghost", onclick: loadChecks }, "다시 점검"),
    ),
  );
}

async function loadChecks() {
  checks = null;
  renderChecks();
  checks = await call("checks").catch((e) => [{ name: "점검 실패", ok: false, detail: e.message }]);
  renderChecks();
}

function renderRun() {
  const c = cards.run;
  const sv = S.supervisor;
  const msg = h("div", { class: "msg" });
  const btns = sv.running
    ? [
        h("button", { class: "ghost", onclick: (e) => act(e.target, msg, () => call("supervisor/restart")).then(refresh) }, "다시 시작"),
        h("button", { class: "danger", onclick: (e) => confirm("모든 워크스페이스가 꺼집니다. 중지할까요?") && act(e.target, msg, () => call("supervisor/stop")).then(refresh) }, "중지"),
      ]
    : [h("button", { onclick: (e) => act(e.target, msg, () => call("supervisor/start")).then(refresh) }, "백그라운드로 시작")];
  const as = S.autostart;
  fill(c, 
    h("h2", {}, "2. 실행"),
    h(
      "div",
      { class: "row" },
      h("span", { class: "grow" }, sv.running ? h("span", { class: "ok" }, `🟢 실행 관리자 실행 중 (pid ${sv.pid})`) : h("span", { class: "muted" }, "⚪ 실행 관리자가 꺼져 있습니다")),
      ...btns,
    ),
    msg,
    sv.running && sv.awake !== null ? h("p", { class: "muted" }, sv.awake ? "☕ 절전 방지 켜짐: 실행 중에는 PC가 잠자기에 들어가지 않습니다 (화면은 꺼질 수 있음)." : "절전 방지 꺼짐") : null,
    as.supported ? renderAutostart(as) : h("p", { class: "muted" }, "자동 시작은 지금은 Windows만 지원합니다."),
    h("p", { class: "muted" }, "백그라운드 실행 로그: ", code(sv.log)),
  );
}

function renderAutostart(as) {
  const msg = h("div", { class: "msg" });
  const toggle = (on) => (e) =>
    act(e.target, msg, async () => {
      const r = await call("autostart", { on });
      if (!r.ok) throw new Error(r.detail);
    }).then(refresh);
  return h(
    "div",
    {},
    h(
      "div",
      { class: "row" },
      h("span", { class: "grow" }, h("b", {}, "PC를 켜면 자동 시작: "), as.enabled ? h("span", { class: as.sameFolder ? "ok" : "warn" }, as.detail) : h("span", { class: "muted" }, "꺼짐")),
      as.enabled && as.sameFolder ? h("button", { class: "ghost", onclick: toggle(false) }, "끄기") : h("button", { onclick: toggle(true) }, as.enabled ? "이 폴더로 다시 등록" : "켜기"),
    ),
    msg,
    h(
      "p",
      { class: "muted" },
      "Windows에 로그인하면 30초 뒤 창 없이 시작됩니다 (관리자 권한·비밀번호 저장 없음). 업데이트로 재부팅된 뒤에도 자동으로 로그인되게 하려면 Windows 설정 → 계정 → 로그인 옵션 → '업데이트 또는 다시 시작한 후 내 로그인 정보를 사용하여 자동으로 설정 완료'를 켜 두세요.",
    ),
  );
}

function renderWorkspaces() {
  const c = cards.ws;
  const items = S.workspaces.map((w) => {
    const [icon, text, cls] = wsStateText(w);
    const msg = h("div", { class: "msg" });
    return h(
      "li",
      {},
      h(
        "div",
        { class: "row" },
        h("span", { class: "grow" }, h("b", {}, w.name), " ", h("span", { class: "pill" }, w.mode), " #", w.channelName, " → ", code(w.folder)),
        w.state === "needs-trust" || w.trusting
          ? h("button", { disabled: w.trusting, onclick: (e) => act(e.target, msg, () => call("trust", { name: w.name })).then(refresh) }, w.trusting ? "신뢰 확인 창 열림" : "폴더 신뢰 확인")
          : null,
        h("button", { class: "danger", onclick: (e) => confirm(`"${w.name}" 워크스페이스를 삭제할까요? 저장된 봇 토큰도 지워집니다. (디스코드의 봇과 폴더는 그대로)`) && act(e.target, msg, () => call("workspace/remove", { name: w.name })).then(refresh) }, "삭제"),
      ),
      h("div", { class: cls }, icon, " ", text),
      w.state === "needs-trust" || w.trusting ? trustHelp() : null,
      msg,
    );
  });
  fill(c, 
    h("h2", {}, "3. 워크스페이스 ", h("span", { class: "pill" }, `${S.workspaces.length}개`)),
    S.workspaces.length ? h("ul", { class: "list" }, items) : h("p", { class: "muted" }, "아직 없습니다. 아래 버튼으로 첫 워크스페이스를 연결하세요."),
    h("div", { class: "row" }, h("button", { onclick: () => startWizard("workspace"), disabled: W !== null }, "+ 워크스페이스 추가")),
  );
}

function trustHelp() {
  return h(
    "ol",
    { class: "muted" },
    h("li", {}, "PC에 새로 뜬 창에서 ", h("b", {}, "Yes, I trust this folder"), "를 고릅니다."),
    h("li", {}, code("/exit"), "를 입력하거나 창을 닫습니다. 그러면 자동으로 다시 시작됩니다."),
  );
}

function renderManager() {
  const c = cards.mgr;
  const m = S.manager;
  const msg = h("div", { class: "msg" });
  const stateText = !m ? null : !S.supervisor.running ? ["muted", "실행 관리자가 꺼져 있음"] : m.state === "online" ? ["ok", "🟢 온라인"] : m.state === "error" ? ["bad", "🔴 시작 실패 (토큰 확인)"] : ["warn", "🟡 곧 시작됨"];
  fill(c, 
    h("h2", {}, "4. 관리용 봇 ", h("span", { class: "pill" }, "선택")),
    h("p", { class: "muted" }, "#control 채널에서 /dashboard, /restart, /stop, /mode 같은 명령과 장애 알림을 받는 봇입니다. Claude와는 통신하지 않습니다."),
    m
      ? h(
          "div",
          { class: "row" },
          h("span", { class: "grow" }, h("b", {}, m.botName), " · #", m.channelName, " · ", h("span", { class: stateText[0] }, stateText[1])),
          h("button", { class: "ghost", onclick: () => startWizard("manager"), disabled: W !== null }, "바꾸기"),
          h("button", { class: "danger", onclick: (e) => confirm("관리용 봇 설정을 지울까요?") && act(e.target, msg, () => call("manager/remove")).then(refresh) }, "삭제"),
        )
      : h("div", { class: "row" }, h("button", { onclick: () => startWizard("manager"), disabled: W !== null }, "+ 관리용 봇 추가")),
    msg,
  );
}

function renderCards() {
  if (!S) return;
  renderRun();
  renderWorkspaces();
  renderManager();
  if (W && W.step === "run") renderWizard();
}

async function refresh() {
  try {
    S = await call("state");
    renderCards();
  } catch (e) {
    app.replaceChildren(h("section", { class: "card bad" }, "설정 서버에 연결할 수 없습니다: " + e.message + " — 터미널에서 npm run setup을 다시 실행하세요."));
    clearInterval(poll);
  }
}

// ---------------------------------------------------------------- wizard

let W = null; // the bot being added
let wTimer = null;
const STEPS = {
  workspace: ["create", "token", "settings", "invite", "channel", "folder", "owner", "save", "run"],
  manager: ["create", "token", "settings", "invite", "channel", "owner", "save", "run"],
};
const TITLES = {
  create: "봇 만들기",
  token: "봇 토큰 붙여 넣기",
  settings: "봇 설정 확인",
  invite: "서버에 초대",
  channel: "채널 고르기",
  folder: "작업 폴더",
  owner: "내 디스코드 계정",
  save: "저장",
  run: "첫 실행",
};

function startWizard(kind) {
  W = { kind, step: "create", userChoice: "owner" };
  wizardBox.hidden = false;
  renderCards();
  renderWizard();
  wizardBox.scrollIntoView({ behavior: "smooth" });
}

function closeWizard() {
  clearInterval(wTimer);
  W = null;
  wizardBox.hidden = true;
  renderCards();
}

function go(step) {
  W.step = step;
  clearInterval(wTimer);
  wTimer = null;
  if (step === "settings") {
    checkSettings();
    wTimer = setInterval(checkSettings, 4000);
  }
  if (step === "invite") {
    checkGuilds();
    wTimer = setInterval(checkGuilds, 3000);
  }
  renderWizard();
}

async function checkSettings() {
  try {
    W.settings = await call("bot/settings", { draft: W.draft });
    if (W.settings.intent && !W.settings.public) return go("invite");
  } catch (e) {
    W.settingsError = e.message;
  }
  if (W.step === "settings") renderWizard();
}

async function checkGuilds() {
  try {
    const g = await call("bot/guilds", { draft: W.draft });
    W.invite = g.invite;
    W.guilds = g.guilds;
    if (g.guilds.length && W.step === "invite") {
      W.guildId = W.guildId || g.preferred || g.guilds[0].id;
      if (g.guilds.length === 1) {
        await loadChannels();
        return go("channel");
      }
      clearInterval(wTimer); // several servers: let the person pick
    }
  } catch (e) {
    W.guildError = e.message;
  }
  if (W.step === "invite") renderWizard();
}

async function loadChannels() {
  const r = await call("bot/channels", { draft: W.draft, guildId: W.guildId });
  W.channels = r.channels;
  W.owner = r.owner;
  W.current = r.current;
  if (!W.channelId || !r.channels.some((c) => c.id === W.channelId && !c.takenBy)) W.channelId = r.suggestedChannel;
  if (r.current) {
    W.folder = W.folder || r.current.folder;
    W.name = W.name || r.current.name;
    W.mode = W.mode || r.current.mode;
  }
}

function stepBox(key, body) {
  const order = STEPS[W.kind];
  const i = order.indexOf(key);
  const cur = order.indexOf(W.step);
  const cls = i < cur ? "step done" : i === cur ? "step active" : "step locked";
  return h("div", { class: cls }, h("h3", {}, `${i < cur ? "✓" : i + 1 + "."} ${TITLES[key]}`), i <= cur ? body() : null);
}

function renderWizard() {
  if (!W) return;
  const isMgr = W.kind === "manager";
  const order = STEPS[W.kind];
  fill(wizardBox, 
    h("h2", {}, isMgr ? "관리용 봇 추가" : "워크스페이스 추가", h("span", { class: "grow" }), W.step !== "run" ? h("button", { class: "ghost", onclick: closeWizard }, "취소") : null),
    ...order.map((k) => stepBox(k, STEP_BODY[k])),
  );
}

const STEP_BODY = {
  create: () =>
    h(
      "div",
      {},
      h(
        "ol",
        {},
        h("li", {}, link(PORTAL, "디스코드 개발자 포털"), "에서 ", h("b", {}, "New Application"), " → 이름 입력 (예: ", W.kind === "manager" ? "manager-bot" : "web-bot", ") → Create"),
        h("li", {}, "왼쪽 메뉴 ", h("b", {}, "Bot"), " → ", h("b", {}, "Reset Token"), " → 토큰 복사"),
        W.kind === "manager"
          ? h("li", {}, "관리용 봇은 워크스페이스 봇과 ", h("b", {}, "다른 봇"), "이어야 합니다. Message Content Intent는 필요 없습니다.")
          : h("li", {}, "워크스페이스마다 ", h("b", {}, "봇을 하나씩"), " 만듭니다 (봇 하나 = 채널 하나 = 폴더 하나)."),
      ),
      W.step === "create" ? h("button", { onclick: () => go("token") }, "토큰을 복사했어요") : null,
    ),
  token: () => {
    if (W.bot)
      return h("div", {}, h("span", { class: "ok" }, "✓ 봇: ", h("b", {}, W.bot.name)), W.note ? h("div", { class: "warn msg" }, W.note) : null);
    const input = h("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: "봇 토큰 (화면에 표시되지 않음)" });
    const msg = h("div", { class: "msg" });
    const submit = (e) =>
      act(e.target, msg, async () => {
        const r = await call("bot/token", { kind: W.kind, token: input.value });
        input.value = "";
        Object.assign(W, { draft: r.draft, bot: r.bot, note: r.note });
        go("settings");
      });
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit({ target: btn }));
    const btn = h("button", { onclick: submit }, "확인");
    return h("div", {}, h("div", { class: "row" }, h("span", { class: "grow" }, input), btn), msg, h("p", { class: "muted" }, "토큰은 이 PC의 사용자 폴더에만 저장되고, 페이지로 다시 보내지 않습니다."));
  },
  settings: () => {
    const s = W.settings;
    if (!s) return h("p", { class: "muted spin" }, "확인 중");
    const ok = s.intent && !s.public;
    const items = [];
    if (s.intentNeeded) items.push(h("li", { class: s.intent ? "ok" : "bad" }, s.intent ? "✓ Message Content Intent 켜짐" : "✗ Message Content Intent 꺼짐: 봇이 메시지를 읽으려면 꼭 필요합니다"));
    items.push(h("li", { class: s.public ? "warn" : "ok" }, s.public ? "! Public Bot 켜짐: 다른 사람이 이 봇을 자기 서버에 초대할 수 있습니다. 끄는 것을 권장합니다" : "✓ Public Bot 꺼짐"));
    return h(
      "div",
      {},
      h("ul", { class: "list" }, items),
      ok
        ? null
        : h(
            "div",
            {},
            h("p", {}, link(s.settingsUrl, "이 봇의 설정 화면 열기"), " → ", s.intentNeeded ? "Privileged Gateway Intents에서 MESSAGE CONTENT INTENT 켜기, " : "", "PUBLIC BOT 끄기 → ", h("b", {}, "Save Changes")),
            h("p", { class: "muted spin" }, "저장하면 여기서 자동으로 확인됩니다"),
            s.intent && s.public ? h("button", { class: "ghost", onclick: () => go("invite") }, "Public Bot을 켠 채로 계속") : null,
          ),
    );
  },
  invite: () => {
    if (!W.invite) return h("p", { class: "muted spin" }, "확인 중");
    if (W.guilds && W.guilds.length > 1 && W.step === "invite") {
      const sel = h("select", { onchange: (e) => (W.guildId = e.target.value) }, W.guilds.map((g) => h("option", { value: g.id, selected: g.id === W.guildId }, g.name)));
      const msg = h("div", { class: "msg" });
      return h(
        "div",
        {},
        h("label", {}, "이 봇이 들어가 있는 서버가 여러 개입니다. 어느 서버를 쓸까요?"),
        sel,
        h("div", { class: "row" }, h("button", { onclick: (e) => act(e.target, msg, async () => (await loadChannels(), go("channel"))) }, "다음")),
        msg,
      );
    }
    const g = W.guilds && W.guilds.find((x) => x.id === W.guildId);
    if (g) return h("span", { class: "ok" }, "✓ 서버: ", h("b", {}, g.name));
    return h(
      "div",
      {},
      h("p", {}, "아래 버튼을 눌러 ", h("b", {}, "내 개인 서버"), "를 고르고 승인하세요. 필요한 권한이 미리 채워져 있습니다."),
      h("div", { class: "row" }, h("a", { class: "button", href: W.invite, target: "_blank", rel: "noopener noreferrer" }, "서버에 초대하기")),
      h("p", { class: "muted spin" }, "봇이 서버에 들어오기를 기다리는 중"),
    );
  },
  channel: () => {
    if (W.step !== "channel") {
      const c = W.channels.find((x) => x.id === W.channelId);
      return h("span", { class: "ok" }, "✓ #", c ? c.name : "?");
    }
    const msg = h("div", { class: "msg" });
    const free = W.channels.filter((c) => !c.takenBy);
    const sel = h(
      "select",
      { onchange: (e) => (W.channelId = e.target.value) },
      h("option", { value: "", disabled: true, selected: !W.channelId }, "채널 선택"),
      W.channels.map((c) => h("option", { value: c.id, disabled: !!c.takenBy, selected: c.id === W.channelId }, "#" + c.name + (c.takenBy ? `  (${c.takenBy}에서 사용 중)` : ""))),
    );
    return h(
      "div",
      {},
      h("p", { class: "muted" }, W.kind === "manager" ? "관리 명령과 알림을 받을 채널 (예: #control). 워크스페이스 채널과 달라야 합니다." : "이 워크스페이스 전용 채널. 이 채널의 메시지가 Claude에게 전달됩니다."),
      h("div", { class: "row" }, h("span", { class: "grow" }, sel), h("button", { class: "ghost", onclick: (e) => act(e.target, msg, async () => (await loadChannels(), renderWizard())) }, "새로고침")),
      free.length ? null : h("p", { class: "warn" }, "쓸 수 있는 채널이 없습니다. 디스코드에서 채널을 새로 만들고 새로고침을 누르세요."),
      h("div", { class: "row" }, h("button", { onclick: () => (W.channelId ? go(W.kind === "manager" ? "owner" : "folder") : (msg.textContent = "채널을 고르세요.")) }, "다음")),
      msg,
    );
  },
  folder: () => {
    if (W.step !== "folder") return h("span", { class: "ok" }, "✓ ", code(W.folder));
    const input = h("input", { value: W.folder || "", placeholder: "예: C:\\projects\\my-app", oninput: (e) => (W.folder = e.target.value) });
    const msg = h("div", { class: "msg" });
    const next = (e) =>
      act(e.target, msg, async () => {
        const r = await call("folder/check", { folder: input.value, name: W.current && W.current.name });
        if (!r.ok) throw new Error(r.error);
        W.folder = r.folder;
        go("owner");
      });
    return h(
      "div",
      {},
      h("p", { class: "muted" }, "Claude가 작업할 프로젝트 폴더입니다. 폴더 하나는 워크스페이스 하나에만 연결할 수 있습니다."),
      h(
        "div",
        { class: "row" },
        h("span", { class: "grow" }, input),
        h("button", {
          class: "ghost",
          onclick: (e) =>
            act(e.target, msg, async () => {
              msg.textContent = "PC에 열린 폴더 선택 창을 확인하세요";
              const r = await call("folder/browse");
              if (r.folder) input.value = W.folder = r.folder;
            }),
        }, "찾아보기…"),
      ),
      h("div", { class: "row" }, h("button", { onclick: next }, "다음")),
      msg,
    );
  },
  owner: () => {
    if (W.step !== "owner") return h("span", { class: "ok" }, "✓ ", W.userChoice === "owner" ? W.owner.name : W.userId);
    const msg = h("div", { class: "msg" });
    const idInput = h("input", { value: W.userId || "", placeholder: "디스코드 사용자 ID (숫자)", oninput: (e) => (W.userId = e.target.value.trim()) });
    const radio = (value, label) =>
      h("label", { style: "font-weight:normal" }, h("input", { type: "radio", name: "who", style: "width:auto", checked: W.userChoice === value, onchange: () => ((W.userChoice = value), renderWizard()) }), " ", label);
    return h(
      "div",
      {},
      h("p", { class: "muted" }, W.kind === "manager" ? "관리 명령은 이 계정 하나만 쓸 수 있습니다." : "이 워크스페이스에 일을 시킬 수 있는 계정은 하나뿐입니다. 승인 요청 DM도 이 계정으로 옵니다."),
      radio("owner", h("span", {}, h("b", {}, W.owner.name), " (서버 소유자 / 기존 설정)")),
      radio("other", "다른 계정 (사용자 ID 입력)"),
      W.userChoice === "other"
        ? h("div", {}, idInput, h("p", { class: "muted" }, "디스코드 설정 → 고급 → 개발자 모드 켜기 → 내 프로필을 길게 눌러(또는 우클릭) ‘사용자 ID 복사’"))
        : null,
      h(
        "div",
        { class: "row" },
        h("button", {
          onclick: () => {
            const id = W.userChoice === "owner" ? W.owner.id : W.userId;
            if (!/^\d{15,22}$/.test(id || "")) return void (msg.className = "msg bad", (msg.textContent = "사용자 ID는 15~22자리 숫자입니다."));
            W.finalUser = id;
            if (!W.name) {
              const ch = W.channels.find((c) => c.id === W.channelId);
              W.name = (ch ? ch.name : "workspace").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 31) || "workspace";
            }
            go("save");
          },
        }, "다음"),
      ),
      msg,
    );
  },
  save: () => {
    if (W.step !== "save") return h("span", { class: "ok" }, "✓ 저장됨");
    const msg = h("div", { class: "msg" });
    if (W.kind === "manager") {
      return h(
        "div",
        {},
        h("button", {
          onclick: (e) =>
            act(e.target, msg, async () => {
              const r = await call("manager/save", { draft: W.draft, guildId: W.guildId, channelId: W.channelId, ownerId: W.finalUser });
              if (!r.ok) throw new Error(r.errors.join(" "));
              go("run");
              refresh();
            }),
        }, "관리용 봇 저장"),
        msg,
      );
    }
    const name = h("input", { value: W.name, oninput: (e) => (W.name = e.target.value) });
    const modes = [
      ["auto", "auto (기본): 위험이 낮은 작업은 자동 승인, 위험한 작업만 DM으로 승인 요청"],
      ["manual", "manual: 파일 수정·명령 실행마다 DM으로 승인 요청"],
      ["acceptEdits", "acceptEdits: 파일 수정은 자동, 명령은 승인 요청"],
      ["plan", "plan: 계획만 세우고 아무것도 바꾸지 않음"],
    ];
    const mode = h("select", { onchange: (e) => (W.mode = e.target.value) }, modes.map(([v, t]) => h("option", { value: v, selected: (W.mode || "auto") === v }, t)));
    return h(
      "div",
      {},
      h("label", {}, "이름 (영문 소문자·숫자·-, 관리 명령에서 씀)"),
      name,
      h("label", {}, "권한 모드 (나중에 /mode로 바꿀 수 있음)"),
      mode,
      h(
        "div",
        { class: "row", style: "margin-top:12px" },
        h("button", {
          onclick: (e) =>
            act(e.target, msg, async () => {
              const r = await call("workspace/save", { draft: W.draft, guildId: W.guildId, channelId: W.channelId, folder: W.folder, userId: W.finalUser, name: W.name, mode: W.mode || "auto" });
              if (!r.ok) throw new Error(r.errors.join(" "));
              W.saved = r.workspace;
              go("run");
              refresh();
            }),
        }, "저장"),
      ),
      msg,
    );
  },
  run: () => {
    if (!S) return h("p", {}, "…");
    const msg = h("div", { class: "msg" });
    const done = h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "ghost", onclick: closeWizard }, "닫기"));
    if (!S.supervisor.running)
      return h(
        "div",
        {},
        h("p", {}, "저장됐습니다. 실행 관리자가 꺼져 있어서 아직 실행되지 않았습니다."),
        h("div", { class: "row" }, h("button", { onclick: (e) => act(e.target, msg, () => call("supervisor/start")).then(refresh) }, "백그라운드로 시작")),
        h("p", { class: "muted" }, "또는 터미널에서 ", code("npm start")),
        msg,
        done,
      );
    if (W.kind === "manager") {
      const m = S.manager;
      const on = m && m.state === "online";
      return h(
        "div",
        {},
        on
          ? h("p", { class: "ok" }, "✅ 관리용 봇이 온라인입니다. 폰의 디스코드 #", m.channelName, "에서 ", code("/dashboard"), "를 입력해 보세요. (명령이 안 보이면 디스코드 앱을 껐다 켜세요)")
          : h("p", { class: m && m.state === "error" ? "bad" : "muted spin" }, m && m.state === "error" ? "관리용 봇을 시작하지 못했습니다. 로그를 확인하세요." : "관리용 봇을 시작하는 중"),
        done,
      );
    }
    const w = S.workspaces.find((x) => x.name === W.saved.name);
    if (!w) return h("p", { class: "bad" }, "워크스페이스를 찾을 수 없습니다.");
    const [icon, text, cls] = wsStateText(w);
    const ready = w.state === "running" && w.plugin === "connected";
    return h(
      "div",
      {},
      h("p", { class: cls }, icon, " ", text),
      w.state === "needs-trust" || w.trusting
        ? h(
            "div",
            {},
            h("p", {}, "처음 연결하는 폴더라서 claude가 ", h("b", {}, "이 폴더를 신뢰하는지"), " 한 번 묻습니다. 안전을 위해 이 프로그램은 대신 답하지 않습니다."),
            h("button", { disabled: w.trusting, onclick: (e) => act(e.target, msg, () => call("trust", { name: w.name })).then(refresh) }, w.trusting ? "신뢰 확인 창이 열려 있음" : "PC에서 신뢰 확인 창 열기"),
            trustHelp(),
          )
        : null,
      ready
        ? h("p", { class: "ok" }, "✅ 연결됐습니다! 폰의 디스코드에서 #", w.channelName, "에 메시지를 보내 보세요 (예: ‘이 폴더에 뭐가 있어?’).")
        : w.state === "needs-trust" || w.state === "failed"
          ? null
          : h("p", { class: "muted spin" }, "디스코드 봇이 연결되기를 기다리는 중 (보통 30초~1분)"),
      msg,
      done,
    );
  },
};

// ---------------------------------------------------------------- start

document.getElementById("finish").addEventListener("click", async () => {
  if (W && W.step !== "run" && !confirm("추가 중인 설정이 저장되지 않았습니다. 닫을까요?")) return;
  await call("close").catch(() => {});
  clearInterval(poll);
  document.body.replaceChildren(h("main", {}, h("section", { class: "card", style: "margin-top:40px" }, h("h2", {}, "설정을 마쳤습니다"), h("p", {}, "이 탭을 닫아도 됩니다. 다시 열려면 터미널에서 ", code("npm run setup"), "."))));
});

app.replaceChildren(cards.checks, cards.run, cards.ws, cards.mgr, wizardBox);
for (const c of [cards.run, cards.ws, cards.mgr]) fill(c, h("p", { class: "muted spin" }, "불러오는 중"));
renderChecks();
const poll = setInterval(refresh, 3000);
// State first: the PC check runs claude/bun commands and keeps the server busy for a few seconds.
refresh().then(loadChecks);
