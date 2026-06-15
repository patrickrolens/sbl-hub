/* ============================================================================
   SBL Hub — shared navigation (nav.js)
   Drop into any hub page with:  <script src="nav.js"></script>  (right after <body>)
   Self-contained: injects its own markup, CSS (namespaced sbln-*), the Teams
   dropdown, and the Admin control (login modal signed-out / admin dropdown
   signed-in). Owns the auth session and exposes it to pages that gate on it via
   window.SBLNav.ready (a promise) and a 'sbl-auth' CustomEvent.
   Relies only on the shared CSS tokens (--bg2, --accent, …) present on every page
   and the supabase-js global (loaded before this script).
   ============================================================================ */
(function () {
  "use strict";

  const SUPABASE_URL      = "https://arypbyzeppbpbursmzcs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_U8J3pV_KgomrWhbgoGBSUg_ttQ4d46m";
  const PLANNER_URL       = "https://planner.springfieldbattleleague.com";
  const LOGO_SRC          = "/assets/SBL_Logo.png";
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // Single shared client for the whole page — pages should use window.sb rather than
  // creating their own, so there's only one auth/session manager (two clients on the
  // same project fight over the session lock).
  window.sb = sb;

  // Admin pages listed in the Admin dropdown when signed in (now under /admin/).
  const ADMIN_LINKS = [
    { href: "/admin/admin-matches.html", label: "Matches" },
    { href: "/admin/admin-rosters.html", label: "Rosters" },
    { href: "/admin/admin-tiers.html",   label: "Tiers" },
  ];

  // Primary tabs, in order. Postseason is gated (shown when published, or to admins).
  // Root-absolute hrefs so the shared nav works from subfolders (e.g. /admin/) too.
  const TABS = [
    { key: "standings",  label: "Standings",   href: "/index.html" },
    { key: "draft",      label: "Draft Board", href: "/draft.html" },
    { key: "teams",      label: "Teams",       href: "/team.html", dropdown: true },
    { key: "matches",    label: "Matches",     href: "/matches.html" },
    { key: "postseason", label: "Postseason",  href: "/postseason.html", gated: true },
    { key: "statistics", label: "Statistics",  href: "/statistics.html" },
    { key: "rules",      label: "Rules",      href: "/rules.html" },
    { key: "planner",    label: "Planner",     href: PLANNER_URL, external: true },
  ];

  // ── current page → active tab key (admin checked by path, since /admin/ files vary) ──
  const path = location.pathname.toLowerCase();
  function activeKey() {
    if (path.indexOf("/admin/") !== -1) return "admin";
    const file = path.split("/").pop();
    if (file === "" || file === "index.html" || file === "standings.html") return "standings";
    if (file === "draft.html") return "draft";
    if (file === "team.html") return "teams";
    if (file === "matches.html") return "matches";
    if (file === "postseason.html") return "postseason";
    if (file === "statistics.html") return "statistics";
    if (file === "rules.html") return "rules";
    return "";
  }
  const ACTIVE = activeKey();

  // ── state ──
  let season = null, allTeams = [], coachByTeam = {};
  let currentUser = null, isAdmin = false;
  let postseasonVisible = false;
  let teamKbdIndex = -1;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ── styles (namespaced) ──
  function injectStyle() {
    const css = `
#sbl-nav { background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; align-items: stretch; padding: 0 1rem; position: sticky; top: 0; z-index: 100; min-height: 49px; }
#sbl-nav * { box-sizing: border-box; }
.sbln-logo { display: flex; align-items: center; gap: 8px; padding-right: 0px; margin-right: 0px; border-right: 1px solid var(--border); white-space: nowrap; text-decoration: none; flex-shrink: 0; }
.sbln-logo img { height: 47px; width: auto; display: block; }
.sbln-logo .sbln-word { font-size: 15px; font-weight: 700; color: var(--accent); }
.sbln-tabs { display: flex; align-items: stretch; }
.sbln-tab { display: inline-flex; align-items: center; gap: 5px; padding: 0 15px; font-size: 13px; font-weight: 600; color: var(--text2); text-decoration: none; border: none; border-bottom: 2px solid transparent; background: none; font-family: inherit; cursor: pointer; white-space: nowrap; }
.sbln-tab:hover { color: var(--text); }
.sbln-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.sbln-tab[hidden] { display: none; }
.sbln-caret { font-size: 10px; transition: transform .15s; }
.sbln-tab[aria-expanded="true"] .sbln-caret { transform: rotate(180deg); }
.sbln-right { margin-left: auto; display: flex; align-items: center; gap: 10px; padding-left: 12px; }
.sbln-extra { display: flex; align-items: center; gap: 8px; }
.sbln-btn { background: var(--bg3); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-size: 12px; font-weight: 600; padding: 7px 12px; cursor: pointer; font-family: inherit; }
.sbln-btn:hover { border-color: var(--accent); }
.sbln-btn:disabled { opacity: .5; cursor: default; }
.sbln-btn-accent { background: var(--accent); border-color: var(--accent); color: #fff; }
.sbln-btn-accent:hover { filter: brightness(1.08); }
.sbln-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); vertical-align: middle; margin-right: 7px; box-shadow: 0 0 5px rgba(76,175,125,.7); }
.sbln-admin-wrap { position: relative; display: flex; align-items: center; }
.sbln-menu-foot { border-top: 1px solid var(--border); padding: 8px 10px; display: flex; align-items: center; gap: 8px; }
.sbln-foot-email { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbln-logout-btn { flex: 0 0 auto; }

/* dropdown menus (Teams + Admin) */
.sbln-menu { position: fixed; z-index: 150; width: 260px; max-width: calc(100vw - 16px); max-height: min(60vh, 460px); display: flex; flex-direction: column; overflow: hidden; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 14px 34px rgba(0,0,0,.5); }
.sbln-menu[hidden] { display: none; }
.sbln-menu-search { padding: 8px; border-bottom: 1px solid var(--border); }
.sbln-menu-search input { width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; color: var(--text); font-size: 13px; outline: none; }
.sbln-menu-search input:focus { border-color: var(--accent); }
.sbln-menu-list { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.sbln-menu-item { display: block; width: 100%; text-align: left; background: none; border: none; border-radius: 6px; padding: 8px 10px; color: var(--text); font-size: 13px; cursor: pointer; font-family: inherit; text-decoration: none; }
.sbln-menu-item:hover, .sbln-menu-item.kbd { background: var(--bg3); }
.sbln-menu-item .pl { color: var(--text3); font-weight: 400; }
.sbln-menu-empty { font-size: 12px; color: var(--text3); padding: 8px 10px; font-style: italic; }

/* login modal + toast */
.sbln-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 20px; }
.sbln-modal-overlay[hidden] { display: none; }
.sbln-modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 20px; width: 100%; max-width: 380px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.sbln-modal h3 { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.sbln-modal p { font-size: 13px; color: var(--text2); line-height: 1.5; margin-bottom: 14px; }
.sbln-modal input { width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: 7px; padding: 9px 12px; color: var(--text); font-size: 13px; outline: none; margin-bottom: 14px; font-family: inherit; }
.sbln-modal input:focus { border-color: var(--accent); }
.sbln-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
#sbln-toasts { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 300; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.sbln-toast { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; font-size: 13px; color: var(--text); box-shadow: 0 4px 16px rgba(0,0,0,.4); max-width: 90vw; }
.sbln-toast.ok { border-color: rgba(76,175,125,.5); }
.sbln-toast.err { border-color: rgba(224,85,85,.55); color: #ff9c9c; }

@media (max-width: 860px) {
  #sbl-nav { padding: 0 8px; overflow-x: auto; scrollbar-width: none; }
  #sbl-nav::-webkit-scrollbar { display: none; }
  .sbln-logo { padding-right: 10px; margin-right: 6px; }
  .sbln-logo img { height: 24px; }
  .sbln-tab { padding: 0 11px; }
  .sbln-right { padding-left: 8px; gap: 8px; }
}`;
    const tag = document.createElement("style");
    tag.id = "sbl-nav-style";
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── build nav markup ──
  function tabHtml(t) {
    if (t.dropdown) {
      return `<button class="sbln-tab${ACTIVE === t.key ? " active" : ""}" id="sbln-teams-trigger" aria-haspopup="true" aria-expanded="false">${t.label} <span class="sbln-caret">▾</span></button>`;
    }
    const hidden = t.gated ? " hidden" : "";
    const target = t.external ? ' rel="noopener"' : "";
    return `<a class="sbln-tab${ACTIVE === t.key ? " active" : ""}${hidden}" id="sbln-tab-${t.key}" href="${t.href}"${target}>${t.label}</a>`;
  }

  function buildNav() {
    const nav = document.createElement("nav");
    nav.id = "sbl-nav";
    nav.innerHTML =
      `<a class="sbln-logo" href="/index.html"><img src="${LOGO_SRC}" alt="SBL"><span class="sbln-word" hidden>SBL Hub</span></a>`
      + `<div class="sbln-tabs">${TABS.map(tabHtml).join("")}</div>`
      + `<div class="sbln-right">`
      +   `<span class="sbln-extra" id="nav-extra"></span>`
      +   `<div class="sbln-admin-wrap" id="sbln-admin-wrap">`
      +     `<button class="sbln-btn${ACTIVE === "admin" ? " sbln-btn-accent" : ""}" id="sbln-admin-btn">Admin</button>`
      +   `</div>`
      + `</div>`;
    document.body.insertBefore(nav, document.body.firstChild);

    // logo fallback to wordmark if the image is missing
    const logoImg = nav.querySelector(".sbln-logo img");
    logoImg.onerror = function () { this.style.display = "none"; nav.querySelector(".sbln-word").hidden = false; };

    // Teams dropdown + Admin dropdown menus live on <body> (fixed position).
    const teamMenu = document.createElement("div");
    teamMenu.className = "sbln-menu"; teamMenu.id = "sbln-team-menu"; teamMenu.hidden = true;
    teamMenu.innerHTML = `<div class="sbln-menu-search"><input type="text" id="sbln-team-search" placeholder="Search teams…" autocomplete="off"></div><div class="sbln-menu-list" id="sbln-team-list"></div>`;
    document.body.appendChild(teamMenu);

    const adminMenu = document.createElement("div");
    adminMenu.className = "sbln-menu"; adminMenu.id = "sbln-admin-menu"; adminMenu.hidden = true;
    adminMenu.style.width = "230px";
    adminMenu.innerHTML = `<div class="sbln-menu-list">${ADMIN_LINKS.map(l => `<a class="sbln-menu-item" href="${l.href}">${esc(l.label)}</a>`).join("")}</div>`
      + `<div class="sbln-menu-foot"><span class="sbln-foot-email" id="sbln-email"></span><button class="sbln-btn sbln-logout-btn" id="sbln-logout">Log out</button></div>`;
    document.body.appendChild(adminMenu);

    // login modal + toast container
    const modal = document.createElement("div");
    modal.className = "sbln-modal-overlay"; modal.id = "sbln-modal-overlay"; modal.hidden = true;
    modal.innerHTML = `<div class="sbln-modal" id="sbln-modal"></div>`;
    modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
    document.body.appendChild(modal);

    const toasts = document.createElement("div");
    toasts.id = "sbln-toasts";
    document.body.appendChild(toasts);

    wire();
    setNavHeight();
  }

  function setNavHeight() {
    const nav = document.getElementById("sbl-nav");
    if (nav) document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
  }

  // ── dropdown plumbing ──
  function positionMenu(menu, trigger) {
    if (!menu || menu.hidden) return;
    const r = trigger.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    menu.style.top = r.bottom + "px";
  }
  function closeMenus() {
    const tm = document.getElementById("sbln-team-menu"), am = document.getElementById("sbln-admin-menu");
    if (tm) tm.hidden = true;
    if (am) am.hidden = true;
    const tt = document.getElementById("sbln-teams-trigger");
    const ab = document.getElementById("sbln-admin-btn");
    if (tt) tt.setAttribute("aria-expanded", "false");
    if (ab) ab.removeAttribute("aria-expanded");
  }

  function wire() {
    const teamsTrigger = document.getElementById("sbln-teams-trigger");
    const teamMenu = document.getElementById("sbln-team-menu");
    const search = document.getElementById("sbln-team-search");
    if (teamsTrigger) {
      teamsTrigger.addEventListener("click", e => {
        e.stopPropagation();
        if (teamMenu.hidden) openTeamMenu(); else closeMenus();
      });
      search.addEventListener("input", filterTeamMenu);
      search.addEventListener("keydown", onTeamSearchKey);
    }
    document.getElementById("sbln-logout").addEventListener("click", doLogout);
    document.getElementById("sbln-admin-btn").addEventListener("click", onAdminClick);

    document.addEventListener("click", e => {
      if (!e.target.closest("#sbln-teams-trigger") && !e.target.closest("#sbln-team-menu")
          && !e.target.closest("#sbln-admin-wrap") && !e.target.closest("#sbln-admin-menu")) closeMenus();
    });
    window.addEventListener("resize", () => {
      setNavHeight();
      const tm = document.getElementById("sbln-team-menu"), am = document.getElementById("sbln-admin-menu");
      if (tm && !tm.hidden) positionMenu(tm, teamsTrigger);
      if (am && !am.hidden) positionMenu(am, document.getElementById("sbln-admin-btn"));
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") { closeMenus(); closeModal(); } });
  }

  function teamEntries() {
    return [...allTeams]
      .sort((a, b) => (a.initial_seed ?? 999) - (b.initial_seed ?? 999) || a.name.localeCompare(b.name))
      .map(t => ({ t, coach: coachByTeam[t.id] || "", hay: (t.name + " " + (coachByTeam[t.id] || "")).toLowerCase() }));
  }
  function openTeamMenu() {
    const menu = document.getElementById("sbln-team-menu");
    const trigger = document.getElementById("sbln-teams-trigger");
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    positionMenu(menu, trigger);
    const search = document.getElementById("sbln-team-search");
    search.value = ""; teamKbdIndex = -1; filterTeamMenu();
    setTimeout(() => search.focus(), 20);
  }
  function filterTeamMenu() {
    const q = (document.getElementById("sbln-team-search").value || "").trim().toLowerCase();
    const list = document.getElementById("sbln-team-list");
    const rows = teamEntries().filter(e => !q || e.hay.includes(q));
    teamKbdIndex = -1;
    if (!rows.length) { list.innerHTML = `<div class="sbln-menu-empty">No teams match “${esc(q)}”.</div>`; return; }
    list.innerHTML = "";
    rows.forEach(e => {
      const a = document.createElement("a");
      a.className = "sbln-menu-item";
      a.href = "/team.html#" + encodeURIComponent(e.t.slug || "");
      a.innerHTML = esc(e.t.name) + (e.coach ? ` <span class="pl">(${esc(e.coach)})</span>` : "");
      list.appendChild(a);
    });
  }
  function onTeamSearchKey(e) {
    const items = [...document.querySelectorAll("#sbln-team-list .sbln-menu-item")];
    if (e.key === "Escape") { closeMenus(); return; }
    if (e.key === "Enter") { e.preventDefault(); const pick = items[teamKbdIndex] || items[0]; if (pick) location.href = pick.href; return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!items.length) return;
      teamKbdIndex = e.key === "ArrowDown" ? Math.min(items.length - 1, teamKbdIndex + 1) : Math.max(0, teamKbdIndex - 1);
      items.forEach((it, i) => it.classList.toggle("kbd", i === teamKbdIndex));
      items[teamKbdIndex].scrollIntoView({ block: "nearest" });
    }
  }

  // ── admin control ──
  function onAdminClick(e) {
    e.stopPropagation();
    if (isAdmin) {
      const menu = document.getElementById("sbln-admin-menu");
      const btn = document.getElementById("sbln-admin-btn");
      if (menu.hidden) { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); positionMenu(menu, btn); }
      else closeMenus();
    } else {
      openLogin();
    }
  }

  // ── auth ──
  async function applySession(session) {
    currentUser = session ? session.user : null;
    if (currentUser) {
      const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", currentUser.id).maybeSingle();
      isAdmin = !!(prof && prof.is_admin);
    } else { isAdmin = false; }

    const btn = document.getElementById("sbln-admin-btn");
    if (isAdmin) {
      btn.innerHTML = `<span class="sbln-dot"></span>Admin <span class="sbln-caret">▾</span>`;
      const em = document.getElementById("sbln-email");
      if (em) em.textContent = currentUser.email || "admin";
    } else {
      btn.textContent = "Admin";
      closeMenus();
    }
    applyPostseasonVisibility();
    setNavHeight();
    // Notify the page (for its own gating).
    if (typeof window.onSBLAuth === "function") { try { window.onSBLAuth({ session: session || null, isAdmin }); } catch (e) {} }
    window.dispatchEvent(new CustomEvent("sbl-auth", { detail: { session: session || null, isAdmin } }));
    resolveReady({ session: session || null, isAdmin });
  }

  function openLogin() {
    closeMenus();
    const modal = document.getElementById("sbln-modal");
    modal.innerHTML = `<h3>Admin Login</h3><p>Enter your admin email and we’ll send a magic sign-in link.</p>`
      + `<input type="email" id="sbln-login-email" placeholder="you@example.com" autocomplete="email">`
      + `<div class="sbln-modal-actions"><button class="sbln-btn" id="sbln-login-cancel">Cancel</button>`
      + `<button class="sbln-btn sbln-btn-accent" id="sbln-login-send">Send link</button></div>`;
    document.getElementById("sbln-modal-overlay").hidden = false;
    const email = document.getElementById("sbln-login-email");
    setTimeout(() => email.focus(), 30);
    email.addEventListener("keydown", e => { if (e.key === "Enter") sendMagicLink(); });
    document.getElementById("sbln-login-cancel").addEventListener("click", closeModal);
    document.getElementById("sbln-login-send").addEventListener("click", sendMagicLink);
  }
  function closeModal() { const m = document.getElementById("sbln-modal-overlay"); if (m) m.hidden = true; }
  async function sendMagicLink() {
    const email = (document.getElementById("sbln-login-email").value || "").trim();
    if (!email) { toast("Enter an email first.", "err"); return; }
    const btn = document.getElementById("sbln-login-send"); btn.disabled = true; btn.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { toast("Could not send link: " + error.message, "err"); btn.disabled = false; btn.textContent = "Send link"; return; }
    closeModal(); toast("Magic link sent to " + email + ".", "ok");
  }
  async function doLogout() { closeMenus(); await sb.auth.signOut(); toast("Logged out.", "ok"); }

  function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "sbln-toast" + (kind ? " " + kind : "");
    t.textContent = msg;
    document.getElementById("sbln-toasts").appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3200);
  }

  // ── postseason tab visibility (published OR admin) ──
  function applyPostseasonVisibility() {
    const tab = document.getElementById("sbln-tab-postseason");
    if (!tab) return;
    tab.hidden = !(postseasonVisible || isAdmin);
  }

  // ── data load (season + teams for the dropdown) ──
  async function loadData() {
    try {
      const { data: s } = await sb.from("seasons").select("id, name, postseason_published").eq("is_current", true).maybeSingle();
      season = s || null;
      postseasonVisible = !!(season && season.postseason_published);
      applyPostseasonVisibility();
      if (!season) return;
      const [teamsRes, ownersRes] = await Promise.all([
        sb.from("teams").select("id, name, slug, initial_seed").eq("season_id", season.id),
        sb.from("team_owners").select("team_id, ended_week, players(display_name)"),
      ]);
      allTeams = teamsRes.data || [];
      const ids = new Set(allTeams.map(t => t.id));
      (ownersRes.data || []).filter(o => ids.has(o.team_id) && o.ended_week == null && o.players).forEach(o => { coachByTeam[o.team_id] = o.players.display_name; });
    } catch (e) { console.error("nav.js loadData:", e); /* nav still works without the team list */ }
  }

  // ── boot ──
  function start() {
    injectStyle();
    buildNav();
    loadData();
    sb.auth.getSession().then(({ data: { session } }) => applySession(session));
    // Defer out of the callback: onAuthStateChange runs while the auth lock is held,
    // and applySession makes a Supabase call (profiles), which would deadlock the lock.
    sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => applySession(s), 0); });
  }

  window.SBLNav = { ready, get isAdmin() { return isAdmin; }, get user() { return currentUser; } };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
