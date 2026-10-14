const socket = io();
const $ = (id) => document.getElementById(id);

async function loadOperatorIdentity() {
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      location.replace("/login");
      return;
    }
    const payload = await response.json();
    // Development login bypass: the server hands out an admin session, so the
    // sign-out button would only drop us back onto the same dashboard.
    if (payload.loginBypass) {
      const logout = $("logoutBtn");
      if (logout) {
        logout.style.display = "none";
        logout.setAttribute("aria-hidden", "true");
      }
    }
    const username = payload.user?.username || "Operator";
    const name = $("operatorName");
    if (name) name.textContent = username;
    const avatar = $("userAvatar");
    if (avatar) avatar.textContent = username.charAt(0).toUpperCase();
    const healthResponse = await fetch("/api/health");
    if (healthResponse.ok) {
      const health = await healthResponse.json();
      const el = $("storageMode");
      if (el) el.textContent = health.storageMode || "LOCAL STORAGE";
    }
  } catch {
    /* socket connection indicator reports backend availability */
  }
}
$("logoutBtn")?.addEventListener("click", async () => {
  if (!confirm("Sign out of the operator dashboard?")) return;
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } finally {
    location.replace("/login");
  }
});
socket.on("connect_error", (err) => {
  if ((err.message || "").toLowerCase().includes("unauthorized"))
    location.replace("/login");
});
loadOperatorIdentity();

let state = null,
  registrations = [],
  activePage = "overview",
  standingsMode = "overall",
  registrationFilter = "pending",
  toastTimer,
  pendingTeamEdits = new Map(),
  pendingMatchTeamIds = null,
  lineupDirty = false;
const pageMeta = {
  overview: [
    "OVERVIEW",
    "Production overview",
    "Monitor match operations, scoring and broadcast readiness.",
  ],
  live: [
    "LIVE OPERATIONS",
    "Live match operations",
    "Record live events, manage squads and verify results.",
  ],
  teams: [
    "TEAMS & GROUPS",
    "Teams & group allocation",
    "Manage squad names, players and group assignments.",
  ],
  standings: [
    "RESULTS & STANDINGS",
    "Results & standings",
    "Review official results, cumulative points and qualification.",
  ],
  broadcast: [
    "BROADCAST CONTROL",
    "Broadcast control",
    "Manage the on-air graphic state connected to your OBS overlay.",
  ],
  settings: [
    "TOURNAMENT SETUP",
    "Tournament setup",
    "Configure event identity, scoring, registration and qualification slots.",
  ],
  registrations: [
    "TEAM INTAKE",
    "Team registration desk",
    "Review incoming team registrations and publish approved rosters directly to tournament operations.",
  ],
};
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}
function safe(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function fmtDate(value) {
  try {
    return new Date(value).toLocaleString([], {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
function sortedOverall() {
  return [...(state?.teams || [])].sort(
    (a, b) =>
      b.overallPoints - a.overallPoints ||
      b.overallKills - a.overallKills ||
      a.name.localeCompare(b.name),
  );
}
function sortedCurrent() {
  return [...(state?.teams || [])].sort(
    (a, b) =>
      (a.placement || 999) - (b.placement || 999) ||
      b.kills - a.kills ||
      a.name.localeCompare(b.name),
  );
}
function showPage(page) {
  if (!pageMeta[page]) return;
  activePage = page;
  document
    .querySelectorAll(".page")
    .forEach((el) => el.classList.toggle("active", el.id === `page-${page}`));
  document
    .querySelectorAll(".nav-item")
    .forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("pageCrumb").textContent = pageMeta[page][0];
  $("pageTitle").textContent = pageMeta[page][1];
  $("pageDescription").textContent = pageMeta[page][2];
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document
  .querySelectorAll("[data-page]")
  .forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));
document
  .querySelectorAll("[data-goto]")
  .forEach((b) => b.addEventListener("click", () => showPage(b.dataset.goto)));
socket.on("connect", () => {
  $("connection").textContent = "CONNECTED";
  $("connectionDot").classList.add("online");
  toast("Control server connected.");
});
socket.on("disconnect", () => {
  $("connection").textContent = "DISCONNECTED";
  $("connectionDot").classList.remove("online");
  toast("Connection lost. Changes are not being submitted.");
});
socket.on("operator:error", (message) => toast(message));
socket.on("tournament:update", (data) => {
  state = data;
  if (!lineupDirty) pendingMatchTeamIds = [...(data.matchTeamIds || [])];
  render();
});
socket.on("registrations:update", (data) => {
  registrations = Array.isArray(data) ? data : [];
  renderRegistrations();
});
socket.on("registration:reviewed", (data) =>
  toast(
    `Registration ${data.status}${data.teamId ? ` · assigned team slot #${data.teamId}` : ""}`,
  ),
);
function render() {
  if (!state) return;
  const name = state.tournamentName || "BGMI TOURNAMENT";
  $("sideEventName").textContent = name;
  $("overviewEventName").textContent = name;
  $("overviewEventMeta").textContent =
    `${state.registrationCount || 0} approved teams · ${state.format || "Tournament series"} · ${state.organizer || "Production workspace"}`;
  $("overviewMatch").textContent =
    `MATCH ${String(state.currentMatch).padStart(2, "0")}`;
  $("overviewMap").textContent =
    `${state.currentMap || "ERANGEL"} · GROUP ${state.currentGroup || "A"}`;
  $("statTeams").textContent =
    `${state.registrationCount || state.teams.filter((t) => t.registered).length || 0} / ${state.registrationSettings?.maxTeams || 96}`;
  $("registrationNavCount").textContent =
    `${state.pendingRegistrationCount || registrations.filter((r) => r.status === "pending").length} NEW`;
  $("regApprovedCount").textContent =
    state.registrationCount ||
    state.teams.filter((t) => t.registered).length ||
    0;
  $("regPendingCount").textContent =
    state.pendingRegistrationCount ||
    registrations.filter((r) => r.status === "pending").length;
  $("regCapacityCount").textContent =
    `${state.reservedRegistrationCount ?? (state.registrationCount || 0) + (state.pendingRegistrationCount || 0)} / ${state.registrationSettings?.maxTeams || 96}`;
  $("regCapacityNote").textContent =
    `${Math.max(0, (state.registrationSettings?.maxTeams || 96) - (state.reservedRegistrationCount ?? (state.registrationCount || 0) + (state.pendingRegistrationCount || 0)))} slots remaining`;
  $("regOpenState").textContent =
    state.registrationSettings?.open === false ? "CLOSED" : "OPEN";
  $("statMatches").textContent = (state.matchHistory || []).length;
  const leader = sortedOverall()[0];
  $("statLeader").textContent =
    leader && leader.overallPoints > 0 ? leader.name : "—";
  $("leaderPoints").textContent =
    leader && leader.overallPoints > 0
      ? `${leader.overallPoints} overall points`
      : "No points published yet";
  const status = (state.matchStatus || "upcoming")
    .toUpperCase()
    .replaceAll("-", " ");
  $("statStatus").textContent = status;
  $("statusHelp").textContent =
    {
      UPCOMING: "Ready for operator setup",
      LIVE: "Live event controls enabled",
      "AWAITING VERIFICATION": "Review scores before publishing",
      VERIFIED: "Official results are locked",
    }[status] || "Match status";
  $("matchStatusPill").textContent = `● ${status}`;
  $("liveNavStatus").textContent =
    status === "LIVE" ? "ON AIR" : status === "VERIFIED" ? "LOCKED" : "READY";
  $("onAirText").textContent = (state.broadcastState || "pre-show")
    .toUpperCase()
    .replaceAll("-", " ");
  $("broadcastCurrent").textContent = $("onAirText").textContent;
  $("matchNumberInput").value = state.currentMatch;
  $("matchGroupInput").value = state.currentGroup || "A";
  $("matchMapInput").value = state.currentMap || "Erangel";
  document
    .querySelectorAll("[data-scene]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.scene === state.broadcastState),
    );
  document
    .querySelectorAll("[data-stream-start]")
    .forEach((b) =>
      b.classList.toggle("active", state.broadcastState === "stream-start"),
    );
  document
    .querySelectorAll("[data-mvp-mode]")
    .forEach((b) =>
      b.classList.toggle(
        "active",
        state.broadcastState === "mvp" &&
          b.dataset.mvpMode === (state.production?.mvpMode || "match"),
      ),
    );
  document
    .querySelectorAll("[data-countdown]")
    .forEach((b) =>
      b.classList.toggle("active", state.broadcastState === "countdown"),
    );
  renderWorkflow();
  renderEvents($("overviewEvents"), (state.eventLog || []).slice(0, 8));
  renderEvents($("liveEvents"), (state.eventLog || []).slice(0, 100));
  renderOverviewStandings();
  renderLiveTeams();
  renderTeamAdmin();
  renderMatchTeamPicker();
  renderStandings();
  renderSettings();
  renderRegistrationSummary();
  renderProductionAssets();
  $("airEvent").textContent = name;
  $("airMatch").textContent =
    `${String(state.currentMatch).padStart(2, "0")} / GROUP ${state.currentGroup}`;
  $("airMap").textContent = state.currentMap || "Erangel";
  $("verifyStatus").textContent =
    status === "VERIFIED"
      ? "VERIFIED & LOCKED"
      : status === "AWAITING VERIFICATION"
        ? "AWAITING REVIEW"
        : "NOT VERIFIED";
  $("verifyResults").disabled = status === "VERIFIED";
  $("startMatch").disabled = status === "VERIFIED";
  $("quickLive").textContent =
    status === "LIVE" ? "● Match live" : "▶ Start match";
  $("overlayHealth").textContent = "Dashboard connected · open /overlay in OBS";
  $("overlayHealthDot").classList.add("online");
}
function renderWorkflow() {
  const items = [
    [
      "Match configured",
      `${state.currentMap} · Group ${state.currentGroup}`,
      !!state.currentMatch,
    ],
    [
      "Live operations",
      state.matchStatus === "live"
        ? "Match in progress"
        : "Start the match to enable live operations",
      state.matchStatus === "live",
    ],
    [
      "Results verification",
      state.matchStatus === "verified"
        ? "Results locked and published"
        : state.matchStatus === "awaiting-verification"
          ? "Ready for final review"
          : "Awaiting match end",
      state.matchStatus === "verified",
    ],
    [
      "Broadcast state",
      (state.broadcastState || "pre-show").replaceAll("-", " "),
      true,
    ],
  ];
  $("workflow").innerHTML = items
    .map(
      (it, i) =>
        `<div class="workflow-step ${it[2] ? "done" : ""}"><span class="step-icon">${it[2] ? "✓" : String(i + 1).padStart(2, "0")}</span><div><b>${safe(it[0])}</b><small>${safe(it[1])}</small></div><span class="step-state">${it[2] ? "READY" : "PENDING"}</span></div>`,
    )
    .join("");
}
function renderEvents(container, events) {
  container.innerHTML = "";
  if (!events.length) {
    container.innerHTML =
      '<div class="empty-state">No events recorded yet.<br>Match activity will appear here.</div>';
    return;
  }
  events.forEach((e) => {
    const row = document.createElement("div");
    row.className = "event-row";
    const dot = document.createElement("i");
    dot.className = "event-dot";
    const body = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = e.description || e.action || e.type || "Tournament event";
    const small = document.createElement("small");
    small.textContent = `MATCH ${String(e.matchNumber || state.currentMatch).padStart(2, "0")} · ${e.group || state.currentGroup || "A"}`;
    body.append(b, small);
    const time = document.createElement("time");
    time.textContent = fmtDate(e.at);
    row.append(dot, body, time);
    container.append(row);
  });
}
function renderOverviewStandings() {
  const rows = sortedOverall().slice(0, 8);
  $("overviewStandings").innerHTML = rows
    .map(
      (t, i) =>
        `<tr><td class="${i < 3 ? "rank-top" : ""}">${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td><span class="group-chip">${safe(t.group || "A")}</span></td><td>${t.overallMatches || 0}</td><td>${t.overallKills || 0}</td><td class="points-cell">${t.overallPoints || 0}</td></tr>`,
    )
    .join("");
}
function selectedMatchIds() {
  return (
    pendingMatchTeamIds !== null
      ? pendingMatchTeamIds
      : state?.matchTeamIds || []
  ).map(Number);
}
function renderLiveTeams() {
  const filter = $("liveGroupFilter").value || "all";
  const ids = new Set(state.matchTeamIds || []);
  const teams = state.teams.filter(
    (t) => ids.has(t.id) && (filter === "all" || t.group === filter),
  );
  $("liveTeamCount").textContent = `${teams.length} / ${ids.size} SQUADS`;
  $("liveTeams").innerHTML = "";
  if (!teams.length) {
    $("liveTeams").innerHTML =
      '<div class="empty-state">No squads match this filter. Set the match lineup above or change the filter.</div>';
    return;
  }
  teams.forEach((t) => {
    const card = document.createElement("article");
    card.className = "squad-card";
    card.innerHTML = `
      <header class="squad-card-head">
        <div class="squad-identity">
          <span class="squad-id">#${String(t.id).padStart(2, "0")}</span>
          ${t.logo ? `<img class="squad-logo" src="${safe(t.logo)}" alt="" onerror="this.style.display='none'">` : ""}
          <div class="squad-name">
            <small>ACTIVE SQUAD</small>
            <b title="${safe(t.name)}">${safe(t.name)}</b>
          </div>
        </div>
        <div class="squad-score">
          <small>MATCH POINTS</small>
          <strong class="squad-pts">${t.matchPoints}</strong>
        </div>
      </header>
      <div class="squad-badges">
        <span class="group-chip">GROUP ${safe(t.group || "A")}</span>
        ${t.registered ? '<span class="registered-chip">VERIFIED ROSTER</span>' : '<span class="placeholder-chip">ROSTER SLOT</span>'}
      </div>
      <div class="squad-stats">
        <span><small>FINISHES</small><b>${t.kills}</b></span>
        <span><small>PLACEMENT</small><b>${t.placement || "—"}</b></span>
        <span><small>OVERALL</small><b>${t.overallPoints || 0}</b></span>
      </div>
      <div class="squad-actions">
        <span class="control-label">MATCH INPUTS</span>
        <div class="mini-actions">
          <button class="finish-plus" data-action="plus" data-id="${t.id}">+ UNASSIGNED FINISH</button>
          <button class="finish-minus" data-action="minus" data-id="${t.id}">−</button>
          <label class="placement-label">PLACE <input class="placement-input" type="number" min="0" max="${ids.size}" value="${t.placement || 0}" data-placement="${t.id}" aria-label="Placement for ${safe(t.name)}"></label>
          <button data-action="edit" data-id="${t.id}">EDIT ROSTER</button>
        </div>
      </div>
      <div class="player-ops">
        ${t.players.map((p, i) => `
          <div class="player-op">
            <div class="player-op-head">
              ${p.avatarUrl ? `<img class="player-avatar-mini" src="${safe(p.avatarUrl)}" alt="" onerror="this.style.display='none'">` : ""}
              <div>
                <small>PLAYER ${String(i + 1).padStart(2, "0")}</small>
                <b>${safe(p.name)}</b>
                <small class="player-uid-note">UID ${safe(p.uid || "NOT ENTERED")}</small>
              </div>
              <strong class="player-kill-count">${Number(p.kills) || 0} FIN</strong>
            </div>
            <div class="player-op-actions">
              <button class="player-kill-plus" data-player-kill-team="${t.id}" data-player-kill-index="${i}" data-amount="1">+ PLAYER FINISH</button>
              <button class="player-kill-minus" data-player-kill-team="${t.id}" data-player-kill-index="${i}" data-amount="-1">−</button>
              <label class="player-damage-control">DMG <input type="number" min="0" max="50000" step="1" value="${Number(p.damage) || 0}" data-player-damage-team="${t.id}" data-player-damage-index="${i}" aria-label="Damage for ${safe(p.name)}"></label>
            </div>
            <div class="player-statuses">
              <button class="alive ${p.status === "alive" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="alive">ALIVE</button>
              <button class="knocked ${p.status === "knocked" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="knocked">KNOCK</button>
              <button class="eliminated ${p.status === "eliminated" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="eliminated">OUT</button>
            </div>
          </div>`).join("")}
      </div>`;
    $("liveTeams").append(card);
  });
}
function renderMatchTeamPicker() {
  if (!state) return;
  const q = ($("lineupSearch")?.value || "").toLowerCase();
  const checked = new Set(selectedMatchIds());
  const groupFilter = $("liveGroupFilter")?.value || "all";
  const teams = (state.teams || []).filter(
    (t) =>
      (groupFilter === "all" || t.group === groupFilter) &&
      (t.name.toLowerCase().includes(q) || String(t.id).includes(q)),
  );
  $("lineupTeamPicker").innerHTML = teams
    .map(
      (t) =>
        `<label class="lineup-team ${checked.has(t.id) ? "selected" : ""}"><input type="checkbox" data-lineup-team="${t.id}" ${checked.has(t.id) ? "checked" : ""} ${!checked.has(t.id) && checked.size >= 16 ? "disabled" : ""}><span class="lineup-team-id">#${String(t.id).padStart(2, "0")}</span><span class="lineup-team-copy"><b>${safe(t.name)}</b><small>${safe(t.college || "Tournament roster")} · GROUP ${safe(t.group || "A")}</small></span><span class="lineup-mark">${t.registered ? "REG" : "SLOT"}</span></label>`,
    )
    .join("");
  const visibleSelected = teams.filter((t) => checked.has(t.id)).length;
  $("selectedLineupCount").textContent =
    groupFilter === "all"
      ? `${checked.size} / 16 SELECTED`
      : `${visibleSelected} OF ${checked.size} SELECTED · GROUP ${groupFilter}`;
  const hiddenSelected = checked.size - visibleSelected;
  $("lineupTeamPicker").querySelector("[data-filter-note]")?.remove();
  if (hiddenSelected > 0 && groupFilter !== "all") {
    const note = document.createElement("div");
    note.dataset.filterNote = "true";
    note.className = "lineup-filter-note";
    note.textContent = `${hiddenSelected} selected squad(s) are outside Group ${groupFilter}. Choose All teams to review the complete lineup.`;
    $("lineupTeamPicker").prepend(note);
  }
  if (!teams.length)
    $("lineupTeamPicker").innerHTML =
      '<div class="empty-state">No team matches that search.</div>';
}
$("lineupTeamPicker").addEventListener("change", (e) => {
  const input = e.target.closest("[data-lineup-team]");
  if (!input) return;
  const id = Number(input.dataset.lineupTeam);
  const set = new Set(selectedMatchIds());
  if (input.checked) {
    if (set.size >= 16) {
      input.checked = false;
      toast("A match lineup can contain at most 16 teams.");
      return;
    }
    set.add(id);
  } else set.delete(id);
  pendingMatchTeamIds = [...set];
  lineupDirty = true;
  renderMatchTeamPicker();
});
$("lineupSearch").addEventListener("input", renderMatchTeamPicker);
$("loadGroupLineup").addEventListener("click", () => {
  const source = $("lineupSourceGroup").value;
  $("liveGroupFilter").value = ["A", "B", "C", "D", "E", "F"].includes(
    source,
  )
    ? source
    : "all";
  let teams = state.teams.filter(
    (t) =>
      source === "all" ||
      (source === "registered" ? t.registered : t.group === source),
  );
  if (teams.length > 16) {
    teams = teams.slice(0, 16);
    toast(
      "Loaded the first 16 teams in this selection. You can edit the lineup below.",
    );
  }
  pendingMatchTeamIds = teams.map((t) => t.id);
  lineupDirty = true;
  renderMatchTeamPicker();
});
$("clearLineup").addEventListener("click", () => {
  pendingMatchTeamIds = [];
  lineupDirty = true;
  renderMatchTeamPicker();
});
$("liveTeams").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const id = Number(b.dataset.id);
  if (b.dataset.action === "plus")
    socket.emit("team:kill", { teamId: id, amount: 1 });
  if (b.dataset.action === "minus")
    socket.emit("team:kill", { teamId: id, amount: -1 });
  if (b.dataset.action === "edit") {
    const t = state.teams.find((x) => x.id === id);
    if (!t) return;
    const name = prompt("Team name", t.name);
    if (name === null) return;
    const group = prompt("Group (A-F)", t.group || "A");
    if (group === null) return;
    const players = t.players.map((p, i) => ({
      name: prompt(`Player ${i + 1} name`, p.name) ?? p.name,
      status: p.status,
    }));
    socket.emit("team:update", {
      teamId: id,
      updates: { name, group, players },
    });
  }
});
$("liveTeams").addEventListener("change", (e) => {
  if (e.target.matches("[data-placement]"))
    socket.emit("team:update", {
      teamId: Number(e.target.dataset.placement),
      updates: { placement: Number(e.target.value) },
    });
  if (e.target.matches("[data-player-damage-team]"))
    socket.emit("player:damage", {
      teamId: Number(e.target.dataset.playerDamageTeam),
      playerIndex: Number(e.target.dataset.playerDamageIndex),
      damage: Number(e.target.value),
    });
});
$("liveTeams").addEventListener("click", (e) => {
  const kill = e.target.closest("[data-player-kill-team]");
  if (kill) {
    socket.emit("player:kill", {
      teamId: Number(kill.dataset.playerKillTeam),
      playerIndex: Number(kill.dataset.playerKillIndex),
      amount: Number(kill.dataset.amount),
    });
    return;
  }
  const b = e.target.closest("[data-player]");
  if (b)
    socket.emit("player:update", {
      teamId: Number(b.dataset.player),
      playerIndex: Number(b.dataset.index),
      status: b.dataset.status,
    });
});
$("liveGroupFilter").addEventListener("change", () => {
  if (!state) return;
  const filter = $("liveGroupFilter").value,
    phase = $("matchGroupInput").value;
  $("lineupSourceGroup").value = ["A", "B", "C", "D", "E", "F"].includes(
    filter,
  )
    ? filter
    : "all";
  if (
    ["A", "B", "C", "D", "E", "F"].includes(filter) &&
    phase === filter &&
    state.matchStatus !== "verified"
  ) {
    const groupIds = state.teams
      .filter((t) => t.group === filter)
      .slice(0, 16)
      .map((t) => t.id);
    const active = [...(state.matchTeamIds || [])];
    if (
      groupIds.length >= 2 &&
      (groupIds.length !== active.length ||
        groupIds.some((id) => !active.includes(id)))
    ) {
      const hasInput = state.teams.some(
        (t) =>
          active.includes(t.id) &&
          (Number(t.kills) > 0 ||
            Number(t.placement) > 0 ||
            t.players?.some(
              (p) => Number(p.kills) > 0 || p.status !== "alive",
            )),
      );
      if (
        hasInput &&
        !confirm(
          `Load Group ${filter} as the active lineup? Unverified match inputs may be reset when the lineup changes.`,
        )
      ) {
        renderLiveTeams();
        renderMatchTeamPicker();
        return;
      }
      socket.emit("match:configure", {
        number: Number($("matchNumberInput").value) || state.currentMatch,
        group: filter,
        map: $("matchMapInput").value || state.currentMap,
        teamIds: groupIds,
      });
      pendingMatchTeamIds = groupIds;
      lineupDirty = false;
      toast(`Loading Group ${filter} lineup…`);
    }
  }
  renderLiveTeams();
  renderMatchTeamPicker();
});
function renderTeamAdmin() {
  const search = ($("teamSearch").value || "").toLowerCase();
  const group = $("teamGroupFilter").value;
  const teams = state.teams.filter(
    (t) =>
      (group === "all" || t.group === group) &&
      (t.name.toLowerCase().includes(search) || String(t.id).includes(search)),
  );
  $("teamAdminRows").innerHTML = teams
    .map(
      (t) =>
        `<tr data-teamrow="${t.id}"><td>${String(t.id).padStart(2, "0")}</td><td><input data-edit="name" value="${safe(pendingValue(t.id, "name", t.name))}" maxlength="48" aria-label="Team ${t.id} name"></td><td><select data-edit="group">${["A", "B", "C", "D", "E", "F"].map((g) => `<option ${pendingValue(t.id, "group", t.group) === g ? "selected" : ""}>${g}</option>`).join("")}</select></td>${t.players.map((p, i) => `<td><input data-edit="player${i}" value="${safe(pendingValue(t.id, `player${i}`, p.name))}" maxlength="32" aria-label="${safe(t.name)} player ${i + 1}"><small class="team-uid-note">UID ${safe(p.uid || "—")}</small></td>`).join("")}<td><span class="${t.registered ? "registered-chip" : "placeholder-chip"}">${t.registered ? "REGISTERED" : "OPEN SLOT"}</span></td><td>${t.overallPoints || 0}</td></tr>`,
    )
    .join("");
}
function pendingValue(id, key, fallback) {
  return pendingTeamEdits.has(id + "|" + key)
    ? pendingTeamEdits.get(id + "|" + key)
    : fallback;
}
$("teamAdminRows").addEventListener("input", (e) => {
  const row = e.target.closest("[data-teamrow]");
  if (!row || !e.target.dataset.edit) return;
  pendingTeamEdits.set(
    row.dataset.teamrow + "|" + e.target.dataset.edit,
    e.target.value,
  );
});
$("teamAdminRows").addEventListener("change", (e) => {
  const row = e.target.closest("[data-teamrow]");
  if (!row || !e.target.dataset.edit) return;
  pendingTeamEdits.set(
    row.dataset.teamrow + "|" + e.target.dataset.edit,
    e.target.value,
  );
});
$("saveTeamEdits").addEventListener("click", () => {
  const byTeam = new Map();
  for (const [key, value] of pendingTeamEdits) {
    const [id, field] = key.split("|");
    if (!byTeam.has(Number(id))) byTeam.set(Number(id), {});
    const obj = byTeam.get(Number(id));
    if (field === "name" || field === "group") obj[field] = value;
    else if (field.startsWith("player")) {
      obj.players ||= state.teams
        .find((t) => t.id === Number(id))
        .players.map((p) => ({ ...p }));
      obj.players[Number(field.slice(6))].name = value;
    }
  }
  for (const [teamId, updates] of byTeam)
    socket.emit("team:update", { teamId, updates });
  pendingTeamEdits.clear();
  toast(`Saving edits for ${byTeam.size} team(s)…`);
});
$("teamSearch").addEventListener("input", renderTeamAdmin);
$("teamGroupFilter").addEventListener("change", renderTeamAdmin);
$("generateRoster").addEventListener("click", () => {
  const count = Number($("rosterCount").value);
  if (
    confirm(
      `Resize the roster to ${count} teams? Existing records for retained team IDs will be preserved.`,
    )
  )
    socket.emit("teams:generate", { count });
});
function renderStandings() {
  const rowsEl = $("standingsRows"),
    head = $("standingsHead"),
    history = $("historyList");
  history.classList.add("hidden");
  head.classList.remove("hidden");
  rowsEl.classList.remove("hidden");
  let teams = [],
    columns = "",
    heading = "",
    sub = "";
  if (standingsMode === "overall") {
    teams = sortedOverall();
    heading = "Tournament leaderboard";
    sub = "Sorted by official cumulative points.";
    columns =
      "<tr><th>RANK</th><th>TEAM</th><th>GROUP</th><th>MATCHES</th><th>FINISHES</th><th>OVERALL PTS</th></tr>";
  } else if (standingsMode === "current") {
    teams = sortedCurrent().filter((t) =>
      (state.matchTeamIds || []).includes(t.id),
    );
    heading = `Match ${String(state.currentMatch).padStart(2, "0")} results`;
    sub = "Current match inputs. These are official only after verification.";
    columns =
      "<tr><th>RANK</th><th>TEAM</th><th>GROUP</th><th>PLACEMENT</th><th>FINISHES</th><th>MATCH PTS</th></tr>";
  } else if (standingsMode === "qualification") {
    teams = sortedOverall();
    heading = "Qualification projection";
    sub = `Top ${state.qualification?.semifinalSlots || 24} projected semifinal slots and top ${state.qualification?.finalSlots || 16} final slots. Configure actual tournament rules before use.`;
    columns =
      "<tr><th>RANK</th><th>TEAM</th><th>GROUP</th><th>OVERALL PTS</th><th>SEMIFINAL</th><th>GRAND FINAL</th></tr>";
  } else {
    head.classList.add("hidden");
    rowsEl.classList.add("hidden");
    history.classList.remove("hidden");
    heading = "Finalized match history";
    sub = "Published result snapshots and their match details.";
    history.innerHTML = "";
    const matches = [...(state.matchHistory || [])].sort(
      (a, b) => b.matchNumber - a.matchNumber,
    );
    if (!matches.length)
      history.innerHTML =
        '<div class="empty-state">No matches have been verified and published yet.</div>';
    matches.forEach((m) => {
      const el = document.createElement("div");
      el.className = "history-item";
      const left = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = `Match ${String(m.matchNumber).padStart(2, "0")} · Group ${m.group || "A"} · ${m.map || "Map not set"}`;
      const sm = document.createElement("small");
      sm.textContent = `${m.results.length} team records · ${fmtDate(m.finalizedAt)} · ${m.verified ? "VERIFIED" : "LEGACY SNAPSHOT"}`;
      left.append(b, sm);
      const right = document.createElement("b");
      right.textContent = `${m.results.reduce((n, r) => n + r.matchPoints, 0)} PTS`;
      el.append(left, right);
      history.append(el);
    });
  }
  $("standingsHeading").textContent = heading;
  $("standingsSub").textContent = sub;
  $("standingsCount").textContent =
    standingsMode === "history"
      ? `${(state.matchHistory || []).length} MATCHES`
      : `${teams.length} TEAMS`;
  $("standingsHead").innerHTML = columns;
  if (standingsMode === "overall")
    rowsEl.innerHTML = teams
      .map(
        (t, i) =>
          `<tr><td class="${i < 3 ? "rank-top" : ""}">${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td><span class="group-chip">${safe(t.group || "A")}</span></td><td>${t.overallMatches || 0}</td><td>${t.overallKills || 0}</td><td class="points-cell">${t.overallPoints || 0}</td></tr>`,
      )
      .join("");
  if (standingsMode === "current")
    rowsEl.innerHTML = teams
      .map(
        (t, i) =>
          `<tr><td>${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td>${safe(t.group || "A")}</td><td>${t.placement || "—"}</td><td>${t.kills}</td><td class="points-cell">${t.matchPoints}</td></tr>`,
      )
      .join("");
  if (standingsMode === "qualification") {
    const semi = Number(state.qualification?.semifinalSlots || 24),
      final = Number(state.qualification?.finalSlots || 16);
    rowsEl.innerHTML = teams
      .map(
        (t, i) =>
          `<tr><td class="${i < 3 ? "rank-top" : ""}">${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td>${safe(t.group || "A")}</td><td class="points-cell">${t.overallPoints || 0}</td><td>${i < semi ? '<span class="qual-yes">PROJECTED</span>' : "—"}</td><td>${i < final ? '<span class="qual-yes">PROJECTED</span>' : "—"}</td></tr>`,
      )
      .join("");
  }
}
document.querySelectorAll("[data-standings]").forEach((b) =>
  b.addEventListener("click", () => {
    standingsMode = b.dataset.standings;
    document
      .querySelectorAll("[data-standings]")
      .forEach((x) => x.classList.toggle("active", x === b));
    renderStandings();
  }),
);
function renderSettings() {
  if (
    document.activeElement?.matches(
      "#settingName,#settingOrganizer,#settingFormat,#settingFinishPoint,#settingSemiSlots,#settingFinalSlots,#settingRegistrationCapacity,#settingRegistrationOpen,[data-placepoints]",
    )
  )
    return;
  $("settingName").value = state.tournamentName || "";
  $("settingOrganizer").value = state.organizer || "";
  $("settingFormat").value = state.format || "";
  $("settingFinishPoint").value = state.scoringRules?.finishPoint ?? 1;
  $("settingSemiSlots").value = state.qualification?.semifinalSlots || 24;
  $("settingFinalSlots").value = state.qualification?.finalSlots || 16;
  $("settingRegistrationCapacity").value =
    state.registrationSettings?.maxTeams || 96;
  $("settingRegistrationOpen").value =
    state.registrationSettings?.open === false ? "false" : "true";
  const rules = state.scoringRules?.placementPoints || {};
  $("placementRules").innerHTML = Array.from({ length: 8 }, (_, i) => i + 1)
    .map(
      (p) =>
        `<label class="rule-item"><small>${p === 1 ? "1ST" : p === 2 ? "2ND" : p === 3 ? "3RD" : p + "TH"} PLACE</small><input type="number" min="0" max="100" data-placepoints="${p}" value="${Number(rules[p] || 0)}"></label>`,
    )
    .join("");
}
function renderProductionAssets() {
  const prod = state?.production || {},
    caster = prod.caster || {},
    map = prod.mapFeed || {};
  const ids = [
    "prodEventLogo",
    "prodThemeMusic",
    "prodStreamStartMinutes",
    "prodCasterName",
    "prodCasterTagline",
    "prodCasterImage",
    "prodMapImage",
    "prodBroadcastStage",
    "prodBroadcastDay",
    "prodBroadcastGroupLabel",
    "prodBroadcastMatchCaption",
  ];
  if (ids.some((id) => document.activeElement === $(id))) return;
  $("prodEventLogo").value = prod.eventLogoUrl || "";
  $("prodThemeMusic").value = prod.themeMusicUrl || "";
  $("prodStreamStartMinutes").value = Math.round(
    (Number(prod.streamStartDurationSeconds) || 1200) / 60,
  );
  $("prodCasterName").value = caster.name || "";
  $("prodCasterTagline").value = caster.tagline || "";
  $("prodCasterImage").value = caster.imageUrl || "";
  $("prodMapImage").value = map.imageUrl || "";
  $("prodBroadcastStage").value = prod.broadcastStageLabel || "GROUP STAGE";
  $("prodBroadcastDay").value = prod.broadcastDayLabel || "DAY 1";
  $("prodBroadcastGroupLabel").value = prod.broadcastGroupLabel || "";
  $("prodBroadcastMatchCaption").value = prod.broadcastMatchCaption || "";
}
$("saveProductionAssets").addEventListener("click", () => {
  const payload = {
    eventLogoUrl: $("prodEventLogo").value.trim(),
    themeMusicUrl: $("prodThemeMusic").value.trim(),
    streamStartDurationMinutes: Number($("prodStreamStartMinutes").value) || 20,
    casterName: $("prodCasterName").value.trim(),
    casterTagline: $("prodCasterTagline").value.trim(),
    casterImageUrl: $("prodCasterImage").value.trim(),
    mapImageUrl: $("prodMapImage").value.trim(),
    broadcastStageLabel: $("prodBroadcastStage").value.trim(),
    broadcastDayLabel: $("prodBroadcastDay").value.trim(),
    broadcastGroupLabel: $("prodBroadcastGroupLabel").value.trim(),
    broadcastMatchCaption: $("prodBroadcastMatchCaption").value.trim(),
  };
  for (const id of ["prodEventLogo", "prodCasterImage", "prodMapImage"]) {
    const value = $(id).value.trim();
    if (value) {
      try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        return toast("Image fields must contain valid HTTP or HTTPS URLs.");
      }
    }
  }
  const music = $("prodThemeMusic").value.trim();
  if (music && !music.startsWith("/assets/")) {
    try {
      const url = new URL(music);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    } catch {
      return toast("Theme audio must be HTTPS/HTTP or a /assets/ path.");
    }
  }
  socket.emit("production:update", payload);
  toast("Show assets sent to production server.");
});
$("saveRegistrationSettings").addEventListener("click", () => {
  socket.emit("tournament:update-settings", {
    registrationCapacity: Number($("settingRegistrationCapacity").value),
    registrationOpen: $("settingRegistrationOpen").value === "true",
  });
  toast("Registration settings submitted.");
});
$("saveSettings").addEventListener("click", () => {
  const placementPoints = {};
  document
    .querySelectorAll("[data-placepoints]")
    .forEach(
      (el) =>
        (placementPoints[el.dataset.placepoints] = Math.max(
          0,
          Math.min(100, Number(el.value) || 0),
        )),
    );
  socket.emit("tournament:update-settings", {
    tournamentName: $("settingName").value,
    organizer: $("settingOrganizer").value,
    format: $("settingFormat").value,
    finishPoint: Number($("settingFinishPoint").value),
    semifinalSlots: Number($("settingSemiSlots").value),
    finalSlots: Number($("settingFinalSlots").value),
    placementPoints,
  });
  toast("Tournament settings submitted.");
});
$("saveMatchConfig").addEventListener("click", () => {
  const number = Number($("matchNumberInput").value);
  if (!Number.isInteger(number) || number < 1 || number > 999)
    return toast("Match number must be between 1 and 999.");
  const teamIds = selectedMatchIds();
  if (teamIds.length < 2 || teamIds.length > 16)
    return toast("Select between 2 and 16 squads for this match.");
  socket.emit("match:configure", {
    number,
    group: $("matchGroupInput").value,
    map: $("matchMapInput").value,
    teamIds,
  });
  pendingMatchTeamIds = teamIds;
  lineupDirty = false;
  toast(`Saving match setup with ${teamIds.length} squads…`);
});
$("startMatch").addEventListener("click", () => {
  if (
    confirm(
      `Start Match ${$("matchNumberInput").value} and switch the overlay to LIVE MATCH?`,
    )
  )
    socket.emit("match:status", "live");
});
$("quickLive").addEventListener("click", () => {
  if (state.matchStatus === "live") return showPage("live");
  if (confirm(`Start Match ${state.currentMatch}?`))
    socket.emit("match:status", "live");
});
$("endMatch").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is already verified.");
  if (
    confirm(
      "End live operations and move this match to result review? Scores will not be published yet.",
    )
  )
    socket.emit("match:status", "awaiting-verification");
});
$("verifyResults").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is already verified.");
  const active = new Set(state.matchTeamIds || []);
  const selected = state.teams.filter((t) => active.has(t.id));
  const zero = selected.every((t) => t.kills === 0 && t.placement === 0);
  if (zero)
    return toast("Enter at least one finish or placement before publishing.");
  const placements = selected.map((t) => Number(t.placement) || 0);
  if (placements.some((p) => p < 1 || p > selected.length))
    return toast(
      `Assign a final placement from 1 to ${selected.length} to every squad before publishing. Positions 1–8 receive placement points; positions 9–${selected.length} receive zero.`,
    );
  if (new Set(placements).size !== placements.length)
    return toast(
      "Duplicate placements found. Each squad must have a unique final placement before publishing.",
    );
  if (
    !confirm(
      `Verify and publish Match ${state.currentMatch} · Group ${state.currentGroup}? This creates the official result snapshot and updates overall standings.`,
    )
  )
    return;
  socket.emit("match:finalize");
});
$("resetMatch").addEventListener("click", () => {
  if (
    confirm(
      "Clear current match finishes, placements and player statuses? Verified results remain locked.",
    )
  )
    socket.emit("match:reset");
});
document
  .querySelectorAll("[data-scene]")
  .forEach((b) =>
    b.addEventListener("click", () =>
      socket.emit("broadcast:state", b.dataset.scene),
    ),
  );
document.querySelectorAll("[data-stream-start]").forEach((b) =>
  b.addEventListener("click", () => {
    const minutes = Math.max(
      1,
      Math.min(
        180,
        Number($("prodStreamStartMinutes").value) ||
          Number(b.dataset.streamStart) ||
          20,
      ),
    );
    if (
      confirm(
        `Start the full-screen tournament slate countdown for ${minutes} minutes? When it ends, the overlay will advance to the caster scene.`,
      )
    )
      socket.emit("broadcast:stream-start", { durationMinutes: minutes });
  }),
);
document.querySelectorAll("[data-countdown]").forEach((b) =>
  b.addEventListener("click", () => {
    if (
      confirm(
        "Start a 30-second corner countdown over the full-screen caster? At zero, the overlay switches to the live match HUD.",
      )
    )
      socket.emit("broadcast:countdown", {
        durationSeconds: Number(b.dataset.countdown),
      });
  }),
);
document.querySelectorAll("[data-mvp-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    const mode = b.dataset.mvpMode;
    socket.emit("broadcast:mvp", { mode });
  }),
);
$("resetTournament").addEventListener("click", () => {
  if (
    prompt(
      "Type RESET BGMI TOURNAMENT to erase local tournament history and current scores.",
    ) === "RESET BGMI TOURNAMENT"
  )
    socket.emit("tournament:reset", "RESET BGMI TOURNAMENT");
});
$("copyOverlay").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/overlay`);
    toast("Overlay URL copied.");
  } catch {
    toast(`Overlay URL: ${location.origin}/overlay`);
  }
});

function renderRegistrationSummary() {
  const pending = registrations.filter((r) => r.status === "pending").length;
  $("registrationNavCount").textContent = `${pending} NEW`;
  const approved = registrations.filter((r) => r.status === "approved").length;
  $("regApprovedCount").textContent = approved;
  $("regPendingCount").textContent = pending;
  const cap = state?.registrationSettings?.maxTeams || 96;
  const reserved = state?.reservedRegistrationCount ?? approved + pending;
  $("regCapacityCount").textContent = `${reserved} / ${cap}`;
  $("regCapacityNote").textContent =
    `${Math.max(0, cap - reserved)} slots remaining`;
  $("regOpenState").textContent =
    state?.registrationSettings?.open === false ? "CLOSED" : "OPEN";
  renderRegistrations();
}
function renderRegistrations() {
  const root = $("registrationList");
  if (!root) return;
  const list = [...registrations]
    .filter(
      (r) => registrationFilter === "all" || r.status === registrationFilter,
    )
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  if (!list.length) {
    root.innerHTML = `<div class="empty-state">No ${registrationFilter === "all" ? "team submissions" : registrationFilter + " submissions"} yet. Share the public registration link with participating teams.</div>`;
    return;
  }
  root.innerHTML = list
    .map(
      (r) =>
        `<article class="registration-card"><div class="registration-card-top"><div><div class="registration-title"><span class="registration-code">${safe(String(r.id).slice(0, 8).toUpperCase())}</span><h4>${safe(r.teamName)}</h4><span class="registration-state ${safe(r.status)}">${safe(r.status).toUpperCase()}</span></div><p>${safe(r.college)} · Submitted ${fmtDate(r.submittedAt)}</p></div>${r.assignedTeamId ? `<div class="assigned-slot">TEAM SLOT <b>#${String(r.assignedTeamId).padStart(2, "0")}</b><small>GROUP ${safe(r.assignedGroup)}</small></div>` : ""}</div><div class="registration-details"><div><small>CAPTAIN / CONTACT</small><b>${safe(r.captainName)}</b><a href="mailto:${safe(r.email)}">${safe(r.email)}</a><span>${safe(r.phone)}</span></div><div><small>STARTING LINEUP</small><ul>${(r.playerNames || []).map((n, i) => `<li><b>${safe(n)}</b><small class="registration-player-uid">BGMI UID: ${safe((r.playerUids || [])[i] || "NOT PROVIDED")}</small></li>`).join("")}${r.substitute ? `<li class="sub-player">Sub: ${safe(r.substitute)}</li>` : ""}</ul></div><div><small>GROUP ASSIGNMENT</small>${r.status === "pending" ? `<select data-reg-group="${safe(r.id)}">${["A", "B", "C", "D", "E", "F"].map((g) => `<option value="${g}" ${(r.groupPreference || "A") === g ? "selected" : ""}>Group ${g}</option>`).join("")}</select>` : `<b>Group ${safe(r.assignedGroup || r.groupPreference || "—")}</b>`}</div></div>${r.reason ? `<p class="registration-reason">${safe(r.reason)}</p>` : ""}<div class="registration-actions">${r.status === "pending" ? `<button class="btn btn-primary" data-reg-action="approved" data-reg-id="${safe(r.id)}">✓ Approve & add to tournament</button><button class="btn btn-amber" data-reg-action="waitlisted" data-reg-id="${safe(r.id)}">Waitlist</button><button class="btn btn-danger" data-reg-action="rejected" data-reg-id="${safe(r.id)}">Reject</button>` : r.status === "approved" ? `<span class="approved-note">✓ Team profile synced to group and production roster</span>` : `<button class="btn" data-reg-action="pending" data-reg-id="${safe(r.id)}">Reopen for review</button>`}</div></article>`,
    )
    .join("");
}
document.querySelectorAll("[data-reg-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    registrationFilter = b.dataset.regFilter;
    document
      .querySelectorAll("[data-reg-filter]")
      .forEach((x) => x.classList.toggle("active", x === b));
    renderRegistrations();
  }),
);
$("registrationList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-reg-action]");
  if (!b) return;
  const registrationId = b.dataset.regId;
  const record = registrations.find((r) => r.id === registrationId);
  if (!record) return;
  const decision = b.dataset.regAction;
  if (
    decision === "pending" &&
    !confirm(`Reopen ${record.teamName} for review?`)
  )
    return;
  const group =
    $(`[data-reg-group="${CSS.escape(registrationId)}"]`)?.value ||
    record.groupPreference ||
    "A";
  let reason = "";
  if (decision === "rejected") {
    reason = prompt("Reason for rejection (optional):", "") || "";
    if (!confirm(`Reject ${record.teamName}?`)) return;
  } else if (
    decision === "approved" &&
    !confirm(
      `Approve ${record.teamName} into Group ${group} and sync its roster into tournament controls?`,
    )
  )
    return;
  socket.emit("registration:review", {
    registrationId,
    decision,
    group,
    reason,
  });
});

$("copyRegistrationUrl").addEventListener("click", async () => {
  const url = `${location.origin}/register`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Public team registration link copied.");
  } catch {
    toast(url);
  }
});
$("pingOverlay").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    $("overlayHealth").textContent =
      `Server online · ${d.connectedClients} connected client(s)`;
    $("overlayHealthDot").classList.add("online");
  } catch {
    $("overlayHealth").textContent = "Server health check failed";
    $("overlayHealthDot").classList.remove("online");
  }
});
