-- ============================================================
-- Миграция 0001: таблицы, индексы, RLS
-- Выполнить в Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- ------------------------------------------------------------
-- allowed_users: список разрешённых Telegram ID (ровно двое).
-- Почему таблица, а не переменная Edge Function:
--   * изменить список можно одним SQL-запросом, без редеплоя функции;
--   * функция читает список из БД при каждом запросе — единый источник правды.
-- ВАЖНО: вставьте ниже СВОИ два Telegram ID (узнать: бот @userinfobot).
-- ------------------------------------------------------------
create table public.allowed_users (
  telegram_id bigint primary key,
  note        text            -- произвольная пометка: кто это
);

insert into public.allowed_users (telegram_id, note) values
  (111111111, 'Я'),          -- <-- ЗАМЕНИТЬ на свой Telegram ID
  (222222222, 'Девушка');    -- <-- ЗАМЕНИТЬ на Telegram ID девушки

-- ------------------------------------------------------------
-- users: имена для отображения (заполняется Edge Function при входе)
-- ------------------------------------------------------------
create table public.users (
  telegram_id bigint primary key,
  first_name  text,
  username    text,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- expenses: траты. Категории фиксированы constraint'ом.
-- ------------------------------------------------------------
create table public.expenses (
  id         uuid primary key default gen_random_uuid(),
  user_id    bigint not null,                      -- Telegram ID автора
  amount     numeric(12,2) not null check (amount > 0),
  category   text not null check (category in
             ('Еда','Транспорт','Жильё','Развлечения','Здоровье','Подарки','Прочее')),
  spent_at   date not null default current_date,
  comment    text check (char_length(comment) <= 500),  -- «пометки» к трате
  created_at timestamptz not null default now()
);

create index expenses_user_id_idx  on public.expenses (user_id);
create index expenses_spent_at_idx on public.expenses (spent_at);

-- ------------------------------------------------------------
-- budgets: один общий бюджет на месяц.
-- month — всегда первое число месяца (например 2026-11-01).
-- ------------------------------------------------------------
create table public.budgets (
  month      date primary key,
  amount     numeric(12,2) not null check (amount > 0),
  updated_by bigint,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- RLS: включаем на ВСЕХ таблицах и НЕ создаём политик для
-- anon / authenticated. Без политик = запретить всё.
--
-- Архитектура: frontend НИКОГДА не ходит в таблицы напрямую.
-- Все запросы идут через Edge Function `api`, которая:
--   1) валидирует подпись Telegram initData (HMAC-SHA256);
--   2) проверяет, что user есть в allowed_users;
--   3) работает с БД ключом service_role (он обходит RLS,
--      поэтому права «только свои записи» проверяются в коде функции).
-- Ключ service_role живёт только в secrets функции, во frontend его нет.
-- ============================================================
alter table public.allowed_users enable row level security;
alter table public.users         enable row level security;
alter table public.expenses      enable row level security;
alter table public.budgets       enable row level security;

-- Дополнительно отзываём права у публичных ролей (защита в глубину):
revoke all on public.allowed_users from anon, authenticated;
revoke all on public.users         from anon, authenticated;
revoke all on public.expenses      from anon, authenticated;
revoke all on public.budgets       from anon, authenticated;
