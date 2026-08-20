(() => {
  "use strict";

  const STORAGE_KEY = "pomonote:data:v1";
  const APP_VERSION = 1;
  const DAY_MS = 86_400_000;
  const DEFAULT_CONFIG = { focusMinutes: 25, breakMinutes: 5, sets: 4, timeBudget: 0, theme: "forest" };
  const DEFAULT_DATA = {
    version: APP_VERSION,
    sessions: [],
    timer: null,
    draftSession: null,
    config: { ...DEFAULT_CONFIG },
    settings: {
      colorMode: "system",
      soundEnabled: true,
      soundType: "chime",
      repeatSound: false,
      soundVolume: 70,
      wakeLockEnabled: false,
      declinedTrials: {}
    }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round = (value, digits = 0) => Number(value.toFixed(digits));
  const now = () => Date.now();

  let data = loadData();
  let currentPage = "home";
  let tickHandle = null;
  let lastTickAt = now();
  let wakeLock = null;
  let audioContext = null;
  let systemThemeQuery = null;
  let pendingOverdue = false;
  let weeklyChartMode = "focus";
  let weeklyOffset = 0;

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }

  function normalizeData(value) {
    const clean = cloneDefaults();
    if (!value || typeof value !== "object") return clean;
    clean.sessions = Array.isArray(value.sessions)
      ? value.sessions.filter(isValidSession).map(normalizeSession)
      : [];
    clean.timer = normalizeTimer(value.timer);
    clean.draftSession = value.draftSession && isValidSession(value.draftSession)
      ? normalizeSession(value.draftSession)
      : null;
    clean.config = normalizeConfig(value.config);
    clean.settings = {
      ...clean.settings,
      ...(value.settings && typeof value.settings === "object" ? value.settings : {})
    };
    clean.settings.colorMode = ["system", "light", "dark"].includes(clean.settings.colorMode)
      ? clean.settings.colorMode
      : "system";
    clean.settings.soundEnabled = Boolean(clean.settings.soundEnabled);
    clean.settings.soundType = ["quiet", "drop", "chime", "bell", "wood", "digital", "timer", "double", "high", "alarm"].includes(clean.settings.soundType)
      ? clean.settings.soundType
      : "chime";
    clean.settings.repeatSound = Boolean(clean.settings.repeatSound);
    clean.settings.soundVolume = clamp(Number(clean.settings.soundVolume) || 0, 0, 100);
    clean.settings.wakeLockEnabled = Boolean(clean.settings.wakeLockEnabled);
    clean.settings.declinedTrials = clean.settings.declinedTrials && typeof clean.settings.declinedTrials === "object"
      ? clean.settings.declinedTrials
      : {};
    return clean;
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalizeData(JSON.parse(raw)) : cloneDefaults();
    } catch (error) {
      console.warn("保存データを読み込めませんでした。", error);
      return cloneDefaults();
    }
  }

  function saveData() {
    try {
      data.version = APP_VERSION;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      showToast("保存できませんでした。端末の空き容量を確認してください。");
      console.error(error);
    }
  }

  function normalizeConfig(config) {
    const source = config && typeof config === "object" ? config : {};
    const sourceSets = Number(source.sets);
    return {
      focusMinutes: clamp(Math.round(Number(source.focusMinutes) || DEFAULT_CONFIG.focusMinutes), 1, 90),
      breakMinutes: clamp(Math.round(Number(source.breakMinutes) || DEFAULT_CONFIG.breakMinutes), 2, 30),
      sets: Number.isFinite(sourceSets) ? Math.max(1, Math.round(sourceSets)) : DEFAULT_CONFIG.sets,
      timeBudget: [0, 30, 60, 90, 120].includes(Number(source.timeBudget)) ? Number(source.timeBudget) : 0,
      theme: ["forest", "ocean", "dusk", "mono"].includes(source.theme) ? source.theme : "forest"
    };
  }

  function isValidSession(session) {
    return session && typeof session === "object" && typeof session.id === "string" && Number.isFinite(Number(session.startedAt));
  }

  function normalizeSession(session) {
    const config = normalizeConfig(session.config);
    return {
      id: String(session.id),
      startedAt: Number(session.startedAt),
      endedAt: Number(session.endedAt) || Number(session.startedAt),
      task: typeof session.task === "string" ? session.task.slice(0, 80) : "",
      config,
      completedSets: clamp(Math.round(Number(session.completedSets) || 0), 0, config.sets),
      focusMs: Math.max(0, Number(session.focusMs) || 0),
      breakMs: Math.max(0, Number(session.breakMs) || 0),
      completionRate: clamp(Number(session.completionRate) || 0, 0, 1),
      rating: [1, 2, 3, 4, 5].includes(Number(session.rating)) ? Number(session.rating) : null,
      note: typeof session.note === "string" ? session.note.slice(0, 500) : "",
      interrupted: Boolean(session.interrupted),
      configurationChanged: Boolean(session.configurationChanged)
    };
  }

  function normalizeTimer(timer) {
    if (!timer || typeof timer !== "object" || !Number.isFinite(Number(timer.startedAt))) return null;
    const config = normalizeConfig(timer.config);
    const phase = timer.phase === "break" ? "break" : "focus";
    const defaultDuration = (phase === "focus" ? config.focusMinutes : config.breakMinutes) * 60_000;
    const phaseDurationMs = clamp(Number(timer.phaseDurationMs) || defaultDuration, 1_000, 90 * 60_000);
    const remainingMs = clamp(Number(timer.remainingMs) || phaseDurationMs, 0, phaseDurationMs);
    return {
      id: typeof timer.id === "string" ? timer.id : `session-${Number(timer.startedAt)}`,
      startedAt: Number(timer.startedAt),
      task: typeof timer.task === "string" ? timer.task.slice(0, 80) : "",
      config,
      phase,
      currentSet: clamp(Math.round(Number(timer.currentSet) || 1), 1, config.sets),
      completedSets: clamp(Math.round(Number(timer.completedSets) || 0), 0, config.sets),
      completedFocusMs: Math.max(0, Number(timer.completedFocusMs) || 0),
      completedBreakMs: Math.max(0, Number(timer.completedBreakMs) || 0),
      completedPlannedFocusMs: Math.max(0, Number(timer.completedPlannedFocusMs) || 0),
      plannedFocusMs: Math.max(1, Number(timer.plannedFocusMs) || config.focusMinutes * config.sets * 60_000),
      status: timer.status === "paused" ? "paused" : "running",
      phaseDurationMs,
      phaseElapsedMs: clamp(Number(timer.phaseElapsedMs) || 0, 0, phaseDurationMs),
      runStartedAt: Number(timer.runStartedAt) || now(),
      endAt: Number(timer.endAt) || now() + remainingMs,
      remainingMs,
      pendingConfig: timer.pendingConfig ? normalizeConfig(timer.pendingConfig) : null,
      configurationChanged: Boolean(timer.configurationChanged)
    };
  }

  function plannedDurationMs(config) {
    return (config.focusMinutes * config.sets + config.breakMinutes * Math.max(0, config.sets - 1)) * 60_000;
  }

  function dateKey(timestamp = now()) {
    const date = new Date(timestamp);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function startOfLocalDay(timestamp = now()) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function formatDuration(ms, compact = false) {
    const totalMinutes = Math.max(0, Math.round(ms / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${totalMinutes}分`;
    if (!minutes) return `${hours}時間`;
    return compact ? `${hours}時間${minutes}分` : `${hours}時間 ${minutes}分`;
  }

  function formatClock(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    $("#toastRegion").append(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  function applyColorMode() {
    const mode = data.settings.colorMode;
    const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    const themeMeta = $("meta[name='theme-color']");
    if (themeMeta) themeMeta.content = dark ? "#11191e" : "#eef5f8";
  }

  function getStats() {
    const valid = data.sessions.filter(session => session.focusMs > 0 || session.completedSets > 0);
    const dayKeys = [...new Set(valid.map(session => dateKey(session.startedAt)))].sort();
    const today = startOfLocalDay();
    let cursor = today;
    if (!dayKeys.includes(dateKey(cursor))) cursor -= DAY_MS;
    let streak = 0;
    while (dayKeys.includes(dateKey(cursor))) {
      streak += 1;
      cursor -= DAY_MS;
    }
    return {
      streak,
      totalDays: dayKeys.length,
      totalFocusMs: valid.reduce((sum, session) => sum + session.focusMs, 0),
      totalBreakMs: valid.reduce((sum, session) => sum + session.breakMs, 0),
      totalPomos: valid.reduce((sum, session) => sum + session.completedSets, 0),
      valid
    };
  }

  function renderHeaderDateTime() {
    const current = new Date();
    const date = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(current);
    const time = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(current);
    const element = $("#headerDateTime");
    element.textContent = `${date} ${time}`;
    element.dateTime = current.toISOString();
  }

  function renderAll() {
    renderHeaderDateTime();
    renderHome();
    renderDashboard();
    renderBadges();
    renderSettings();
    renderSetup();
  }

  function navigate(page, options = {}) {
    const validPage = ["home", "dashboard", "badges", "settings", "timer"].includes(page) ? page : "home";
    const previousPage = currentPage;
    currentPage = validPage;
    if (validPage === "dashboard" && previousPage !== "dashboard") weeklyOffset = 0;
    $$(".page").forEach(section => section.classList.toggle("active", section.dataset.page === validPage));
    $$(".bottom-nav button").forEach(button => {
      const active = button.dataset.navTarget === validPage;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const isTimer = validPage === "timer";
    $("#bottomNav").classList.toggle("hidden", isTimer);
    $("#headerBack").classList.toggle("hidden", !isTimer);
    $("#headerTitle").textContent = isTimer ? "タイマー" : "PomoNote";
    if (isTimer) openTimerDestination(options.forceSetup);
    else {
      releaseWakeLock();
      renderAll();
    }
    window.scrollTo({ top: 0, behavior: options.instant ? "auto" : "smooth" });
  }

  function renderCycle(target, config) {
    target.innerHTML = "";
    const visibleSets = Math.min(config.sets, 12);
    for (let index = 0; index < visibleSets; index += 1) {
      const focus = document.createElement("i");
      focus.style.width = `${Math.max(18, Math.min(54, config.focusMinutes))}px`;
      target.append(focus);
      if (index < visibleSets - 1) {
        const rest = document.createElement("i");
        rest.className = "break";
        target.append(rest);
      }
    }
  }

  function renderHome() {
    const stats = getStats();
    const config = data.config;
    $("#homeConfigTitle").innerHTML = `${config.focusMinutes}分活動 <span>・</span> ${config.breakMinutes}分休憩`;
    renderCycle($("#homeCycle"), config);
    const todaySessions = data.sessions.filter(session => dateKey(session.startedAt) === dateKey());
    $("#todayFocus").textContent = formatDuration(todaySessions.reduce((sum, session) => sum + session.focusMs, 0));
    $("#homeTotalDays").textContent = `${stats.totalDays}日`;

    const startButton = $("#openTimerSetup");
    startButton.lastChild.textContent = " タイマー";

    renderRecommendation($("#homeRecommendation"), config);
  }

  function renderDashboard() {
    const stats = getStats();
    const currentDay = new Date().getDay();
    const weekStart = startOfLocalDay() - ((currentDay + 6) % 7) * DAY_MS;
    const weekSessions = data.sessions.filter(session => session.startedAt >= weekStart);
    const weekFocusMs = weekSessions.reduce((sum, session) => sum + session.focusMs, 0);
    const weekElapsedMs = weekSessions.reduce((sum, session) => sum + session.focusMs + session.breakMs, 0);
    $("#statStreak").textContent = `${stats.streak}日`;
    $("#statWeekFocus").textContent = formatDuration(weekFocusMs);
    $("#statDays").textContent = `${stats.totalDays}日`;
    $("#statWeekElapsed").textContent = formatDuration(weekElapsedMs);
    $("#statLifetimeFocus").textContent = formatDuration(stats.totalFocusMs);
    renderWeeklyChart();
    renderRecordList();
  }

  function renderWeeklyChart() {
    const days = [];
    const formatter = new Intl.DateTimeFormat("ja-JP", { weekday: "short" });
    const currentDay = new Date().getDay();
    const currentWeekStart = startOfLocalDay() - ((currentDay + 6) % 7) * DAY_MS;
    const displayedWeekStart = currentWeekStart + weeklyOffset * 7 * DAY_MS;
    for (let offset = 0; offset < 7; offset += 1) {
      const timestamp = displayedWeekStart + offset * DAY_MS;
      const sessions = data.sessions.filter(session => dateKey(session.startedAt) === dateKey(timestamp));
      const focusMs = sessions.reduce((sum, session) => sum + session.focusMs, 0);
      const elapsedMs = sessions.reduce((sum, session) => sum + session.focusMs + session.breakMs, 0);
      days.push({ timestamp, focusMs, elapsedMs });
    }
    const valueKey = weeklyChartMode === "elapsed" ? "elapsedMs" : "focusMs";
    const chartName = weeklyChartMode === "elapsed" ? "日別総セッション時間" : "日別活動時間";
    const max = Math.max(...days.map(day => day[valueKey]), 30 * 60_000);
    const total = days.reduce((sum, day) => sum + day[valueKey], 0);
    const rangeFormatter = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" });
    $("#weeklyRange").textContent = `${rangeFormatter.format(new Date(displayedWeekStart))}–${rangeFormatter.format(new Date(displayedWeekStart + 6 * DAY_MS))}`;
    $("#nextWeek").disabled = weeklyOffset >= 0;
    $$('[data-weekly-mode]').forEach(button => {
      const active = button.dataset.weeklyMode === weeklyChartMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("#weeklyChart").innerHTML = days.map((day, index) => {
      const value = day[valueKey];
      const height = value ? Math.max(4, (value / max) * 100) : 2;
      const label = formatter.format(new Date(day.timestamp));
      const minutes = Math.round(value / 60_000);
      const isToday = dateKey(day.timestamp) === dateKey();
      const activityRatio = day.elapsedMs ? (day.focusMs / day.elapsedMs) * 100 : 0;
      const bar = weeklyChartMode === "elapsed"
        ? `<i class="bar-fill bar-fill-stacked" style="height:${height}%"><em class="bar-break" style="height:${100 - activityRatio}%"></em><em class="bar-activity" style="height:${activityRatio}%"></em></i>`
        : `<i class="bar-fill" style="height:${height}%"></i>`;
      const detail = weeklyChartMode === "elapsed"
        ? `活動 ${formatDuration(day.focusMs)}、休憩 ${formatDuration(day.elapsedMs - day.focusMs)}`
        : formatDuration(value);
      return `<div class="bar-column ${isToday ? "today" : ""}" title="${label}: ${detail}"><b>${minutes}<small>分</small></b><div class="bar-track">${bar}</div><span>${label}</span></div>`;
    }).join("");
    $("#weeklyChart").setAttribute("aria-label", `${$("#weeklyRange").textContent}の${chartName}は合計${formatDuration(total)}です`);
  }

  function renderRecordList() {
    const sessions = [...data.sessions]
      .sort((a, b) => b.startedAt - a.startedAt);
    $("#recordList").innerHTML = sessions.length
      ? sessions.map(session => recordCardHtml(session)).join("")
      : '<div class="surface empty-state">この期間の記録はありません。</div>';
  }

  function recordCardHtml(session) {
    const date = new Date(session.startedAt);
    const title = session.task || "";
    const dateText = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(date);
    return `<article class="record-card surface">
      <div class="recent-date"><span>${date.getMonth() + 1}月</span><strong>${date.getDate()}</strong></div>
      <div class="record-main">${title ? `<h4>${escapeHtml(title)}</h4>` : ""}<p>${dateText}</p><p>${session.config.focusMinutes}/${session.config.breakMinutes} × ${session.config.sets}</p>${session.note ? `<p class="record-note">${escapeHtml(session.note)}</p>` : ""}</div>
      <div class="record-side"><strong>${formatDuration(session.focusMs)}</strong><span>${session.rating ? `集中 ${session.rating}/5` : "未評価"}</span><button class="record-edit" type="button" data-edit-record="${escapeHtml(session.id)}" aria-label="${escapeHtml(title || "セッション")}の記録を編集"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 16-.7 4.7L8 20l11-11-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg></button></div>
    </article>`;
  }

  const badgeDefinitions = [
    { id: "first", title: "はじめの一歩", detail: "1回のポモドーロを完了", icon: "check", test: stats => stats.totalPomos >= 1, progress: stats => stats.totalPomos / 1 },
    { id: "streak3", title: "三日月のリズム", detail: "3日連続で活動", icon: "flame", test: stats => stats.streak >= 3, progress: stats => stats.streak / 3 },
    { id: "streak7", title: "一週間の波", detail: "7日連続で活動", icon: "flame", test: stats => stats.streak >= 7, progress: stats => stats.streak / 7 },
    { id: "days10", title: "10日の足あと", detail: "合計10日活動", icon: "calendar", test: stats => stats.totalDays >= 10, progress: stats => stats.totalDays / 10 },
    { id: "focus5", title: "静かな5時間", detail: "活動時間が合計5時間", icon: "clock", test: stats => stats.totalFocusMs >= 5 * 3_600_000, progress: stats => stats.totalFocusMs / (5 * 3_600_000) },
    { id: "pomo50", title: "50の積み重ね", detail: "50ポモドーロを完了", icon: "layers", test: stats => stats.totalPomos >= 50, progress: stats => stats.totalPomos / 50 },
    { id: "focus25", title: "深まる25時間", detail: "活動時間が合計25時間", icon: "clock", test: stats => stats.totalFocusMs >= 25 * 3_600_000, progress: stats => stats.totalFocusMs / (25 * 3_600_000) },
    { id: "streak30", title: "ひと月の習慣", detail: "30日連続で活動", icon: "crown", test: stats => stats.streak >= 30, progress: stats => stats.streak / 30 },
    { id: "monthly", title: `${new Date().getMonth() + 1}月の集中`, detail: "今月20ポモドーロを完了", icon: "star", limited: true, test: () => monthlyPomos() >= 20, progress: () => monthlyPomos() / 20 }
  ];

  function monthlyPomos() {
    const current = new Date();
    return data.sessions.filter(session => {
      const date = new Date(session.startedAt);
      return date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth();
    }).reduce((sum, session) => sum + session.completedSets, 0);
  }

  function badgeIcon(name) {
    const paths = {
      check: '<path d="m6 12 4 4 8-9"/><circle cx="12" cy="12" r="9"/>',
      flame: '<path d="M13 3s1 4-2 6c-2-3-5-1-5 3a6 6 0 0 0 12 0c0-4-2-7-5-9Z"/><path d="M10 16c0-2 2-3 2-5 2 2 3 3 2 5a2.2 2.2 0 0 1-4 0Z"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
      crown: '<path d="m4 7 4 4 4-7 4 7 4-4-2 11H6L4 7Z"/><path d="M7 21h10"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
      lock: '<path d="M8 11V8a4 4 0 0 1 8 0v3"/><rect x="5" y="11" width="14" height="10" rx="2"/>'
    };
    return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] || paths.star}</svg>`;
  }

  function renderBadges() {
    const stats = getStats();
    const earned = badgeDefinitions.filter(badge => badge.test(stats));
    $("#earnedBadgeCount").textContent = earned.length;
    $("#badgeProgress").style.width = `${(earned.length / badgeDefinitions.length) * 100}%`;
    $("#badgeGrid").innerHTML = badgeDefinitions.map(badge => {
      const unlocked = badge.test(stats);
      return `<article class="badge-card surface ${unlocked ? "" : "locked"}">${badge.limited ? '<span class="limited-ribbon">今月限定</span>' : ""}${unlocked ? "" : `<span class="badge-lock">${badgeIcon("lock")}</span>`}<div class="badge-medallion">${badgeIcon(badge.icon)}</div><h3>${badge.title}</h3><p>${badge.detail}</p></article>`;
    }).join("");
  }

  function renderSettings() {
    $("#colorMode").value = data.settings.colorMode;
    $("#soundEnabled").checked = data.settings.soundEnabled;
    $("#soundType").value = data.settings.soundType;
    if ($("#repeatSound")) $("#repeatSound").checked = data.settings.repeatSound;
    $("#soundVolume").value = data.settings.soundVolume;
    $("#volumeOutput").textContent = `${data.settings.soundVolume}%`;
    $("#wakeLockEnabled").checked = data.settings.wakeLockEnabled;
    if (!("Notification" in window)) {
      $("#requestNotifications").disabled = true;
      $("#requestNotifications").textContent = "通知非対応";
      $("#requestNotifications").classList.remove("hidden");
    } else {
      $("#requestNotifications").disabled = false;
      $("#requestNotifications").classList.toggle("hidden", Notification.permission === "granted");
      $("#requestNotifications").textContent = Notification.permission === "denied" ? "通知設定を確認" : "通知を許可";
    }
  }

  function renderSetup() {
    const config = getLastUsedConfig();
    $("#focusMinutes").value = config.focusMinutes;
    $("#breakMinutes").value = config.breakMinutes;
    $("#setCount").value = config.sets;
    const radio = $(`input[name="timerTheme"][value="${config.theme}"]`);
    if (radio) radio.checked = true;
    $("#timerPage").dataset.timerTheme = config.theme;
    updateSetupPreview();
    renderRecommendation($("#setupRecommendation"), config);
  }

  function getLastUsedConfig() {
    if (data.timer?.config) return normalizeConfig(data.timer.config);
    if (data.draftSession?.config) return normalizeConfig(data.draftSession.config);
    const latestSession = data.sessions.reduce((latest, session) => (
      !latest || session.startedAt > latest.startedAt ? session : latest
    ), null);
    return normalizeConfig(latestSession?.config || data.config);
  }

  function readSetupConfig() {
    return normalizeConfig({
      focusMinutes: Number($("#focusMinutes").value),
      breakMinutes: Number($("#breakMinutes").value),
      sets: Number($("#setCount").value),
      timeBudget: data.config.timeBudget,
      theme: $("input[name='timerTheme']:checked")?.value || data.config.theme
    });
  }

  function updateSetupPreview() {
    const config = readSetupConfig();
    const focus = config.focusMinutes * config.sets * 60_000;
    const rest = config.breakMinutes * Math.max(0, config.sets - 1) * 60_000;
    $("#previewFocus").textContent = formatDuration(focus);
    $("#previewBreak").textContent = formatDuration(rest);
    $("#previewTotal").textContent = formatDuration(focus + rest, true);
    $("#timerPage").dataset.timerTheme = config.theme;
    renderRecommendation($("#setupRecommendation"), config);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function configDistance(a, b) {
    return Math.abs(a.focusMinutes - b.focusMinutes) / 5
      + Math.abs(a.breakMinutes - b.breakMinutes) / 2;
  }

  function evaluateCandidate(candidate) {
    let completionWeighted = 0;
    let completionWeight = 0;
    let qualityWeighted = 0;
    let qualityWeight = 0;
    let nearCount = 0;
    let nearRatedCount = 0;
    for (const session of data.sessions) {
      if (session.configurationChanged) continue;
      const distance = configDistance(candidate, session.config);
      const weight = Math.exp(-0.7 * distance);
      completionWeighted += weight * session.completionRate;
      completionWeight += weight;
      if (session.rating) {
        qualityWeighted += weight * (session.rating / 5);
        qualityWeight += weight;
      }
      if (distance <= 1) {
        nearCount += 1;
        if (session.rating) nearRatedCount += 1;
      }
    }
    const quality = (qualityWeighted + 0.6 * 3) / (qualityWeight + 3);
    const completion = (completionWeighted + 0.8 * 3) / (completionWeight + 3);
    const focusMinutes = candidate.focusMinutes * candidate.sets;
    const totalMinutes = focusMinutes + candidate.breakMinutes * Math.max(0, candidate.sets - 1);
    const density = focusMinutes / totalMinutes;
    return {
      config: candidate,
      quality,
      predictedRating: quality * 5,
      completion,
      density,
      fit: quality * completion * density,
      nearCount,
      nearRatedCount
    };
  }

  function uniqueConfigs(configs) {
    const map = new Map();
    configs.forEach(config => {
      const clean = normalizeConfig(config);
      map.set(`${clean.focusMinutes}-${clean.breakMinutes}`, clean);
    });
    return [...map.values()];
  }

  function calculateRecommendation(currentConfig) {
    const ratedCount = data.sessions.filter(session => session.rating).length;
    if (ratedCount < 5) return { type: "progress", ratedCount, required: 5 };

    const focusValues = new Set([currentConfig.focusMinutes]);
    const breakValues = new Set([currentConfig.breakMinutes]);
    data.sessions.forEach(session => {
      focusValues.add(session.config.focusMinutes);
      breakValues.add(session.config.breakMinutes);
    });
    focusValues.add(clamp(currentConfig.focusMinutes - 5, 1, 90));
    focusValues.add(clamp(currentConfig.focusMinutes + 5, 1, 90));
    breakValues.add(clamp(currentConfig.breakMinutes - 2, 2, 30));
    breakValues.add(clamp(currentConfig.breakMinutes + 2, 2, 30));

    const candidates = [];
    for (const focusMinutes of focusValues) {
      for (const breakMinutes of breakValues) {
        candidates.push(normalizeConfig({ ...currentConfig, focusMinutes, breakMinutes }));
      }
    }
    data.sessions.forEach(session => {
      candidates.push(normalizeConfig({ ...session.config, sets: currentConfig.sets }));
    });
    candidates.push(currentConfig);
    const evaluated = uniqueConfigs(candidates).map(evaluateCandidate);
    const current = evaluateCandidate(currentConfig);
    const eligible = evaluated
      .filter(item => item.nearRatedCount >= 3 && item.predictedRating >= 3.5 && item.completion >= 0.8)
      .sort((a, b) => b.fit - a.fit);
    const best = eligible[0];
    const trialCandidates = evaluated
      .filter(item => item.nearRatedCount < 3 && configDistance(item.config, currentConfig) <= 2.5)
      .filter(item => {
        const declinedAt = data.settings.declinedTrials[`${item.config.focusMinutes}-${item.config.breakMinutes}-${item.config.sets}`];
        return !declinedAt || now() - declinedAt > 30 * DAY_MS;
      })
      .sort((a, b) => b.fit - a.fit);
    const trial = data.sessions.length > 0 && data.sessions.length % 5 === 0 ? trialCandidates[0] : null;

    if (best && best.fit >= current.fit * 1.05 && configDistance(best.config, currentConfig) > 0) {
      return { type: "recommend", result: best, current };
    }
    if (trial) return { type: "trial", result: trial, current };
    if (current.nearRatedCount >= 3 && current.predictedRating >= 3.5 && current.completion >= 0.8) {
      return { type: "keep", result: current };
    }
    if (best) return { type: "recommend", result: best, current };
    return { type: "learning", ratedCount };
  }

  function renderRecommendation(container, config) {
    const recommendation = calculateRecommendation(config);
    const recommendedConfig = recommendation.result?.config || config;
    container.innerHTML = `<p class="recommendation-config">おすすめ：${recommendedConfig.focusMinutes}分＋${recommendedConfig.breakMinutes}分</p>`;
  }

  function dismissTrial(configKey) {
    data.settings.declinedTrials[configKey] = now();
    saveData();
    renderAll();
    showToast("この比較テストは30日間表示しません。");
  }

  function setTimerStep(step) {
    const order = ["setup", "focus", "break", "review"];
    const index = order.indexOf(step);
    $$(".timer-stepper span").forEach((item, itemIndex) => item.classList.toggle("active", itemIndex <= index));
  }

  function showTimerScreen(screen) {
    $$(".timer-screen").forEach(item => item.classList.toggle("active", item.dataset.timerScreen === screen));
    $("#timerPage").dataset.timerPhase = screen;
    setTimerStep(screen);
  }

  function openTimerDestination(forceSetup = false) {
    if (data.draftSession && !forceSetup) {
      renderReview();
      showTimerScreen("review");
      return;
    }
    if (data.timer && !forceSetup) {
      showTimerScreen(data.timer.phase);
      renderTimer();
      if (data.timer.status === "running" && data.timer.endAt <= now()) {
        stopTicker();
        return;
      }
      startTicker();
      requestWakeLock();
      return;
    }
    showTimerScreen("setup");
    renderSetup();
  }

  async function unlockAudio() {
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0.0001;
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.02);
      return audioContext.state === "running";
    } catch (error) {
      console.warn("音声を準備できませんでした。", error);
      return false;
    }
  }

  async function playSound(force = false) {
    if (!force && !data.settings.soundEnabled) return;
    const ready = await unlockAudio();
    if (!ready || !audioContext) {
      showToast("端末の消音設定とメディア音量を確認してください。");
      return;
    }
    const start = audioContext.currentTime;
    const volume = (data.settings.soundVolume / 100) * 0.16;
    const sounds = {
      quiet: {
        type: "sine",
        volume: 0.35,
        tones: [[0, 392, 0.65], [0.5, 493.88, 0.8]]
      },
      drop: {
        type: "sine",
        volume: 0.48,
        tones: [[0, 1174.66, 0.7, 392]]
      },
      chime: {
        type: "sine",
        volume: 1,
        tones: [[0, 523.25, 0.22], [0.28, 659.25, 0.22], [0.56, 783.99, 0.28]]
      },
      bell: {
        type: "triangle",
        volume: 0.9,
        tones: [[0, 659.25, 1.1], [0, 1318.51, 0.75]]
      },
      wood: {
        type: "square",
        volume: 1.05,
        tones: [[0, 740, 0.16, 260], [0.28, 880, 0.16, 310], [0.56, 740, 0.2, 260]]
      },
      digital: {
        type: "square",
        volume: 0.62,
        tones: [[0, 587.33, 0.09], [0.13, 783.99, 0.09], [0.26, 587.33, 0.09], [0.39, 987.77, 0.14]]
      },
      timer: {
        type: "square",
        volume: 1.25,
        tones: [[0, 880, 0.16], [0.22, 880, 0.16], [0.44, 880, 0.16], [0.72, 1046.5, 0.2], [0.98, 1046.5, 0.28]]
      },
      double: {
        type: "triangle",
        volume: 1,
        tones: [[0, 783.99, 0.6], [0.48, 783.99, 0.8]]
      },
      high: {
        type: "sine",
        volume: 1.05,
        tones: [[0, 1396.91, 0.12], [0.18, 1760, 0.12], [0.36, 1396.91, 0.12], [0.54, 1760, 0.2]]
      },
      alarm: {
        type: "sawtooth",
        volume: 1.12,
        tones: [[0, 440, 0.22, 659.25], [0.3, 659.25, 0.22, 440], [0.6, 440, 0.22, 659.25], [0.9, 659.25, 0.3, 440]]
      }
    };
    const sound = sounds[data.settings.soundType] || sounds.chime;
    sound.tones.forEach(([offset, frequency, duration, endFrequency]) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = sound.type;
      oscillator.frequency.setValueAtTime(frequency, start + offset);
      if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + offset + duration);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, Math.min(0.22, volume * sound.volume)), start + offset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + duration + 0.02);
    });
  }

  async function sendNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(title, {
          body,
          icon: "./icons/icon-192.png",
          badge: "./icons/icon-192.png",
          tag: "pomonote-timer",
          renotify: true,
          requireInteraction: true,
          silent: false,
          vibrate: [250, 120, 250, 120, 400]
        });
      } else {
        new Notification(title, { body, icon: "./icons/icon.svg" });
      }
    } catch (error) {
      console.warn("通知を表示できませんでした。", error);
    }
  }

  function beginTimer(config, task) {
    unlockAudio();
    const timestamp = now();
    data.config = normalizeConfig(config);
    data.timer = {
      id: crypto.randomUUID ? crypto.randomUUID() : `session-${timestamp}`,
      startedAt: timestamp,
      task: task.trim().slice(0, 80),
      config: normalizeConfig(config),
      phase: "focus",
      currentSet: 1,
      completedSets: 0,
      completedFocusMs: 0,
      completedBreakMs: 0,
      status: "running",
      phaseDurationMs: config.focusMinutes * 60_000,
      phaseElapsedMs: 0,
      runStartedAt: timestamp,
      endAt: timestamp + config.focusMinutes * 60_000,
      remainingMs: config.focusMinutes * 60_000,
      pendingConfig: null,
      completedPlannedFocusMs: 0,
      plannedFocusMs: config.focusMinutes * config.sets * 60_000,
      configurationChanged: false
    };
    data.draftSession = null;
    saveData();
    showTimerScreen("focus");
    renderTimer();
    startTicker();
    requestWakeLock();
  }

  function getPhaseElapsed(timer = data.timer) {
    if (!timer) return 0;
    const runningElapsed = timer.status === "running" ? Math.max(0, now() - timer.runStartedAt) : 0;
    return clamp(timer.phaseElapsedMs + runningElapsed, 0, timer.phaseDurationMs);
  }

  function persistTimer() {
    if (!data.timer) return;
    if (data.timer.status === "running") data.timer.remainingMs = Math.max(0, data.timer.endAt - now());
    saveData();
  }

  function startTicker() {
    window.clearInterval(tickHandle);
    lastTickAt = now();
    tickHandle = window.setInterval(tick, 250);
    tick();
  }

  function stopTicker() {
    window.clearInterval(tickHandle);
    tickHandle = null;
    document.title = "PomoNote";
  }

  function tick() {
    if (!data.timer) return;
    const timer = data.timer;
    lastTickAt = now();
    if (timer.status === "running" && timer.endAt <= now()) {
      completeCurrentPhase(false);
      return;
    }
    renderTimer();
  }

  function renderTimer() {
    const timer = data.timer;
    if (!timer) return;
    const remaining = timer.status === "running" ? Math.max(0, timer.endAt - now()) : timer.remainingMs;
    const display = timer.phase === "focus" ? $("#focusTimeDisplay") : $("#breakTimeDisplay");
    const ring = timer.phase === "focus" ? $("#focusRing") : $("#breakRing");
    const elapsedRatio = 1 - remaining / timer.phaseDurationMs;
    display.textContent = formatClock(remaining);
    ring.style.setProperty("--progress", `${clamp(elapsedRatio, 0, 1) * 360}deg`);
    ring.setAttribute("aria-label", `${timer.phase === "focus" ? "活動" : "休憩"}の残り${formatClock(remaining)}`);
    $("#focusSetDisplay").textContent = `${timer.currentSet} / ${timer.config.sets}`;
    $("#breakSetDisplay").textContent = `NEXT ${Math.min(timer.currentSet + 1, timer.config.sets)} / ${timer.config.sets}`;
    $("#timerPage").dataset.timerTheme = timer.config.theme;
    document.title = `${formatClock(remaining)} ${timer.phase === "focus" ? "活動" : "休憩"} | PomoNote`;
    updatePauseButtons(timer.status === "paused");
  }

  function updatePauseButtons(paused) {
    $$('[data-timer-action="pause"]').forEach(button => {
      button.innerHTML = paused
        ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z"/></svg><span>再開</span>'
        : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 7v10M15 7v10"/></svg><span>一時停止</span>';
    });
  }

  function togglePause() {
    const timer = data.timer;
    if (!timer) return;
    if (timer.status === "running") {
      timer.phaseElapsedMs = getPhaseElapsed(timer);
      timer.remainingMs = Math.max(0, timer.endAt - now());
      timer.status = "paused";
      releaseWakeLock();
    } else {
      timer.status = "running";
      timer.runStartedAt = now();
      timer.endAt = now() + timer.remainingMs;
      requestWakeLock();
    }
    saveData();
    renderTimer();
  }

  function applyPendingConfig() {
    if (!data.timer?.pendingConfig) return;
    const currentSet = data.timer.currentSet;
    data.timer.config = normalizeConfig({ ...data.timer.pendingConfig, sets: Math.max(currentSet, data.timer.pendingConfig.sets) });
    data.timer.plannedFocusMs = data.timer.completedPlannedFocusMs
      + Math.max(0, data.timer.config.sets - data.timer.completedSets) * data.timer.config.focusMinutes * 60_000;
    data.timer.configurationChanged = true;
    data.timer.pendingConfig = null;
  }

  function completeCurrentPhase(manual) {
    const timer = data.timer;
    if (!timer) return;
    const elapsed = manual ? getPhaseElapsed(timer) : timer.phaseDurationMs;
    if (timer.phase === "focus") {
      timer.completedFocusMs += elapsed;
      timer.completedPlannedFocusMs += timer.phaseDurationMs;
      timer.completedSets += 1;
      playSound();
      sendNotification("活動、おつかれさまでした", timer.currentSet >= timer.config.sets ? "セッションを記録しましょう。" : "短い休憩に入りましょう。");
      applyPendingConfig();
      if (timer.currentSet >= timer.config.sets) {
        finishTimer(false);
        return;
      }
      startNextPhase("break");
    } else {
      timer.completedBreakMs += elapsed;
      playSound();
      sendNotification("休憩が終わりました", "次の活動を始めましょう。");
      applyPendingConfig();
      if (timer.completedSets >= timer.config.sets) {
        finishTimer(false);
        return;
      }
      timer.currentSet += 1;
      startNextPhase("focus");
    }
  }

  function startNextPhase(phase) {
    const timer = data.timer;
    if (!timer) return;
    const duration = (phase === "focus" ? timer.config.focusMinutes : timer.config.breakMinutes) * 60_000;
    timer.phase = phase;
    timer.status = "running";
    timer.phaseDurationMs = duration;
    timer.phaseElapsedMs = 0;
    timer.runStartedAt = now();
    timer.remainingMs = duration;
    timer.endAt = now() + duration;
    saveData();
    showTimerScreen(phase);
    renderTimer();
  }

  function interruptTimer() {
    const timer = data.timer;
    if (!timer) return;
    const message = "現在の区間を中断して、記録画面へ進みますか？";
    if (!window.confirm(message)) return;
    const elapsed = getPhaseElapsed(timer);
    if (timer.phase === "focus") timer.completedFocusMs += elapsed;
    else timer.completedBreakMs += elapsed;
    finishTimer(true);
  }

  function finishTimer(interrupted) {
    const timer = data.timer;
    if (!timer) return;
    const plannedFocusMs = timer.plannedFocusMs || timer.config.focusMinutes * timer.config.sets * 60_000;
    data.draftSession = normalizeSession({
      id: timer.id,
      startedAt: timer.startedAt,
      endedAt: now(),
      task: timer.task,
      config: timer.config,
      completedSets: timer.completedSets,
      focusMs: timer.completedFocusMs,
      breakMs: timer.completedBreakMs,
      completionRate: plannedFocusMs ? timer.completedFocusMs / plannedFocusMs : 0,
      rating: null,
      note: "",
      interrupted,
      configurationChanged: timer.configurationChanged
    });
    data.timer = null;
    saveData();
    stopTicker();
    releaseWakeLock();
    renderReview();
    showTimerScreen("review");
  }

  function renderReview() {
    const session = data.draftSession;
    if (!session) return;
    $("#reviewSummary").innerHTML = `<div><span>活動時間</span><strong>${formatDuration(session.focusMs)}</strong></div><div><span>完了</span><strong>${session.completedSets}/${session.config.sets}</strong></div><div><span>完遂率</span><strong>${Math.round(session.completionRate * 100)}%</strong></div>`;
    $("#sessionNote").value = session.note || "";
    $$("input[name='focusRating']").forEach(input => { input.checked = Number(input.value) === session.rating; });
  }

  function saveDraftSession() {
    if (!data.draftSession) return;
    data.draftSession.rating = Number($("input[name='focusRating']:checked")?.value) || null;
    data.draftSession.note = $("#sessionNote").value.trim().slice(0, 500);
    data.sessions.push(normalizeSession(data.draftSession));
    data.draftSession = null;
    saveData();
    $("#reviewForm").reset();
    showToast("セッションを保存しました。");
    navigate("home");
  }

  function showChangeDialog() {
    const timer = data.timer;
    if (!timer) return;
    const source = timer.pendingConfig || timer.config;
    $("#changeFocus").value = source.focusMinutes;
    $("#changeBreak").value = source.breakMinutes;
    $("#changeSets").value = source.sets;
    $("#changeSets").min = timer.currentSet;
    $("#changeError").classList.add("hidden");
    $("#changeDialog").showModal();
  }

  function applyConfigChange(event) {
    event.preventDefault();
    const timer = data.timer;
    if (!timer) return;
    const config = normalizeConfig({
      ...timer.config,
      focusMinutes: Number($("#changeFocus").value),
      breakMinutes: Number($("#changeBreak").value),
      sets: Number($("#changeSets").value)
    });
    if (config.sets < timer.currentSet) {
      $("#changeError").textContent = `セット数は現在の${timer.currentSet}セット目以上にしてください。`;
      $("#changeError").classList.remove("hidden");
      return;
    }
    timer.pendingConfig = config;
    data.config = config;
    saveData();
    $("#changeDialog").close();
    showToast("次の区間から新しい条件を反映します。");
  }

  function handleOverdueOnRestore() {
    const timer = data.timer;
    if (!timer || timer.status !== "running" || timer.endAt > now()) return;
    pendingOverdue = true;
    $("#overdueDialog").showModal();
  }

  function resolveOverdue(action) {
    const timer = data.timer;
    if (!timer) return;
    pendingOverdue = false;
    $("#overdueDialog").close();
    if (action === "completed") {
      completeCurrentPhase(false);
    } else if (action === "restart") {
      timer.status = "running";
      timer.phaseElapsedMs = 0;
      timer.runStartedAt = now();
      timer.remainingMs = timer.phaseDurationMs;
      timer.endAt = now() + timer.phaseDurationMs;
      saveData();
      renderTimer();
      startTicker();
    } else {
      const elapsedBeforeClose = clamp(timer.phaseDurationMs - timer.remainingMs, 0, timer.phaseDurationMs);
      if (timer.phase === "focus") timer.completedFocusMs += elapsedBeforeClose;
      else timer.completedBreakMs += elapsedBeforeClose;
      finishTimer(true);
    }
  }

  async function requestWakeLock() {
    if (!data.settings.wakeLockEnabled || !data.timer || data.timer.status !== "running" || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (error) {
      console.warn("画面の点灯を維持できませんでした。", error);
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    try { await wakeLock.release(); } catch (error) { console.warn(error); }
    wakeLock = null;
  }

  function openRecordEditor(id) {
    const session = data.sessions.find(item => item.id === id);
    if (!session) return;
    $("#editRecordId").value = session.id;
    $("#editNote").value = session.note;
    $$("input[name='editFocusRating']").forEach(input => { input.checked = Number(input.value) === session.rating; });
    $("#recordDialog").showModal();
  }

  function saveRecordEdit(event) {
    event.preventDefault();
    const session = data.sessions.find(item => item.id === $("#editRecordId").value);
    if (!session) return;
    session.rating = Number($("input[name='editFocusRating']:checked")?.value) || null;
    session.note = $("#editNote").value.trim().slice(0, 500);
    saveData();
    $("#recordDialog").close();
    renderAll();
    showToast("記録を更新しました。");
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    downloadFile(`pomonote-backup-${dateKey()}.json`, JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2), "application/json");
    showToast("JSONバックアップを書き出しました。");
  }

  async function importJson(file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.sessions) || !parsed.settings) throw new Error("invalid");
      if (!window.confirm("現在の記録と設定を、選択したバックアップで置き換えますか？")) return;
      data = normalizeData(parsed);
      saveData();
      applyColorMode();
      renderAll();
      showToast("バックアップを復元しました。");
    } catch (error) {
      showToast("有効なPomoNoteのJSONファイルではありません。");
    } finally {
      $("#importJsonInput").value = "";
    }
  }

  async function requestNotificationPermission() {
    if (!window.isSecureContext) {
      window.alert("通知はHTTPSで公開したPomoNoteからのみ許可できます。");
      return;
    }
    if (!("Notification" in window)) {
      window.alert("このブラウザーはWeb通知に対応していません。iPhoneではPomoNoteをホーム画面へ追加し、追加したアイコンから開いてください。");
      return;
    }
    if (Notification.permission === "granted") {
      await sendNotification("PomoNote", "通知は正しく設定されています。");
      return;
    }
    if (Notification.permission === "denied") {
      showNotificationSettingsGuide();
      return;
    }
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (isIos && !isStandalone) {
      window.alert("iPhoneでは、共有メニューの「ホーム画面に追加」でPomoNoteを追加し、そのアイコンから開いて通知を許可してください。");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      renderSettings();
      if (permission === "granted") {
        showToast("通知を許可しました。");
        await sendNotification("PomoNote", "通知を許可しました。");
        await playSound();
      } else if (permission === "denied") {
        showNotificationSettingsGuide();
      }
    } catch (error) {
      showToast("通知の設定を変更できませんでした。");
    }
  }

  function showNotificationSettingsGuide() {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const message = isIos
      ? "iPhoneの「設定」→「通知」→「PomoNote」で通知を許可してください。PomoNoteが表示されない場合は、ホーム画面へ追加したPomoNoteからもう一度操作してください。"
      : "端末の「設定」→「アプリ」→使用中のブラウザーまたはPomoNote→「通知」で、このサイトの通知を許可してください。";
    window.alert(message);
  }

  function bindEvents() {
    ["#focusMinutes", "#breakMinutes", "#setCount", "#changeFocus", "#changeBreak", "#changeSets"].forEach(selector => {
      $(selector).addEventListener("input", event => {
        event.target.value = event.target.value.replace(/[^0-9]/g, "");
      });
    });
    $("#headerBack").addEventListener("click", () => navigate("home"));
    $("#openTimerSetup").addEventListener("click", () => navigate("timer"));
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-nav-target]");
      if (nav) navigate(nav.dataset.navTarget);
      const dismissedTrial = event.target.closest("[data-dismiss-trial]");
      if (dismissedTrial) dismissTrial(dismissedTrial.dataset.dismissTrial);
      const editor = event.target.closest("[data-edit-record]");
      if (editor) openRecordEditor(editor.dataset.editRecord);
      const timerAction = event.target.closest("[data-timer-action]")?.dataset.timerAction;
      if (timerAction === "pause") togglePause();
      if (timerAction === "skip") completeCurrentPhase(true);
      if (timerAction === "interrupt") interruptTimer();
      if (timerAction === "change") showChangeDialog();
    });
    $("#timerForm").addEventListener("submit", event => {
      event.preventDefault();
      const config = readSetupConfig();
      beginTimer(config, "");
    });
    ["#focusMinutes", "#breakMinutes", "#setCount"].forEach(selector => {
      $(selector).addEventListener("input", updateSetupPreview);
      $(selector).addEventListener("change", updateSetupPreview);
    });
    $$('input[name="timerTheme"]').forEach(input => input.addEventListener("change", updateSetupPreview));
    $("#reviewForm").addEventListener("submit", event => { event.preventDefault(); saveDraftSession(); });
    $$('[data-weekly-mode]').forEach(button => button.addEventListener("click", () => {
      weeklyChartMode = button.dataset.weeklyMode;
      renderWeeklyChart();
    }));
    $("#previousWeek").addEventListener("click", () => {
      weeklyOffset -= 1;
      renderWeeklyChart();
    });
    $("#nextWeek").addEventListener("click", () => {
      if (weeklyOffset >= 0) return;
      weeklyOffset += 1;
      renderWeeklyChart();
    });
    $("#saveRecordEdit").addEventListener("click", saveRecordEdit);
    $("#applyConfigChange").addEventListener("click", applyConfigChange);
    $("#overdueCompleted").addEventListener("click", () => resolveOverdue("completed"));
    $("#overdueInterrupted").addEventListener("click", () => resolveOverdue("interrupted"));

    $("#colorMode").addEventListener("change", event => { data.settings.colorMode = event.target.value; saveData(); applyColorMode(); });
    $("#soundEnabled").addEventListener("change", event => { data.settings.soundEnabled = event.target.checked; saveData(); });
    $("#soundType").addEventListener("change", event => { data.settings.soundType = event.target.value; saveData(); });
    $("#repeatSound")?.addEventListener("change", event => { data.settings.repeatSound = event.target.checked; saveData(); });
    $("#soundVolume").addEventListener("input", event => { data.settings.soundVolume = Number(event.target.value); $("#volumeOutput").textContent = `${event.target.value}%`; saveData(); });
    $("#wakeLockEnabled").addEventListener("change", event => { data.settings.wakeLockEnabled = event.target.checked; saveData(); if (event.target.checked) requestWakeLock(); else releaseWakeLock(); });
    $("#testSound").addEventListener("click", () => playSound(true));
    $("#requestNotifications").addEventListener("click", requestNotificationPermission);
    $("#exportJson").addEventListener("click", exportJson);
    $("#importJsonButton").addEventListener("click", () => $("#importJsonInput").click());
    $("#importJsonInput").addEventListener("change", event => { if (event.target.files[0]) importJson(event.target.files[0]); });
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (data.timer?.status === "running" && data.timer.endAt <= now() && now() - lastTickAt > 3_000 && !pendingOverdue) handleOverdueOnRestore();
        requestWakeLock();
      } else {
        persistTimer();
        releaseWakeLock();
      }
    });
    window.addEventListener("pagehide", persistTimer);
  }

  function updateOnlineStatus() {
    $("#offlineBanner").classList.toggle("hidden", navigator.onLine);
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (error) {
      console.warn("Service Workerを登録できませんでした。", error);
    }
  }

  function init() {
    applyColorMode();
    systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeQuery.addEventListener?.("change", () => { if (data.settings.colorMode === "system") applyColorMode(); });
    bindEvents();
    updateOnlineStatus();
    renderAll();
    window.setInterval(renderHeaderDateTime, 30_000);
    registerServiceWorker();
    if (data.timer) {
      navigate("timer", { instant: true });
      if (data.timer.status === "running" && data.timer.endAt <= now()) window.setTimeout(handleOverdueOnRestore, 150);
    } else if (data.draftSession) {
      navigate("timer", { instant: true });
    }
  }

  init();
})();
