# The Field — Live Scoring Scraper

Runs every 5 minutes, fetches PGA Tour + LIV Golf leaderboards, calculates fantasy points, writes to Supabase.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. In Railway: New Project → Deploy from GitHub → select the repo
3. Add environment variables:
   - SUPABASE_URL=https://peekrbzmaocuportertr.supabase.co
   - SUPABASE_KEY=your_supabase_service_role_key
4. Deploy — Railway will install dependencies and start automatically

## Supabase Setup

Run this SQL in your Supabase SQL editor FIRST:

```sql
CREATE TABLE live_scores (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  player_name text NOT NULL,
  tour text NOT NULL,
  tournament_name text NOT NULL,
  tournament_type text DEFAULT 'standard',
  round integer DEFAULT 1,
  position text,
  thru integer DEFAULT 0,
  total_score integer DEFAULT 0,
  round_score integer DEFAULT 0,
  stroke_points integer DEFAULT 0,
  finish_points integer DEFAULT 0,
  total_points integer DEFAULT 0,
  status text DEFAULT 'active',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(player_name, tournament_name, round)
);

ALTER TABLE live_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON live_scores FOR SELECT USING (true);
CREATE POLICY "Service write" ON live_scores FOR ALL USING (true);
```

## How it works

- Fetches PGA Tour leaderboard from statdata.pgatour.com every 5 mins
- Fetches LIV Golf leaderboard when there's a concurrent event
- Calculates fantasy points using The Field scoring rules:
  - Birdies +3, Eagles +8, HIO +15, Pars 0, Bogeys -1, Doubles -3, Triples -5, Blob -8
  - Win +25, 2nd +15, 3rd +12, Top5 +10, Top10 +6, Top20 +3
  - Missed cut / LIV bottom 27: -10
  - Signature events: 1.25x finish multiplier
  - Majors: 1.5x finish multiplier (both + and -)
- Upserts to Supabase live_scores table
- App reads from Supabase to display live leaderboard
