// ============================================================
// Edge Function `api` — единая точка входа Mini App.
//
// Почему proxy-режим, а не кастомный JWT:
//   * не нужно подписывать/обновлять токены и хранить JWT-секрет;
//   * initData валидируется при КАЖДОМ запросе — украденный «токен»
//     не даёт ничего, кроме повторного прохода той же проверки;
//   * вся логика прав («только свои записи») в одном месте.
// RLS на таблицах включён без политик → прямой доступ из frontend невозможен.
//
// Secrets (Dashboard → Edge Functions → api → Secrets):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather (ОБЯЗАТЕЛЬНО задать).
//   SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
//
// Деплой: Dashboard → Edge Functions → Create function → имя `api`,
// вставить этот код, ВЫКЛЮЧИТЬ «Verify JWT» (валидация у нас своя),
// либо CLI: supabase functions deploy api --no-verify-jwt
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Фиксированные категории — должны совпадать с constraint в SQL и app.js
const CATEGORIES = ["Еда", "Транспорт", "Жильё", "Развлечения", "Здоровье", "Подарки", "Прочее"];

// initData считается свежей 24 часа (Telegram перевыпускает её при каждом открытии)
const INIT_DATA_TTL_SEC = 24 * 60 * 60;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*", // initData-подпись — наша защита, не origin
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------- Валидация Telegram initData ----------
// Алгоритм из официальной документации Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   1. data_check_string = все поля кроме hash, отсортированные по ключу,
//      в формате key=value, соединённые "\n" (значения URL-декодированы).
//   2. secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   3. calc_hash  = HMAC_SHA256(key=secret_key, msg=data_check_string)
//   4. calc_hash должен совпасть с полем hash.
const enc = new TextEncoder();

async function hmacSha256(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

interface TgUser { id: number; first_name?: string; username?: string }

async function validateInitData(initData: string): Promise<TgUser | null> {
  if (!BOT_TOKEN) return null; // секрет не задан — отказываем всем
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = await hmacSha256(enc.encode("WebAppData"), BOT_TOKEN);
  const calc = await hmacSha256(secretKey, dataCheckString);
  const calcHex = [...calc].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Сравнение подписи
  if (calcHex !== hash.toLowerCase()) return null;

  // Защита от повторного использования старых данных
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_TTL_SEC) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}

// ---------- Вспомогательные ----------
function monthStart(month: string): string | null {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : null;
}

function nextMonth(start: string): string {
  const d = new Date(start + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// Все данные для экрана за месяц: пользователи, траты, бюджет
async function getData(month: string) {
  const from = monthStart(month);
  if (!from) throw httpError(400, "Неверный месяц");
  const [usersRes, expRes, budgetRes] = await Promise.all([
    db.from("users").select("telegram_id, first_name, username"),
    db.from("expenses").select("*")
      .gte("spent_at", from).lt("spent_at", nextMonth(from))
      .order("spent_at", { ascending: false })
      .order("created_at", { ascending: false }),
    db.from("budgets").select("amount").eq("month", from).maybeSingle(),
  ]);
  if (usersRes.error || expRes.error || budgetRes.error) {
    throw httpError(500, "Ошибка чтения из БД");
  }
  return {
    users: usersRes.data,
    expenses: expRes.data,
    budget: budgetRes.data?.amount ?? null,
  };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

// Проверка и нормализация полей траты (общая для add и update)
function parseExpense(p: Record<string, unknown>) {
  const amount = Math.round(Number(p.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 9_999_999_999) {
    throw httpError(400, "Сумма должна быть числом больше 0");
  }
  const category = String(p.category ?? "");
  if (!CATEGORIES.includes(category)) throw httpError(400, "Неизвестная категория");
  const spent_at = String(p.spent_at ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spent_at)) throw httpError(400, "Неверная дата");
  const comment = String(p.comment ?? "").trim().slice(0, 500) || null;
  return { amount, category, spent_at, comment };
}

// ---------- Обработчик ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Только POST" }, 405);

  let body: { action?: string; initData?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Некорректный JSON" }, 400);
  }

  const { action, initData = "", payload = {} } = body;

  try {
    // ping — для keep-alive (cron будит бесплатный проект Supabase).
    // Лёгкий запрос к БД, initData не требуется, данных не отдаёт.
    if (action === "ping") {
      const { error } = await db.from("allowed_users").select("telegram_id").limit(1);
      return json({ ok: !error });
    }

    // 1. Валидация подписи initData — для всех остальных действий
    const tgUser = await validateInitData(initData);
    if (!tgUser) return json({ error: "Невалидная подпись Telegram. Откройте приложение заново через Telegram." }, 401);

    // 2. Проверка белого списка
    const { data: allowed } = await db.from("allowed_users")
      .select("telegram_id").eq("telegram_id", tgUser.id).maybeSingle();
    if (!allowed) return json({ error: "Доступ запрещён: ваш Telegram ID не в списке allowed_users." }, 403);

    // 3. Обновляем имя пользователя (для отображения партнёру)
    await db.from("users").upsert({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name ?? null,
      username: tgUser.username ?? null,
      updated_at: new Date().toISOString(),
    });

    const month = String(payload.month ?? "");

    switch (action) {
      case "data": {
        // Все данные месяца + кто я (frontend берёт имя из users)
        return json({ me: tgUser.id, ...(await getData(month)) });
      }

      case "add": {
        const fields = parseExpense(payload);
        // user_id ВСЕГДА из валидированного initData, не из payload!
        const { error } = await db.from("expenses").insert({ ...fields, user_id: tgUser.id });
        if (error) throw httpError(500, "Не удалось сохранить трату");
        return json({ me: tgUser.id, ...(await getData(month)) });
      }

      case "update": {
        const id = String(payload.id ?? "");
        const { data: row } = await db.from("expenses").select("user_id").eq("id", id).maybeSingle();
        if (!row) throw httpError(404, "Запись не найдена");
        // Право редактирования: только свои записи (аналог RLS-политики,
        // т.к. service_role обходит RLS). Хотите разрешить редактировать
        // обеим — удалите эту проверку.
        if (row.user_id !== tgUser.id) throw httpError(403, "Можно редактировать только свои записи");
        const fields = parseExpense(payload);
        const { error } = await db.from("expenses").update(fields).eq("id", id);
        if (error) throw httpError(500, "Не удалось обновить запись");
        return json({ me: tgUser.id, ...(await getData(month)) });
      }

      case "delete": {
        const id = String(payload.id ?? "");
        const { data: row } = await db.from("expenses").select("user_id").eq("id", id).maybeSingle();
        if (!row) throw httpError(404, "Запись не найдена");
        if (row.user_id !== tgUser.id) throw httpError(403, "Можно удалять только свои записи");
        const { error } = await db.from("expenses").delete().eq("id", id);
        if (error) throw httpError(500, "Не удалось удалить запись");
        return json({ me: tgUser.id, ...(await getData(month)) });
      }

      case "set_budget": {
        const from = monthStart(month);
        if (!from) throw httpError(400, "Неверный месяц");
        const amount = Math.round(Number(payload.amount) * 100) / 100;
        if (amount === 0) {
          // 0 / пусто — убрать бюджет на месяц
          await db.from("budgets").delete().eq("month", from);
        } else {
          if (!Number.isFinite(amount) || amount < 0 || amount > 9_999_999_999) {
            throw httpError(400, "Неверная сумма бюджета");
          }
          // Бюджет общий — менять может любой из двоих
          const { error } = await db.from("budgets").upsert({
            month: from, amount, updated_by: tgUser.id, updated_at: new Date().toISOString(),
          });
          if (error) throw httpError(500, "Не удалось сохранить бюджет");
        }
        return json({ me: tgUser.id, ...(await getData(month)) });
      }

      default:
        return json({ error: "Неизвестное действие" }, 400);
    }
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return json({ error: (e as Error).message ?? "Внутренняя ошибка" }, status);
  }
});
