(function () {
  "use strict";

  const CFG = window.APP_CONFIG;
  const NET = CFG.network;
  const CONTRACT = window.CLASS_CONTRACT;
  const STORE_KEY = "attendance:classes";
  const ADDRESS_RE = /0x[0-9a-fA-F]{40}/;
  const RECENT = 10; // lectures shown in the register table
  const MAX_NAME = 60;
  const MAX_TOPIC = 100;

  // ================================================================ small helpers

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const bytes = (s) => new TextEncoder().encode(s).length;
  const day = (s) => new Date(Number(s) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const time = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const explorer = (kind, value) => `${NET.explorer}/${kind}/${value}`;
  const isLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  function mon(wei) {
    const value = Number(ethers.formatEther(wei));
    const text = value > 0 && value < 0.0001 ? "<0.0001" : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return `${text} ${NET.currency}`;
  }

  function parseMon(text) {
    const value = String(text || "").trim();
    if (!/^\d*\.?\d+$/.test(value)) return null;
    try {
      return ethers.parseEther(value);
    } catch {
      return null;
    }
  }

  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private window or blocked storage: the list just isn't remembered */
    }
  }

  function rememberClass(address, name, role) {
    const list = storageGet(STORE_KEY, []).filter((c) => !same(c.address, address));
    const previous = storageGet(STORE_KEY, []).find((c) => same(c.address, address));
    list.unshift({ address, name, role: role === "teacher" || (previous && previous.role === "teacher") ? "teacher" : "student" });
    storageSet(STORE_KEY, list.slice(0, 20));
  }

  const ICON = {
    live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  };

  // ================================================================ toasts

  function toast(message, type, link) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "toasts";
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    const el = document.createElement("div");
    box.appendChild(el);
    let timer = null;
    const handle = {
      update(text, kind, href) {
        el.className = `toast toast-${kind || "info"}`;
        el.innerHTML =
          `<span>${esc(text)}</span>` +
          (href ? ` <a href="${esc(href)}" target="_blank" rel="noopener">Details</a>` : "") +
          `<button class="toast-close" aria-label="Dismiss">×</button>`;
        el.querySelector(".toast-close").onclick = handle.close;
      },
      closeAfter(ms) {
        clearTimeout(timer);
        timer = setTimeout(handle.close, ms);
      },
      close() {
        clearTimeout(timer);
        el.remove();
      },
    };
    handle.update(message, type, link);
    if (type === "success" || type === "info") handle.closeAfter(4000);
    return handle;
  }

  function copy(text, what) {
    navigator.clipboard.writeText(text).then(
      () => toast(`${what || "Copied"} copied`, "info"),
      () => toast("Could not copy. Select the text and copy it yourself.", "error").closeAfter(6000)
    );
  }

  // ================================================================ state

  const state = {
    classAddress: null,
    account: null,
    walletChainId: null,
    balance: null,
    info: null,
    students: [],
    sessions: [],
    flags: new Map(), // sessionId -> bool[] (same order as students)
    signature: "",
    loaded: false,
    loadError: null,
    loadAttempts: 0,
    busy: false,
  };

  const readProvider = new ethers.JsonRpcProvider(NET.rpcUrl, NET.chainId, { staticNetwork: true, batchMaxCount: 1 });
  const reader = () => new ethers.Contract(state.classAddress, CONTRACT.abi, readProvider);

  const myIndex = () => state.students.findIndex((s) => same(s.wallet, state.account));
  const me = () => state.students[myIndex()] || null;
  const openSession = () => (state.info ? state.sessions.find((s) => s.id === state.info.openSessionId) || null : null);
  const lowBalance = () => state.balance !== null && state.balance < ethers.parseEther(CFG.lowBalance);

  function role() {
    if (!state.info) return "loading";
    if (!state.account) return "visitor";
    if (same(state.account, state.info.teacher)) return "teacher";
    return me() ? "student" : "guest";
  }

  function presentFlags(sessionId) {
    return state.flags.get(sessionId) || [];
  }

  // ================================================================ wallet

  function setAccount(address) {
    state.account = address ? ethers.getAddress(address) : null;
  }

  async function refreshBalance() {
    if (!state.account) {
      state.balance = null;
      return;
    }
    try {
      state.balance = await readProvider.getBalance(state.account);
    } catch {
      /* keep the last known balance */
    }
  }

  async function ensureChain() {
    const current = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    state.walletChainId = current;
    if (current === NET.chainId) return;
    const chainId = "0x" + NET.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (err) {
      const code = err && (err.code ?? (err.data && err.data.originalError && err.data.originalError.code));
      if (code !== 4902) throw err;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: NET.name,
            nativeCurrency: { name: NET.currency, symbol: NET.currency, decimals: 18 },
            rpcUrls: [NET.rpcUrl],
            blockExplorerUrls: [NET.explorer],
          },
        ],
      });
    }
    state.walletChainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    if (state.walletChainId !== NET.chainId) throw new Error(`Please switch MetaMask to ${NET.name}.`);
  }

  async function connect() {
    if (!window.ethereum) {
      toast("MetaMask is not installed in this browser. Follow the steps on this page to install it.", "error").closeAfter(8000);
      return false;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts && accounts[0]);
      await ensureChain();
    } catch (err) {
      toast(errorMessage(err), "error").closeAfter(8000);
    }
    await refreshBalance();
    render(true);
    return !!state.account;
  }

  async function getSigner() {
    if (!window.ethereum) throw new Error("MetaMask is not installed in this browser.");
    if (!state.account) {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts && accounts[0]);
    }
    await ensureChain();
    const provider = new ethers.BrowserProvider(window.ethereum);
    return provider.getSigner(state.account);
  }

  function errorMessage(err) {
    if (!err) return "Something went wrong. Please try again.";
    const nestedCode = err.info && err.info.error && err.info.error.code;
    if (err.code === "ACTION_REJECTED" || err.code === 4001 || nestedCode === 4001) {
      return "You cancelled it in MetaMask. Nothing was changed.";
    }
    const message = String(
      err.reason ||
        (err.revert && err.revert.args && err.revert.args[0]) ||
        (err.info && err.info.error && err.info.error.message) ||
        err.shortMessage ||
        err.message ||
        err
    );
    if (/insufficient (funds|balance)/i.test(message)) {
      const who = role() === "student" || role() === "guest" ? " Ask your teacher to send you some, or get" : " Get";
      return `Your wallet does not have enough ${NET.currency} to pay for this.${who} free test ${NET.currency} at ${NET.faucet}`;
    }
    return message.replace(/^execution reverted:?\s*/i, "");
  }

  /** Runs one blockchain action with friendly progress messages. */
  async function run(label, action) {
    if (state.busy) return null;
    state.busy = true;
    render(true);
    const note = toast(`${label}: please confirm in MetaMask…`, "pending");
    try {
      const signer = await getSigner();
      const contract = new ethers.Contract(state.classAddress, CONTRACT.abi, signer);
      const tx = await action(contract);
      note.update(`${label}: saving on the blockchain…`, "pending", explorer("tx", tx.hash));
      await tx.wait();
      note.update(`${label}: done ✓`, "success", explorer("tx", tx.hash));
      note.closeAfter(5000);
      return true;
    } catch (err) {
      console.error(err);
      note.update(errorMessage(err), "error");
      note.closeAfter(12000);
      return false;
    } finally {
      state.busy = false;
      await refreshAll(true);
    }
  }

  // ================================================================ data

  let refreshing = false;
  let refreshAgain = false;

  async function refreshAll(force) {
    if (!state.classAddress) {
      await refreshBalance();
      render();
      return;
    }
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const c = reader();
      const i = await c.getClassInfo();
      const info = {
        name: i.name,
        teacher: i.teacherAddress,
        enrolmentOpen: i.enrolmentIsOpen,
        totalSessions: Number(i.totalSessions),
        openSessionId: Number(i.openSessionId),
        totalStudents: Number(i.totalStudents),
      };
      let presentNow = "";
      if (info.openSessionId) presentNow = String((await c.getSession(info.openSessionId)).presentCount);
      const signature = JSON.stringify([info.enrolmentOpen, info.totalSessions, info.openSessionId, info.totalStudents, presentNow]);

      if (force || !state.loaded || signature !== state.signature) {
        const [students, sessions] = await Promise.all([c.getAllStudents(), c.getAllSessions()]);
        const recent = Array.from(sessions).slice(-RECENT);
        const flags = await Promise.all(recent.map((s) => c.getSessionAttendance(s.id)));
        state.students = students.map((s) => ({ wallet: s.wallet, name: s.name, count: Number(s.attendanceCount) }));
        state.sessions = sessions.map((s) => ({
          id: Number(s.id),
          topic: s.topic,
          startTime: Number(s.startTime),
          endTime: Number(s.endTime),
          presentCount: Number(s.presentCount),
        }));
        state.flags = new Map(recent.map((s, n) => [Number(s.id), Array.from(flags[n])]));
        state.signature = signature;
      }
      state.info = info;
      state.loaded = true;
      state.loadError = null;
      rememberClass(state.classAddress, info.name, role());
    } catch (err) {
      console.error(err);
      if (!state.loaded) {
        // A brand-new class can take a moment to reach the public RPC, so retry first.
        state.loadAttempts += 1;
        if (state.loadAttempts < 5) setTimeout(() => refreshAll(true), 1500);
        else state.loadError = err;
      }
    } finally {
      refreshing = false;
    }
    await refreshBalance();
    render();
    if (refreshAgain) {
      refreshAgain = false;
      refreshAll(true);
    }
  }

  // ================================================================ rendering

  let lastKey = "";

  function render(force) {
    const key = JSON.stringify([
      state.classAddress,
      state.account,
      state.walletChainId,
      state.balance === null ? null : String(state.balance),
      state.signature,
      state.loaded,
      !!state.loadError,
      state.busy,
    ]);
    renderHeader();
    if (!force && key === lastKey) return;
    lastKey = key;

    // Keep whatever the user is typing when the page refreshes itself.
    const app = $("#app");
    const saved = {};
    app.querySelectorAll("input[id], textarea[id]").forEach((el) => {
      if (!el.readOnly) saved[el.id] = el.value;
    });
    const active = document.activeElement && app.contains(document.activeElement) ? document.activeElement.id : null;

    app.innerHTML = state.classAddress ? classPage() : homePage();

    for (const [id, value] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el && !el.readOnly) el.value = value;
    }
    if (active && document.getElementById(active)) document.getElementById(active).focus();
    updateAddPreview();
    renderFooter();
  }

  function renderHeader() {
    const chip = $("#networkChip");
    const btn = $("#walletBtn");
    if (state.account && state.walletChainId !== null && state.walletChainId !== NET.chainId) {
      chip.className = "chip chip-warning";
      chip.textContent = "Wrong network";
      chip.title = `MetaMask is on another network. Click any button and approve switching to ${NET.name}.`;
    } else {
      chip.className = "chip chip-ok";
      chip.textContent = NET.name;
      chip.title = `Chain ID ${NET.chainId}`;
    }
    btn.textContent = state.account ? short(state.account) : "Connect wallet";
    btn.title = state.account ? `${state.account} (click to copy)` : "Connect MetaMask";
    btn.classList.toggle("btn-connected", !!state.account);
  }

  function renderFooter() {
    const parts = [`Runs on ${esc(NET.name)} (test network, no real money)`];
    if (state.classAddress && ADDRESS_RE.test(state.classAddress)) {
      parts.push(`Class contract: <a href="${explorer("address", state.classAddress)}" target="_blank" rel="noopener"><code>${esc(state.classAddress)}</code></a>`);
      parts.push(`<a href="./">All classes</a>`);
    }
    $("#footer").innerHTML = parts.join(" · ");
  }

  const disabled = () => (state.busy ? "disabled" : "");

  function walletHelp() {
    if (window.ethereum) return "";
    if (isMobile) {
      const target = `${location.host}${location.pathname}${location.search}`;
      return `<section class="card panel-warn">
          <h2>Open this page in the MetaMask app</h2>
          <p class="sub">On a phone, this page works inside the MetaMask app. Install MetaMask from the Play Store or App Store first, then tap the button.</p>
          <a class="btn btn-hero" style="margin-top:12px;display:block;text-align:center;text-decoration:none" href="https://metamask.app.link/dapp/${esc(target)}">Open in MetaMask app</a>
        </section>`;
    }
    return `<section class="card panel-warn">
        <h2>First, install MetaMask</h2>
        <p class="sub">MetaMask is a free wallet that works as your login for this page. Install it, create a wallet, then reload this page.</p>
        <a class="btn" style="margin-top:12px;display:inline-block;text-decoration:none" href="https://metamask.io/download/" target="_blank" rel="noopener">Install MetaMask</a>
      </section>`;
  }

  function walletBar() {
    if (!state.account) return "";
    const low = lowBalance();
    const help =
      role() === "teacher" || role() === "loading" || !state.classAddress
        ? `<a href="${NET.faucet}" target="_blank" rel="noopener">Get free ${NET.currency}</a>`
        : `Ask your teacher, or <a href="${NET.faucet}" target="_blank" rel="noopener">get free ${NET.currency}</a>`;
    return `<div class="walletbar">
        <span>Your wallet <code class="addr">${esc(short(state.account))}</code></span>
        <button class="btn btn-secondary btn-small" type="button" data-copy="${esc(state.account)}" data-what="Wallet address">Copy address</button>
        <span class="spacer"></span>
        <span>Balance: <strong>${state.balance === null ? "…" : mon(state.balance)}</strong></span>
        ${low ? `<span class="chip chip-warning">Low</span> <span>${help}</span>` : ""}
      </div>`;
  }

  // ---------------------------------------------------------------- home

  function homePage() {
    const classes = storageGet(STORE_KEY, []);
    const list = classes.length
      ? `<section class="card span-2">
          <div class="card-head"><h2>Your classes</h2></div>
          <div class="class-list">${classes
            .map(
              (c) => `<a href="?class=${esc(c.address)}" data-open="${esc(c.address)}">
                <span><strong>${esc(c.name)}</strong></span>
                <span class="chip ${c.role === "teacher" ? "chip-accent" : ""} chip-plain">${c.role === "teacher" ? "Teacher" : "Student"}</span>
              </a>`
            )
            .join("")}</div>
        </section>`
      : "";

    return `<div class="stack">
      <section class="hero">
        <h2>Attendance that can't be faked</h2>
        <p>Students mark themselves present from their own wallet with one tap. Every mark is saved on the Monad blockchain, so nobody can change it later.</p>
        <div class="steps-inline">
          <div class="step-box"><span class="step-num">1</span><b>Teacher creates a class</b>One click. You become the class teacher.</div>
          <div class="step-box"><span class="step-num">2</span><b>Share the class link</b>Send it to students on WhatsApp.</div>
          <div class="step-box"><span class="step-num">3</span><b>Students tap "Mark me present"</b>During each lecture you start.</div>
        </div>
      </section>
      ${walletHelp()}
      ${walletBar()}
      <div class="grid">
        <section class="card">
          <div class="card-head"><div>
            <h2>I'm a teacher</h2>
            <p class="sub">Create a new class. It is saved on the blockchain and you become its teacher. Needs about 0.5 free test ${NET.currency}.</p>
          </div></div>
          <form id="createForm" autocomplete="off">
            <div class="field">
              <label for="className">Class name</label>
              <input id="className" required maxlength="${MAX_TOPIC}" placeholder="e.g. TY BSc CS - Blockchain" />
            </div>
            <button class="btn btn-hero" id="createBtn" type="submit" ${disabled()}>Create my class</button>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><div>
            <h2>I'm a student</h2>
            <p class="sub">Open the class link your teacher sent you. Or paste it here.</p>
          </div></div>
          <form id="openForm" autocomplete="off">
            <div class="field">
              <label for="classLink">Class link</label>
              <input id="classLink" required placeholder="Paste the class link" />
            </div>
            <button class="btn btn-hero btn-secondary" type="submit">Open class</button>
          </form>
        </section>
        ${list}
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- class page

  function classPage() {
    if (state.loadError) {
      return `<section class="card"><div class="big-state">
          <div class="icon icon-wait">${ICON.wait}</div>
          <h3>We couldn't open this class</h3>
          <p>Check that the link is complete. It should end with a long code starting with 0x.</p>
          <a class="btn" href="./" style="text-decoration:none">Go to the start page</a>
        </div></section>`;
    }
    if (!state.loaded) return `<div class="empty">Loading the class from the blockchain…</div>`;

    const r = role();
    const chips = {
      teacher: `<span class="chip chip-accent chip-plain">You are the teacher</span>`,
      student: `<span class="chip chip-ok">Student: ${esc(me() && me().name)}</span>`,
      guest: `<span class="chip chip-warning">Not in this class yet</span>`,
      visitor: `<span class="chip">Not connected</span>`,
    };
    const header = `<section class="card class-title">
        <div><div class="muted" style="font-size:13px">Class</div><h2>${esc(state.info.name)}</h2></div>
        ${chips[r] || ""}
      </section>`;

    let body = "";
    if (r === "teacher") body = teacherView();
    else if (r === "student") body = studentView();
    else if (r === "guest") body = guestView();
    else body = visitorView();

    return `<div class="stack">${header}${walletHelp()}${walletBar()}${body}</div>`;
  }

  function summaryCard() {
    const open = openSession();
    return `<section class="card">
        <div class="card-head"><h2>About this class</h2></div>
        <dl class="details">
          <dt>Students</dt><dd>${state.info.totalStudents}</dd>
          <dt>Lectures held</dt><dd>${state.info.totalSessions}</dd>
          <dt>Lecture open now</dt><dd>${open ? esc(open.topic) : "No"}</dd>
          <dt>Teacher</dt><dd><code class="addr">${esc(short(state.info.teacher))}</code></dd>
        </dl>
      </section>`;
  }

  function visitorView() {
    return `<section class="card"><div class="big-state">
        <div class="icon icon-wait">${ICON.wallet}</div>
        <h3>Connect your wallet</h3>
        <p>Connect MetaMask to join the class and mark yourself present.</p>
        <button class="btn btn-hero" type="button" data-action="connect" ${window.ethereum ? "" : "disabled"}>Connect MetaMask</button>
      </div></section>
      ${summaryCard()}`;
  }

  function guestView() {
    const name = state.info.name;
    if (state.info.enrolmentOpen) {
      const noMoney = state.balance !== null && state.balance === 0n;
      return `<section class="card">
          <div class="big-state">
            <div class="icon icon-live">${ICON.user}</div>
            <h3>Join this class</h3>
            <p>Type your name the way your teacher knows it.</p>
          </div>
          <form id="joinForm" autocomplete="off">
            <div class="field">
              <label for="joinName">Your name</label>
              <input id="joinName" required maxlength="${MAX_NAME}" placeholder="e.g. Priya Sharma" />
            </div>
            <button class="btn btn-hero" type="submit" ${disabled()}>Join class</button>
          </form>
          ${noMoney ? `<div class="panel panel-warn">Your wallet has 0 ${NET.currency}, and joining costs a tiny amount. Ask your teacher to add you (send them your address using the button below), or get free ${NET.currency} at <a href="${NET.faucet}" target="_blank" rel="noopener">${NET.faucet}</a>.</div>` : ""}
          ${sendAddressBlock(name)}
        </section>`;
    }
    return `<section class="card">
        <div class="big-state">
          <div class="icon icon-wait">${ICON.user}</div>
          <h3>You're not in this class yet</h3>
          <p>Send your wallet address to your teacher. Adding you takes them one click.</p>
        </div>
        ${sendAddressBlock(name)}
      </section>`;
  }

  function sendAddressBlock(className) {
    const message = `Hi! Please add me to the "${className}" attendance class.\nMy name: \nMy wallet: ${state.account}`;
    return `<div class="field" style="margin-top:12px">
        <label for="myAddress">Your wallet address</label>
        <div class="copy-row">
          <input id="myAddress" readonly value="${esc(state.account)}" />
          <button class="btn btn-secondary" type="button" data-copy="${esc(state.account)}" data-what="Wallet address">Copy</button>
        </div>
      </div>
      <a class="btn btn-block" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener"
         href="https://wa.me/?text=${encodeURIComponent(message)}">Send it on WhatsApp</a>`;
  }

  function studentView() {
    const student = me();
    const index = myIndex();
    const open = openSession();
    let action;
    if (open) {
      const marked = presentFlags(open.id)[index];
      action = marked
        ? `<div class="big-state">
             <div class="icon icon-ok">${ICON.ok}</div>
             <h3>You're marked present</h3>
             <p>for <strong>${esc(open.topic)}</strong>. You can close this page now.</p>
           </div>`
        : `<div class="big-state">
             <div class="icon icon-live">${ICON.live}</div>
             <h3>${esc(open.topic)}</h3>
             <p>The lecture is open now. Tap the button to mark yourself present.</p>
           </div>
           <button class="btn btn-hero" type="button" data-action="mark" ${disabled()}>Mark me present</button>
           ${lowBalance() ? `<div class="panel panel-warn">Your balance is low. If marking fails, ask your teacher to send you some ${NET.currency}.</div>` : ""}`;
    } else {
      action = `<div class="big-state">
          <div class="icon icon-wait">${ICON.wait}</div>
          <h3>No lecture is open right now</h3>
          <p>When your teacher starts the lecture, the <strong>Mark me present</strong> button appears here by itself.</p>
        </div>`;
    }

    const total = state.info.totalSessions;
    const history = state.sessions
      .filter((s) => state.flags.has(s.id))
      .slice()
      .reverse()
      .map((s) => {
        const was = presentFlags(s.id)[index];
        const status = s.id === state.info.openSessionId && !was
          ? `<span class="chip chip-info">Open now</span>`
          : was
            ? `<span class="chip chip-ok">Present</span>`
            : `<span class="chip chip-bad">Absent</span>`;
        return `<li><span>${esc(s.topic)}<br /><span class="muted" style="font-size:12.5px">${day(s.startTime)}</span></span>${status}</li>`;
      })
      .join("");

    return `<section class="card">${action}</section>
      <section class="card">
        <div class="card-head"><h2>My attendance</h2><span class="muted">${student.count} of ${total} lectures (${pct(student.count, total)}%)</span></div>
        ${history ? `<ul class="history">${history}</ul>` : `<div class="empty">No lectures yet.</div>`}
        ${total > RECENT ? `<p class="hint">Showing the latest ${RECENT} lectures.</p>` : ""}
      </section>`;
  }

  function teacherView() {
    const open = openSession();
    const total = state.students.length;
    let lecture;
    if (open) {
      const flags = presentFlags(open.id);
      const presentNames = state.students.filter((s, i) => flags[i]).map((s) => `<span class="chip chip-ok">${esc(s.name)}</span>`);
      lecture = `<section class="card">
          <div class="big-state">
            <div class="icon icon-live">${ICON.live}</div>
            <h3>${esc(open.topic)} is open</h3>
            <p>Started ${time(open.startTime)} · <strong>${open.presentCount} of ${total}</strong> students present</p>
          </div>
          ${presentNames.length ? `<div class="present-list" style="justify-content:center;margin-bottom:16px">${presentNames.join("")}</div>` : ""}
          <button class="btn btn-hero btn-hero-danger" type="button" data-action="end" ${disabled()}>End lecture</button>
          <p class="hint" style="text-align:center;margin-top:8px">Students tap "Mark me present" on their own phone or laptop. This page updates by itself.</p>
        </section>`;
    } else {
      const next = state.info.totalSessions + 1;
      lecture = `<section class="card">
          <div class="card-head"><div>
            <h2>Start a lecture</h2>
            <p class="sub">Students can only mark attendance while a lecture is open.</p>
          </div></div>
          <form id="startForm" autocomplete="off">
            <div class="field">
              <label for="topic">Lecture name</label>
              <input id="topic" required maxlength="${MAX_TOPIC}" value="${esc(`Lecture ${next} - ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`)}" />
            </div>
            <button class="btn btn-hero" type="submit" ${disabled()}>Start lecture</button>
          </form>
          ${total ? "" : `<div class="panel panel-warn">No students yet. Add them below, or turn on "Students can join by themselves".</div>`}
        </section>`;
    }

    const link = `${location.origin}${location.pathname}?class=${state.classAddress}`;
    const share = `<section class="card">
        <div class="card-head"><div>
          <h2>Share the class link</h2>
          <p class="sub">Students open this link to join and to mark attendance.</p>
        </div></div>
        <div class="copy-row">
          <input id="shareLink" readonly value="${esc(link)}" />
          <button class="btn btn-secondary" type="button" data-copy="${esc(link)}" data-what="Class link">Copy</button>
        </div>
        <a class="btn btn-block" style="display:block;text-align:center;text-decoration:none;margin-top:10px" target="_blank" rel="noopener"
           href="https://wa.me/?text=${encodeURIComponent(`Attendance for "${state.info.name}": open this link, connect MetaMask and tap "Mark me present" during the lecture.\n${link}`)}">Share on WhatsApp</a>
        ${isLocal ? `<div class="panel panel-warn">This link only works on this computer. To share it with students, put the app online first (see the guide: "Put App Online").</div>` : ""}
        <div class="switch">
          <div><strong>Students can join by themselves: ${state.info.enrolmentOpen ? "ON" : "OFF"}</strong>
            <p>When ON, anyone with the link can join with their name (they need a little ${NET.currency}). Turn it OFF when everyone has joined.</p></div>
          <button class="btn ${state.info.enrolmentOpen ? "btn-secondary" : ""}" type="button" data-action="enrol" ${disabled()}>${state.info.enrolmentOpen ? "Turn off" : "Turn on"}</button>
        </div>
      </section>`;

    const add = `<section class="card">
        <div class="card-head"><div>
          <h2>Add students</h2>
          <p class="sub">One student per line: name, then wallet address. Students can copy their address from this page after they connect MetaMask.</p>
        </div></div>
        <form id="addForm" autocomplete="off">
          <div class="field">
            <label for="addList">Students</label>
            <textarea id="addList" rows="4" placeholder="Priya Sharma, 0x1234...\nRahul Verma, 0xabcd..."></textarea>
            <span class="hint" id="addPreview"></span>
          </div>
          <div class="field">
            <label for="gasEach">Free ${NET.currency} to send each student (pays for their clicks)</label>
            <input id="gasEach" inputmode="decimal" value="${esc(CFG.gasPerStudent)}" />
            <span class="hint">Each "Mark me present" costs a student about 0.011 ${NET.currency}, so 0.1 covers about 7 lectures. You can send more later. Type 0 to send nothing.</span>
          </div>
          <button class="btn btn-hero" id="addBtn" type="submit" ${disabled()}>Add students</button>
        </form>
      </section>`;

    return `${lecture}<div class="grid">${share}${add}</div>${registerCard()}`;
  }

  function registerCard() {
    const students = state.students;
    const recent = state.sessions.filter((s) => state.flags.has(s.id));
    const total = state.info.totalSessions;
    const head = recent
      .map((s) => `<th class="mark" title="${esc(s.topic)} · ${day(s.startTime)}">L${s.id}</th>`)
      .join("");
    const rows = students
      .map((s, i) => {
        const marks = recent
          .map((session) => (presentFlags(session.id)[i] ? `<td class="mark yes" title="Present">✓</td>` : `<td class="mark no" title="Absent">–</td>`))
          .join("");
        return `<tr>
            <td><strong>${esc(s.name)}</strong><br /><code class="addr" title="${esc(s.wallet)}">${esc(short(s.wallet))}</code></td>
            ${marks}
            <td class="num">${s.count}/${total}</td>
            <td class="num">${pct(s.count, total)}%</td>
            <td><button class="remove" type="button" title="Remove ${esc(s.name)}" data-remove="${esc(s.wallet)}" data-name="${esc(s.name)}" ${disabled()}>×</button></td>
          </tr>`;
      })
      .join("");

    return `<section class="card">
        <div class="card-head">
          <div><h2>Students (${students.length})</h2>
          ${total > RECENT ? `<p class="sub">Latest ${RECENT} lectures shown. The download has all of them.</p>` : ""}</div>
          <div class="actions">
            <button class="btn btn-secondary btn-small" type="button" data-action="csv" ${students.length ? "" : "disabled"}>Download for Excel</button>
          </div>
        </div>
        ${
          students.length
            ? `<div class="table-wrap"><table class="register">
                <thead><tr><th>Student</th>${head}<th class="num">Total</th><th class="num">%</th><th></th></tr></thead>
                <tbody>${rows}</tbody></table></div>
              <form id="topupForm" class="inline-form" style="margin-top:14px" autocomplete="off">
                <input id="topupEach" inputmode="decimal" value="${esc(CFG.gasPerStudent)}" aria-label="${NET.currency} for each student" />
                <button class="btn btn-secondary" type="submit" ${disabled()}>Send this much ${NET.currency} to every student</button>
              </form>`
            : `<div class="empty">No students yet.</div>`
        }
      </section>`;
  }

  // ================================================================ actions

  function parseStudentList(text) {
    const students = [];
    const problems = [];
    const seen = new Set();
    text.split(/\r?\n/).forEach((line, n) => {
      if (!line.trim()) return;
      const match = line.match(ADDRESS_RE);
      if (!match) {
        problems.push(`Line ${n + 1}: no wallet address found`);
        return;
      }
      const name = line.replace(match[0], "").replace(/^[\s,;:\-–|]+|[\s,;:\-–|]+$/g, "").trim();
      let wallet;
      try {
        wallet = ethers.getAddress(match[0].toLowerCase());
      } catch {
        problems.push(`Line ${n + 1}: that wallet address is not valid`);
        return;
      }
      if (!name) problems.push(`Line ${n + 1}: add the student's name`);
      else if (bytes(name) > MAX_NAME) problems.push(`Line ${n + 1}: name is too long`);
      else if (seen.has(wallet)) problems.push(`Line ${n + 1}: this wallet is listed twice`);
      else if (state.students.some((s) => same(s.wallet, wallet))) problems.push(`Line ${n + 1}: ${name} is already in the class`);
      else if (state.info && same(wallet, state.info.teacher)) problems.push(`Line ${n + 1}: that is your own (teacher) wallet`);
      else {
        seen.add(wallet);
        students.push({ name, wallet });
      }
    });
    return { students, problems };
  }

  function updateAddPreview() {
    const list = $("#addList");
    const preview = $("#addPreview");
    if (!list || !preview) return;
    if (!list.value.trim()) {
      preview.textContent = "";
      return;
    }
    const { students, problems } = parseStudentList(list.value);
    const each = parseMon($("#gasEach").value);
    const totalGas = each !== null ? each * BigInt(students.length) : null;
    let text = `${students.length} student${students.length === 1 ? "" : "s"} ready`;
    if (totalGas && totalGas > 0n) text += `, sending ${mon(totalGas)} in total`;
    if (problems.length) text += `. Fix: ${problems.join("; ")}`;
    preview.textContent = text;
    preview.style.color = problems.length ? "var(--bad)" : "";
  }

  async function addStudents() {
    const { students, problems } = parseStudentList($("#addList").value);
    if (problems.length) {
      toast(problems[0], "error").closeAfter(8000);
      return;
    }
    if (!students.length) {
      toast("Type at least one student: name, then wallet address.", "error").closeAfter(6000);
      return;
    }
    const each = parseMon($("#gasEach").value);
    if (each === null) {
      toast(`Type how much ${NET.currency} to send each student, for example 0.05 (or 0).`, "error").closeAfter(6000);
      return;
    }
    const value = each * BigInt(students.length);
    const ok = await run(`Adding ${students.length} student${students.length === 1 ? "" : "s"}`, (c) =>
      c.addStudents(
        students.map((s) => s.wallet),
        students.map((s) => s.name),
        { value }
      )
    );
    if (ok) {
      $("#addList") && ($("#addList").value = "");
      updateAddPreview();
    }
  }

  async function topUp() {
    const each = parseMon($("#topupEach").value);
    if (!each || each === 0n) {
      toast(`Type how much ${NET.currency} to send each student, for example 0.05.`, "error").closeAfter(6000);
      return;
    }
    const wallets = state.students.map((s) => s.wallet);
    await run(`Sending ${mon(each * BigInt(wallets.length))} to ${wallets.length} students`, (c) =>
      c.sendGas(wallets, { value: each * BigInt(wallets.length) })
    );
  }

  async function createClass(name) {
    if (!name) return;
    if (bytes(name) > MAX_TOPIC) {
      toast("That class name is too long.", "error").closeAfter(6000);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    render(true);
    const note = toast("Creating your class: please confirm in MetaMask…", "pending");
    try {
      const signer = await getSigner();
      const factory = new ethers.ContractFactory(CONTRACT.abi, CONTRACT.bytecode, signer);
      const contract = await factory.deploy(name);
      const hash = contract.deploymentTransaction().hash;
      note.update("Saving your class on the blockchain… (a few seconds)", "pending", explorer("tx", hash));
      await contract.waitForDeployment();
      const address = await contract.getAddress();
      rememberClass(address, name, "teacher");
      note.update("Your class is ready ✓", "success", explorer("address", address));
      note.closeAfter(6000);
      state.busy = false;
      openClass(address);
    } catch (err) {
      console.error(err);
      note.update(errorMessage(err), "error");
      note.closeAfter(12000);
      state.busy = false;
      render(true);
    }
  }

  async function downloadCsv() {
    const note = toast("Preparing the attendance file…", "pending");
    try {
      const c = reader();
      const all = await Promise.all(state.sessions.map((s) => c.getSessionAttendance(s.id)));
      const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const total = state.sessions.length;
      const lines = [
        ["Name", "Wallet", ...state.sessions.map((s) => `${s.topic} (${day(s.startTime)})`), "Attended", "Percent"].map(cell).join(","),
        ...state.students.map((s, i) =>
          [s.name, s.wallet, ...all.map((flags) => (flags[i] ? "Present" : "Absent")), `${s.count}/${total}`, `${pct(s.count, total)}%`]
            .map(cell)
            .join(",")
        ),
      ];
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${state.info.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "class"} - attendance.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      note.update("Downloaded. Open it with Excel or Google Sheets.", "success");
      note.closeAfter(5000);
    } catch (err) {
      note.update(errorMessage(err), "error");
      note.closeAfter(8000);
    }
  }

  // ================================================================ navigation

  function classFromUrl() {
    const param = new URLSearchParams(location.search).get("class") || "";
    const match = param.match(ADDRESS_RE);
    return match ? ethers.getAddress(match[0].toLowerCase()) : param ? "invalid" : null;
  }

  function resetClassState() {
    state.info = null;
    state.students = [];
    state.sessions = [];
    state.flags = new Map();
    state.signature = "";
    state.loaded = false;
    state.loadError = null;
    state.loadAttempts = 0;
  }

  function openClass(address) {
    history.pushState(null, "", `?class=${address}`);
    loadRoute();
  }

  function loadRoute() {
    const target = classFromUrl();
    resetClassState();
    if (target === "invalid") {
      state.classAddress = "invalid";
      state.loadError = new Error("invalid link");
      render(true);
      return;
    }
    state.classAddress = target;
    render(true);
    refreshAll(true);
  }

  // ================================================================ wiring

  document.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      copy(copyBtn.dataset.copy, copyBtn.dataset.what);
      return;
    }
    const openLink = e.target.closest("[data-open]");
    if (openLink) {
      e.preventDefault();
      openClass(openLink.dataset.open);
      return;
    }
    const remove = e.target.closest("[data-remove]");
    if (remove) {
      if (window.confirm(`Remove ${remove.dataset.name} from the class? Their past attendance stays on the blockchain.`)) {
        run(`Removing ${remove.dataset.name}`, (c) => c.removeStudent(remove.dataset.remove));
      }
      return;
    }
    const action = e.target.closest("[data-action]");
    if (!action) return;
    switch (action.dataset.action) {
      case "connect":
        connect();
        break;
      case "mark":
        run("Marking you present", (c) => c.markAttendance());
        break;
      case "end":
        run("Ending the lecture", (c) => c.endSession());
        break;
      case "enrol":
        run(state.info.enrolmentOpen ? "Turning off self-join" : "Turning on self-join", (c) => c.setEnrolment(!state.info.enrolmentOpen));
        break;
      case "csv":
        downloadCsv();
        break;
    }
  });

  document.addEventListener("submit", (e) => {
    const form = e.target;
    e.preventDefault();
    switch (form.id) {
      case "createForm":
        createClass($("#className").value.trim());
        break;
      case "openForm": {
        const match = $("#classLink").value.match(ADDRESS_RE);
        if (match) openClass(ethers.getAddress(match[0].toLowerCase()));
        else toast("That doesn't look like a class link. It should contain a long code starting with 0x.", "error").closeAfter(7000);
        break;
      }
      case "joinForm": {
        const name = $("#joinName").value.trim();
        if (bytes(name) > MAX_NAME) toast("That name is too long.", "error").closeAfter(6000);
        else if (name) run("Joining the class", (c) => c.joinClass(name));
        break;
      }
      case "startForm": {
        const topic = $("#topic").value.trim();
        if (bytes(topic) > MAX_TOPIC) toast("That lecture name is too long.", "error").closeAfter(6000);
        else if (topic) run("Starting the lecture", (c) => c.startSession(topic));
        break;
      }
      case "addForm":
        addStudents();
        break;
      case "topupForm":
        topUp();
        break;
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "addList" || e.target.id === "gasEach") updateAddPreview();
  });

  $("#walletBtn").addEventListener("click", () => {
    if (state.account) copy(state.account, "Wallet address");
    else connect();
  });

  window.addEventListener("popstate", loadRoute);

  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on("accountsChanged", async (accounts) => {
      setAccount(accounts && accounts[0]);
      await refreshBalance();
      render(true);
    });
    window.ethereum.on("chainChanged", (chainId) => {
      state.walletChainId = parseInt(chainId, 16);
      render(true);
    });
  }

  setInterval(() => {
    if (document.visibilityState !== "visible" || state.busy) return;
    if (state.classAddress && state.classAddress !== "invalid") refreshAll(false);
    else if (state.account) refreshBalance().then(() => render());
  }, CFG.refreshEvery);

  (async function start() {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        setAccount(accounts && accounts[0]);
        state.walletChainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
      } catch {
        /* wallet locked */
      }
    }
    await refreshBalance();
    loadRoute();
  })();
})();
