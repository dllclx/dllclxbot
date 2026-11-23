/* ============================================================
   Наши траты — Mini App для двоих.
   Вся работа с сервером — через Edge Function `api` (proxy-режим):
   каждый запрос несёт Telegram.WebApp.initData, функция проверяет
   HMAC-подпись и только потом работает с БД. Прямых запросов
   к таблицам Supabase отсюда нет — RLS их запрещает.
   ============================================================ */
"use strict";

const tg = window.Telegram?.WebApp;

// Фиксированные категории — совпадают с constraint в SQL и списком в Edge Function
const CATEGORIES = [
  { name: "Еда",          emoji: "🍔" },
  { name: "Транспорт",    emoji: "🚌" },
  { name: "Жильё",        emoji: "🏠" },
  { name: "Развлечения",  emoji: "🎉" },
  { name: "Здоровье",     emoji: "💊" },
  { name: "Подарки",      emoji: "🎁" },
  { name: "Прочее",       emoji: "📦" },
];
const EMOJI = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.emoji]));

const fmtMoney = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const money = (n) => `${fmtMoney.format(Number(n))} ₽`;

// ---------- Состояние ----------
const state = {
  me: null,            // мой Telegram ID (из ответа функции, не из initDataUnsafe!)
  users: [],           // [{telegram_id, first_name, username}]
  expenses: [],        // траты выбранного месяца
  budget: null,        // число или null
  month: currentMonth(),
  scope: "all",        // all | mine | partner
  editingId: null,     // id редактируемой записи, null = добавление
  busy: false,
};

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- Тема Telegram ----------
// Берём цвета из themeParams; если чего-то нет — fallback на светлую/тёмную
// тему через prefers-color-scheme (см. styles.css).
function applyTheme() {
  const p = tg?.themeParams ?? {};
  const map = {
    "--bg": p.bg_color,
    "--card": p.secondary_bg_color,
    "--text": p.text_color,
    "--hint": p.hint_color,
    "--accent": p.button_color,
    "--accent-text": p.button_text_color,
    "--link": p.link_color,
    "--danger": p.destructive_text_color,
  };
  for (const [cssVar, value] of Object.entries(map)) {
    if (value) document.documentElement.style.setProperty(cssVar, value);
  }
  document.documentElement.dataset.scheme = tg?.colorScheme ?? "light";
}

// ---------- Запросы к Edge Function ----------
async function api(action, payload = {}) {
  const res = await fetch(window.APP_CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // initData — подписанные Telegram данные; сервер проверяет HMAC
    body: JSON.stringify({ action, initData: tg.initData, payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

// Мутации возвращают свежие данные месяца — обновляем экран без доп. запроса
function applyData(data) {
  state.me = data.me;
  state.users = data.users;
  state.expenses = data.expenses;
  state.budget = data.budget === null ? null : Number(data.budget);
  render();
}

async function loadData() {
  applyData(await api("data", { month: state.month }));
}

// ---------- Имена ----------
function userName(id) {
  if (id === state.me) return "Я";
  const u = state.users.find((x) => x.telegram_id === id);
  return u?.first_name || u?.username || "Партнёр";
}
function partnerId() {
  const u = state.users.find((x) => x.telegram_id !== state.me);
  return u?.telegram_id ?? null;
}
function partnerName() {
  const id = partnerId();
  return id ? userName(id) : "Партнёр";
}

// ---------- Фильтрация и подсчёты ----------
function scopedExpenses() {
  if (state.scope === "mine") return state.expenses.filter((e) => e.user_id === state.me);
  if (state.scope === "partner") return state.expenses.filter((e) => e.user_id !== state.me);
  return state.expenses;
}
const sum = (list) => list.reduce((s, e) => s + Number(e.amount), 0);

// ---------- Рендер ----------
const $ = (id) => document.getElementById(id);

function render() {
  renderBudget();
  renderSummary();
  renderTabs();
  renderCategories();
  renderList();
}

function renderBudget() {
  const card = $("budgetCard");
  const total = sum(state.expenses); // бюджет общий — считаем по ВСЕМ тратам
  if (state.budget === null) {
    card.innerHTML = `
      <div class="budget-empty">
        <span class="hint">Бюджет на месяц не задан</span>
        <button class="btn-link" id="budgetEditBtn">Задать</button>
      </div>`;
  } else {
    const left = state.budget - total;
    const pct = Math.min(100, (total / state.budget) * 100);
    const over = left < 0;
    card.innerHTML = `
      <div class="budget-head">
        <span class="card-title">Бюджет на месяц</span>
        <button class="btn-link" id="budgetEditBtn">Изменить</button>
      </div>
      <div class="budget-numbers">
        <b>${money(total)}</b>
        <span class="hint">из ${money(state.budget)}</span>
      </div>
      <div class="progress"><div class="progress-fill ${over ? "over" : ""}" style="width:${pct}%"></div></div>
      <div class="${over ? "budget-over" : "budget-left"}">
        ${over ? `Превышение на ${money(-left)}` : `Осталось ${money(left)}`}
      </div>`;
  }
  $("budgetEditBtn").onclick = showBudgetEditor;
}

// Inline-редактор бюджета прямо в карточке
function showBudgetEditor() {
  const card = $("budgetCard");
  card.innerHTML = `
    <div class="card-title">Бюджет на ${monthLabel(state.month)}</div>
    <div class="budget-form">
      <input id="budgetInput" type="text" inputmode="decimal" placeholder="Сумма, ₽"
             value="${state.budget ?? ""}">
      <button class="btn-primary btn-small" id="budgetSaveBtn">ОК</button>
      <button class="btn-secondary btn-small" id="budgetCancelBtn">Отмена</button>
    </div>
    <div class="hint" style="margin-top:6px">Пусто или 0 — убрать бюджет. Бюджет общий на двоих.</div>`;
  const input = $("budgetInput");
  input.focus();
  $("budgetCancelBtn").onclick = renderBudget;
  $("budgetSaveBtn").onclick = async () => {
    const amount = parseAmount(input.value || "0");
    if (amount === null || amount < 0) return alertMsg("Введите корректную сумму");
    await mutate("set_budget", { month: state.month, amount });
  };
}

function renderSummary() {
  const total = sum(state.expenses);
  const mine = sum(state.expenses.filter((e) => e.user_id === state.me));
  const partner = total - mine;
  $("summaryCard").innerHTML = `
    <div class="card-title">Итого за ${monthLabel(state.month)}</div>
    <div class="sum-total">${money(total)}</div>
    <div class="sum-row">
      <div><span class="hint">Я</span><br><b>${money(mine)}</b></div>
      <div><span class="hint">${escapeHtml(partnerName())}</span><br><b>${money(partner)}</b></div>
    </div>`;
}

function renderTabs() {
  const labels = { all: "Все", mine: "Мои", partner: partnerName() };
  for (const btn of $("scopeTabs").querySelectorAll(".tab")) {
    btn.textContent = labels[btn.dataset.scope];
    btn.classList.toggle("active", btn.dataset.scope === state.scope);
  }
}

function renderCategories() {
  const list = scopedExpenses();
  const card = $("categoryCard");
  if (!list.length) { card.innerHTML = `<div class="hint">Нет трат для разбивки по категориям</div>`; return; }
  const byCat = {};
  for (const e of list) byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount);
  const total = sum(list);
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([cat, s]) => `
    <div class="cat-row">
      <span>${EMOJI[cat] ?? "📦"} ${escapeHtml(cat)}</span>
      <span class="cat-bar"><span style="width:${(s / total) * 100}%"></span></span>
      <b>${money(s)}</b>
    </div>`).join("");
  card.innerHTML = `<div class="card-title">По категориям</div>${rows}`;
}

function renderList() {
  const list = scopedExpenses();
  const wrap = $("expenseList");
  if (!list.length) {
    wrap.innerHTML = `<div class="empty hint">Пока нет трат. Нажмите «Добавить трату» 👇</div>`;
    return;
  }
  // Группировка по дате (список уже отсортирован сервером по убыванию)
  const groups = new Map();
  for (const e of list) {
    if (!groups.has(e.spent_at)) groups.set(e.spent_at, []);
    groups.get(e.spent_at).push(e);
  }
  let html = "";
  for (const [date, items] of groups) {
    html += `<div class="day-head"><span>${formatDate(date)}</span><span>${money(sum(items))}</span></div>`;
    html += `<div class="card day-card">` + items.map((e) => {
      const mineItem = e.user_id === state.me;
      return `
        <div class="expense ${mineItem ? "editable" : ""}" data-id="${e.id}">
          <div class="expense-emoji">${EMOJI[e.category] ?? "📦"}</div>
          <div class="expense-main">
            <div class="expense-cat">${escapeHtml(e.category)}
              <span class="badge">${escapeHtml(userName(e.user_id))}</span></div>
            ${e.comment ? `<div class="hint expense-comment">${escapeHtml(e.comment)}</div>` : ""}
          </div>
          <div class="expense-amount">${money(e.amount)}</div>
        </div>`;
    }).join("") + `</div>`;
  }
  wrap.innerHTML = html;
  // Клик по СВОЕЙ записи → редактирование (чужие не открываются)
  wrap.querySelectorAll(".expense.editable").forEach((el) => {
    el.onclick = () => openForm(state.expenses.find((e) => e.id === el.dataset.id));
  });
}

// ---------- Форма траты ----------
function openForm(expense = null) {
  state.editingId = expense?.id ?? null;
  $("formTitle").textContent = expense ? "Редактировать трату" : "Новая трата";
  $("fAmount").value = expense ? String(expense.amount) : "";
  $("fCategory").value = expense?.category ?? CATEGORIES[0].name;
  $("fDate").value = expense?.spent_at ?? todayISO();
  $("fComment").value = expense?.comment ?? "";
  $("deleteBtn").hidden = !expense;
  $("overlay").hidden = false;
  if (!expense) $("fAmount").focus();
}
function closeForm() {
  $("overlay").hidden = true;
  state.editingId = null;
}

function parseAmount(str) {
  const n = Number(String(str).trim().replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Обёртка мутаций: блокировка кнопки, обработка ошибок, haptic
async function mutate(action, payload) {
  if (state.busy) return;
  state.busy = true;
  $("saveBtn").disabled = true;
  try {
    applyData(await api(action, payload));
    tg?.HapticFeedback?.notificationOccurred?.("success");
    closeForm();
  } catch (err) {
    alertMsg(err.message);
  } finally {
    state.busy = false;
    $("saveBtn").disabled = false;
  }
}

function alertMsg(msg) {
  if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
}

// ---------- Утилиты ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_RU[m - 1]} ${y}`;
}
function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayISO();
  if (iso === today) return "Сегодня";
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (iso === `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`) return "Вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" });
}

// ---------- Старт ----------
async function init() {
  // Приложение работает ТОЛЬКО внутри Telegram: initData пуст вне Telegram,
  // и сервер такой запрос отклонит.
  if (!tg || !tg.initData) {
    $("status").innerHTML = "Откройте приложение через Telegram<br>(кнопка меню бота).";
    return;
  }

  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes?.(); } catch (_) { /* старые клиенты */ }
  applyTheme();
  tg.onEvent("themeChanged", applyTheme);

  // Категории в select
  $("fCategory").innerHTML = CATEGORIES.map((c) => `<option value="${c.name}">${c.emoji} ${c.name}</option>`).join("");

  // Месяц по умолчанию — текущий
  $("monthPicker").value = state.month;
  $("monthPicker").onchange = async (e) => {
    if (!e.target.value) return;
    state.month = e.target.value;
    try { await loadData(); } catch (err) { alertMsg(err.message); }
  };

  // Фильтр ленты
  $("scopeTabs").querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => { state.scope = btn.dataset.scope; render(); };
  });

  // Форма
  $("addBtn").onclick = () => openForm();
  $("cancelBtn").onclick = closeForm;
  $("overlay").onclick = (e) => { if (e.target === $("overlay")) closeForm(); };
  $("expenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const amount = parseAmount($("fAmount").value);
    if (amount === null || amount <= 0) return alertMsg("Введите сумму больше 0");
    const payload = {
      month: state.month,
      amount,
      category: $("fCategory").value,
      spent_at: $("fDate").value,
      comment: $("fComment").value,
    };
    if (state.editingId) {
      await mutate("update", { id: state.editingId, ...payload });
    } else {
      await mutate("add", payload);
    }
  };
  $("deleteBtn").onclick = async () => {
    if (!state.editingId) return;
    const doDelete = () => mutate("delete", { id: state.editingId, month: state.month });
    if (tg?.showConfirm) tg.showConfirm("Удалить эту трату?", (ok) => ok && doDelete());
    else if (confirm("Удалить эту трату?")) doDelete();
  };

  // Первая загрузка: initData → функция валидирует → данные месяца
  try {
    await loadData();
    $("status").hidden = true;
    $("app").hidden = false;
  } catch (err) {
    $("status").innerHTML = `${escapeHtml(err.message)}<br><br>Попробуйте закрыть и открыть приложение заново.`;
  }
}

init();
