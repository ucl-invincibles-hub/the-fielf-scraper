create table if not exists round_checkpoints (
  id uuid default gen_random_uuid() primary key,
  player_name text not null,
  tournament_name text not null,
  points_at_r2 int not null default 0,
  updated_at timestamptz default now(),
  unique(player_name, tournament_name)
);
alter table round_checkpoints enable row level security;
-- No policies needed: only the scraper (service-role key) ever touches this table.

create table if not exists manual_substitutions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null,
  tournament_name text not null,
  outgoing_player_id text not null,
  incoming_player_id text not null,
  created_at timestamptz default now(),
  unique(user_id, tournament_name)
);
alter table manual_substitutions enable row level security;

create policy "Users can view their own substitutions"
  on manual_substitutions for select
  using (auth.uid() = user_id);

create policy "Users can record their own substitutions"
  on manual_substitutions for insert
  with check (auth.uid() = user_id);
