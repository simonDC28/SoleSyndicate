create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  google_sub text,
  auth_provider text not null default 'email',
  email_verified boolean not null default false,
  name text not null,
  location text not null default '',
  role text not null default 'Buyer & Seller',
  avatar text not null default '',
  bio text not null default '',
  favorites jsonb not null default '[]'::jsonb,
  cart jsonb not null default '[]'::jsonb,
  orders jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles disable row level security;
alter table public.user_profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.user_profiles;
create policy "Users can read their own profile"
  on public.user_profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can insert their own profile" on public.user_profiles;
create policy "Users can insert their own profile"
  on public.user_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.user_profiles;
create policy "Users can update their own profile"
  on public.user_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

alter table public.listings add column if not exists owner_id uuid references auth.users(id) on delete cascade;
create index if not exists listings_owner_id_idx on public.listings(owner_id);
alter table public.listings enable row level security;

drop policy if exists "Listings are public" on public.listings;
create policy "Listings are public"
  on public.listings for select
  using (true);

drop policy if exists "Authenticated users can create listings" on public.listings;
create policy "Authenticated users can create listings"
  on public.listings for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can update their listings" on public.listings;
create policy "Owners can update their listings"
  on public.listings for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can delete their listings" on public.listings;
create policy "Owners can delete their listings"
  on public.listings for delete
  using (auth.uid() = owner_id);

alter table public.messages add column if not exists sender_user_id uuid references auth.users(id) on delete cascade;
alter table public.messages add column if not exists buyer_user_id uuid references auth.users(id) on delete cascade;
alter table public.messages add column if not exists seller_user_id uuid references auth.users(id) on delete cascade;
create index if not exists messages_buyer_user_id_idx on public.messages(buyer_user_id);
create index if not exists messages_seller_user_id_idx on public.messages(seller_user_id);
alter table public.messages enable row level security;

drop policy if exists "Participants can read messages" on public.messages;
create policy "Participants can read messages"
  on public.messages for select
  using (
    auth.uid() = buyer_user_id
    or auth.uid() = seller_user_id
  );

drop policy if exists "Participants can send messages" on public.messages;
create policy "Participants can send messages"
  on public.messages for insert
  with check (
    auth.uid() = sender_user_id
    and (
      auth.uid() = buyer_user_id
      or auth.uid() = seller_user_id
    )
  );

drop policy if exists "Participants can delete conversations" on public.messages;
create policy "Participants can delete conversations"
  on public.messages for delete
  using (
    auth.uid() = buyer_user_id
    or auth.uid() = seller_user_id
  );

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (
    id,
    email,
    auth_provider,
    email_verified,
    name,
    location,
    role,
    avatar
  )
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_app_meta_data->>'provider', 'email'),
    coalesce(new.email_confirmed_at is not null, false),
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'location', ''),
    coalesce(new.raw_user_meta_data->>'role', 'Buyer & Seller'),
    coalesce(new.raw_user_meta_data->>'avatar', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        email_verified = excluded.email_verified,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

grant usage on schema public to anon, authenticated;
grant select on public.listings to anon, authenticated;
