// ═══════════════════════════════════════════════════════
// THE FIELD — Live Scoring Scraper
// Runs every 5 mins during rounds, writes to Supabase
// ═══════════════════════════════════════════════════════

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// ── Config ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://peekrbzmaocuportertr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWtyYnptYW9jdXBvcnRlcnRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5MjM2OCwiZXhwIjoyMDk2NzY4MzY4fQ.4XbODFXnJBOphYw6p1YvskqHwclH_s22G_VbykXQV2U';
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Scoring Rules ────────────────────────────────────────
const SCORING = {
  // Stroke play
  hole_in_one: 15,
  eagle: 8,
  birdie: 3,
  par: 0,
  bogey: -1,
  double_bogey: -3,
  triple_bogey: -5,
  blob: -8, // 4+ over par

  // Finish positions
  win: 25,
  second: 15,
  third: 12,
  top5: 10,
  top10: 6,
  top20: 3,
  missed_cut: -10,

  // Event multipliers (applied to finish points)
  signature: 1.25,
  major: 1.5
};

// ── Tournament type lookup ───────────────────────────────
const TOURNAMENT_TYPES = {
  // Majors
  'masters': 'major',
  'pga championship': 'major',
  'u.s. open': 'major',
  'us open': 'major',
  'the open': 'major',
  'open championship': 'major',
  // Signature events
  'the players': 'signature',
  'arnold palmer': 'signature',
  'genesis invitational': 'signature',
  'rbc heritage': 'signature',
  'wells fargo': 'signature',
  'memorial': 'signature',
  'travelers': 'signature',
  'genesis scottish': 'signature',
  'bmw championship': 'signature',
  'tour championship': 'signature',
  'at&t pebble beach': 'signature',
};

function getTournamentType(name) {
  const lower = (name || '').toLowerCase();
  for (const [key, type] of Object.entries(TOURNAMENT_TYPES)) {
    if (lower.includes(key)) return type;
  }
  return 'standard';
}

// ── Calculate finish position points ─────────────────────
function calcFinishPoints(position, tournamentType) {
  let pts = 0;
  const pos = parseInt(position);
  if (isNaN(pos)) return position === 'CUT' ? SCORING.missed_cut : 0;

  if (pos === 1) pts = SCORING.win;
  else if (pos === 2) pts = SCORING.second;
  else if (pos === 3) pts = SCORING.third;
  else if (pos <= 5) pts = SCORING.top5;
  else if (pos <= 10) pts = SCORING.top10;
  else if (pos <= 20) pts = SCORING.top20;

  // Apply multiplier
  const mult = SCORING[tournamentType] || 1;
  return Math.round(pts * mult);
}

// ── Calculate stroke play points from scorecard ──────────
function calcStrokePoints(scores) {
  // scores = array of hole results vs par
  // e.g. [-1, 0, 1, -2, 0, 0, 1, 0, -1, ...]
  let total = 0;
  for (const diff of scores) {
    if (diff <= -2) total += SCORING.eagle;
    else if (diff === -1) total += SCORING.birdie;
    else if (diff === 0) total += SCORING.par;
    else if (diff === 1) total += SCORING.bogey;
    else if (diff === 2) total += SCORING.double_bogey;
    else if (diff === 3) total += SCORING.triple_bogey;
    else if (diff >= 4) total += SCORING.blob;
  }
  return total;
}

// ── Fetch PGA Tour leaderboard ────────────────────────────
async function fetchPGALeaderboard() {
  try {
    // Try current tournament endpoint
    const url = 'https://statdata.pgatour.com/r/current/leaderboard-v2.json';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheField/1.0)',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!res.ok) {
      console.log(`PGA fetch failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (!data || !data.leaderboardV2) {
      console.log('PGA: No leaderboard data in response');
      return null;
    }

    const lb = data.leaderboardV2;
    const tournamentName = lb.tournamentName || 'Unknown Tournament';
    const round = lb.currentRound || 1;
    const tournamentType = getTournamentType(tournamentName);

    console.log(`\n📍 Tournament: ${tournamentName} (${tournamentType})`);
    console.log(`📋 Round: ${round} | Players: ${lb.players?.length || 0}`);

    const players = (lb.players || []).map(p => {
      const position = p.posNum || p.position || 99;
      const thru = p.thru || 0;
      const totalScore = p.total || 0;
      const roundScore = p.roundScore || 0;
      const playerName = p.playerNames?.shortName || p.playerName || 'Unknown';

      // Calculate stroke points from round scores if available
      let strokePts = 0;
      if (p.rounds && p.rounds.length > 0) {
        for (const rnd of p.rounds) {
          if (rnd.strokes && rnd.strokes.length > 0) {
            // Has hole-by-hole data
            const diffs = rnd.strokes.map((s, i) => {
              const par = rnd.pars?.[i] || 4;
              return s - par;
            });
            strokePts += calcStrokePoints(diffs);
          } else if (rnd.birdies !== undefined) {
            // Has aggregate data
            strokePts += (rnd.birdies || 0) * 3;
            strokePts += (rnd.eagles || 0) * 8;
            strokePts += (rnd.holeInOnes || 0) * 15;
            strokePts += (rnd.bogeys || 0) * -1;
            strokePts += (rnd.doubleBogeys || 0) * -3;
            strokePts += (rnd.worseThanDouble || 0) * -5;
          }
        }
      }

      const isCut = p.status === 'cut' || String(position).toUpperCase() === 'CUT';
      const finishPts = isCut ? SCORING.missed_cut :
        (p.status === 'active' ? 0 : calcFinishPoints(position, tournamentType));

      const totalPts = strokePts + finishPts;

      return {
        player_name: playerName,
        tour: 'PGA',
        tournament_name: tournamentName,
        tournament_type: tournamentType,
        round: parseInt(round),
        position: isCut ? 'CUT' : String(position),
        thru: thru,
        total_score: totalScore,
        round_score: roundScore,
        stroke_points: strokePts,
        finish_points: finishPts,
        total_points: totalPts,
        status: p.status || 'active',
        updated_at: new Date().toISOString()
      };
    });

    return { tournament: tournamentName, round, type: tournamentType, players };
  } catch (err) {
    console.error('PGA fetch error:', err.message);
    return null;
  }
}

// ── Fetch LIV leaderboard ─────────────────────────────────
async function fetchLIVLeaderboard() {
  try {
    // LIV uses a GraphQL-ish API on their website
    const url = 'https://www.livgolf.com/api/leaderboard';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheField/1.0)',
        'Accept': 'application/json',
        'x-api-key': 'liv-public'
      },
      timeout: 10000
    });

    if (!res.ok) {
      console.log(`LIV fetch failed: ${res.status} — may not be a LIV week`);
      return null;
    }

    const data = await res.json();
    if (!data) return null;

    const players = (data.leaderboard || data.players || []).map((p, idx) => {
      const position = p.position || idx + 1;
      // LIV: bottom 27 of 54 get missed cut penalty
      const isBottom27 = parseInt(position) > 27;
      const finishPts = isBottom27 ? SCORING.missed_cut :
        calcFinishPoints(position, 'standard');

      let strokePts = 0;
      if (p.birdies !== undefined) {
        strokePts += (p.birdies || 0) * 3;
        strokePts += (p.eagles || 0) * 8;
        strokePts += (p.bogeys || 0) * -1;
        strokePts += (p.doubleBogeys || 0) * -3;
        strokePts += (p.worseThanDouble || 0) * -5;
      }

      return {
        player_name: p.playerName || p.name || 'Unknown',
        tour: 'LIV',
        tournament_name: data.tournamentName || 'LIV Event',
        tournament_type: 'standard',
        round: parseInt(data.currentRound || 3),
        position: String(position),
        thru: p.thru || 54,
        total_score: p.total || 0,
        round_score: p.roundScore || 0,
        stroke_points: strokePts,
        finish_points: finishPts,
        total_points: strokePts + finishPts,
        status: isBottom27 ? 'bottom27' : 'active',
        updated_at: new Date().toISOString()
      };
    });

    return players.length > 0 ? { players } : null;
  } catch (err) {
    console.log('LIV fetch error (likely not a LIV week):', err.message);
    return null;
  }
}

// ── Write scores to Supabase ──────────────────────────────
async function writeToSupabase(players) {
  if (!players || players.length === 0) return;

  try {
    // Upsert based on player_name + tournament_name + round
    const { data, error } = await supabase
      .from('live_scores')
      .upsert(players, {
        onConflict: 'player_name,tournament_name,round',
        ignoreDuplicates: false
      });

    if (error) {
      console.error('Supabase write error:', error.message);
    } else {
      console.log(`✅ Wrote ${players.length} player scores to Supabase`);
    }
  } catch (err) {
    console.error('Supabase error:', err.message);
  }
}

// ── Main scrape loop ──────────────────────────────────────
async function scrape() {
  const now = new Date();
  console.log(`\n⏰ Scraping at ${now.toISOString()}`);

  // PGA Tour
  const pgaData = await fetchPGALeaderboard();
  if (pgaData && pgaData.players.length > 0) {
    await writeToSupabase(pgaData.players);
    console.log(`PGA: ${pgaData.players.length} players | ${pgaData.tournament}`);
  } else {
    console.log('PGA: No active tournament data');
  }

  // LIV Golf (concurrent weeks)
  const livData = await fetchLIVLeaderboard();
  if (livData && livData.players.length > 0) {
    await writeToSupabase(livData.players);
    console.log(`LIV: ${livData.players.length} players`);
  } else {
    console.log('LIV: No active event this week');
  }
}

// ── Supabase schema setup ─────────────────────────────────
async function ensureSchema() {
  // Check if live_scores table exists
  const { error } = await supabase
    .from('live_scores')
    .select('player_name')
    .limit(1);

  if (error && error.code === '42P01') {
    console.log('⚠️  live_scores table missing — create it in Supabase SQL editor:');
    console.log(`
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

-- Public read access
ALTER TABLE live_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON live_scores FOR SELECT USING (true);
CREATE POLICY "Service write" ON live_scores FOR ALL USING (true);
`);
  } else {
    console.log('✅ live_scores table found');
  }
}

// ── Start ─────────────────────────────────────────────────
async function main() {
  console.log('🏌️  The Field — Live Scoring Scraper');
  console.log('=====================================');
  await ensureSchema();

  // Run immediately
  await scrape();

  // Then every 5 minutes
  console.log(`\n⏱  Running every ${INTERVAL_MS / 60000} minutes...`);
  setInterval(scrape, INTERVAL_MS);
}

main().catch(console.error);
