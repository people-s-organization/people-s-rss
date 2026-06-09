-- If the app uses Supabase's Data API via @supabase/supabase-js, add `rss`
-- to the project's exposed schemas. These tables still grant access only to
-- service_role; anon/authenticated are revoked below.

create extension if not exists pgcrypto;

create schema if not exists rss;

revoke all on schema rss from public;
revoke all on schema rss from anon, authenticated;
grant usage on schema rss to service_role;

create table if not exists rss.app_users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  avatar_url text,
  primary_email text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists rss.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references rss.app_users(id) on delete cascade,

  provider text not null,
  provider_user_id text not null,
  email text,
  email_verified boolean not null default false,
  display_name text,
  avatar_url text,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  unique (provider, provider_user_id)
);

create index if not exists user_identities_user_id_idx
  on rss.user_identities (user_id);

create table if not exists rss.user_sync_state (
  user_id uuid primary key references rss.app_users(id) on delete cascade,

  initialized boolean not null default false,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists rss.feed_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references rss.app_users(id) on delete cascade,

  name text not null,
  position integer not null default 0,
  collapsed boolean not null default false,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists feed_categories_user_name_idx
  on rss.feed_categories (user_id, lower(name));

create index if not exists feed_categories_user_position_idx
  on rss.feed_categories (user_id, position);

create table if not exists rss.user_feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references rss.app_users(id) on delete cascade,
  category_id uuid references rss.feed_categories(id) on delete set null,

  url text not null,
  title text not null,
  site_url text,
  position integer not null default 0,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  unique (user_id, url)
);

create index if not exists user_feeds_user_position_idx
  on rss.user_feeds (user_id, position);

create index if not exists user_feeds_user_category_position_idx
  on rss.user_feeds (user_id, category_id, position);

create table if not exists rss.user_ai_settings (
  user_id uuid primary key references rss.app_users(id) on delete cascade,

  endpoint text,
  model text,
  style text not null default 'openai'
    check (style in ('openai', 'anthropic')),
  summary_language text not null default 'ui'
    check (summary_language in ('ui', 'zh', 'en', 'source')),

  encrypted_api_key text,
  api_key_updated_at timestamp with time zone,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

drop trigger if exists touch_app_users_updated_at on rss.app_users;
drop trigger if exists touch_user_identities_updated_at on rss.user_identities;
drop trigger if exists touch_user_sync_state_updated_at on rss.user_sync_state;
drop trigger if exists touch_feed_categories_updated_at on rss.feed_categories;
drop trigger if exists touch_user_feeds_updated_at on rss.user_feeds;
drop trigger if exists touch_user_ai_settings_updated_at on rss.user_ai_settings;
drop function if exists rss.touch_updated_at();

alter table rss.app_users enable row level security;
alter table rss.user_identities enable row level security;
alter table rss.user_sync_state enable row level security;
alter table rss.feed_categories enable row level security;
alter table rss.user_feeds enable row level security;
alter table rss.user_ai_settings enable row level security;

revoke all on rss.app_users from anon, authenticated;
revoke all on rss.user_identities from anon, authenticated;
revoke all on rss.user_sync_state from anon, authenticated;
revoke all on rss.feed_categories from anon, authenticated;
revoke all on rss.user_feeds from anon, authenticated;
revoke all on rss.user_ai_settings from anon, authenticated;

grant select, insert, update, delete on rss.app_users to service_role;
grant select, insert, update, delete on rss.user_identities to service_role;
grant select, insert, update, delete on rss.user_sync_state to service_role;
grant select, insert, update, delete on rss.feed_categories to service_role;
grant select, insert, update, delete on rss.user_feeds to service_role;
grant select, insert, update, delete on rss.user_ai_settings to service_role;
