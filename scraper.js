// ═══════════════════════════════════════════════════════
// THE FIELD — Live Scoring Scraper v2
// Uses ESPN API (reliable, no auth required)
// Runs every 5 mins, writes to Supabase
// ═══════════════════════════════════════════════════════

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://peekrbzmaocuportertr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWtyYnptYW9jdXBvcnRlcnRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5MjM2OCwiZXhwIjoyMDk2NzY4MzY4fQ.4XbODFXnJBOphYw6p1YvskqHwclH_s22G_VbykXQV2U';
const INTERVAL_MS = 5 * 60 * 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Scoring Rules ─────────────────────────────────────────
const FINISH_PTS = { 1:25, 2:15, 3:12 };
function finishPts(pos) {
  if (pos === 'CUT' || pos === 'WD' || pos === 'DQ') return -10;
  const p = parseInt(pos);
  if (isNaN(p)) return 0;
  if (FINISH_PTS[p]) return FINISH_PTS[p];
  if (p <= 5)  return 10;
  if (p <= 10) return 6;
  if (p <= 20) return 3;
  return 0;
}

const TOURNAMENT_TYPES = {
  major: ['masters','u.s. open','us open','the open','open championship','pga championship'],
  signature: ['the players','arnold palmer','genesis invitational','rbc heritage','wells fargo',
               'memorial','travelers','genesis scottish','bmw championship','tour championship',
               'at&t pebble beach','genesis','john deere']
};
function getTournamentType(name) {
  const n = (name||'').toLowerCase();
  if (TOURNAMENT_TYPES.major.some(m => n.includes(m))) return 'major';
  if (TOURNAMENT_TYPES.signature.some(s => n.includes(s))) return 'signature';
  return 'standard';
}
function getMultiplier(type) {
  return type === 'major' ? 1.5 : type === 'signature' ? 1.25 : 1;
}

// ── ESPN API — much more reliable than PGA Tour direct ────
async function fetchESPN() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    const data = await res.json();

    const events = data.events || [];
    if (!events.length) {
      console.log('ESPN: No active PGA events found');
      return null;
    }

    const event = events[0];
    const tournamentName = event.name || event.shortName || 'PGA Event';
    const tournamentType = getTournamentType(tournamentName);
    const mult = getMultiplier(tournamentType);
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const round = competition.status?.period || 1;
    const status = competition.status?.type?.description || '';
    console.log(`\n📍 ${tournamentName} (${tournamentType} x${mult})`);
    console.log(`📋 Round ${round} | Status: ${status}`);

    const competitors = competition.competitors || [];
    const players = competitors.map(c => {
      const stats = c.statistics || [];
      const name = c.athlete?.displayName || c.athlete?.fullName || 'Unknown';
      const pos = c.status?.position?.displayName || c.status?.displayValue || '99';
      const thru = c.status?.thru || 0;
      const totalScore = parseInt(c.score) || 0;

      // Extract stroke-by-stroke stats from ESPN
      const getStat = (abbr) => {
        const s = stats.find(x => x.abbreviation === abbr || x.name?.toLowerCase().includes(abbr.toLowerCase()));
        return parseInt(s?.displayValue || s?.value || 0) || 0;
      };

      const birdies  = getStat('birdies') || getStat('bir');
      const eagles   = getStat('eagles')  || getStat('eag');
      const hio      = getStat('hio');
      const bogeys   = getStat('bogeys')  || getStat('bog');
      const doubles  = getStat('doubles') || getStat('dbl');
      const triples  = getStat('triples') || getStat('tri');
      const blobs    = getStat('others')  || getStat('oth');

      const strokePts = (hio * 15) + (eagles * 8) + (birdies * 3) +
                        (bogeys * -1) + (doubles * -3) + (triples * -5) + (blobs * -8);

      const isCut = ['cut','wd','dq'].includes(pos.toLowerCase());
      const rawFinish = isCut ? -10 : finishPts(pos);
      const finPts = isCut ? -10 : Math.round(rawFinish * mult);
      const totalPts = strokePts + finPts;

      return {
        player_name: name,
        tour: 'PGA',
        tournament_name: tournamentName,
        tournament_type: tournamentType,
        round: parseInt(round),
        position: pos,
        thru: thru,
        total_score: totalScore,
        round_score: parseInt(c.linescores?.[c.linescores.length-1]?.value || 0) || 0,
        birdies, eagles, bogeys, doubles_or_worse: doubles + triples + blobs,
        stroke_points: strokePts,
        finish_points: finPts,
        total_points: totalPts,
        status: isCut ? 'cut' : 'active',
        updated_at: new Date().toISOString()
      };
    });

    return { tournament: tournamentName, round, type: tournamentType, players };
  } catch (err) {
    console.error('ESPN fetch error:', err.message);
    return null;
  }
}

// ── ESPN LIV endpoint ─────────────────────────────────────
async function fetchLIV() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/golf/liv/scoreboard';
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { console.log('LIV: No active event'); return null; }
    const data = await res.json();

    const events = data.events || [];
    if (!events.length) { console.log('LIV: No active event'); return null; }

    const event = events[0];
    const tournamentName = event.name || 'LIV Event';
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const round = competition.status?.period || 3;
    const competitors = competition.competitors || [];

    const players = competitors.map((c, idx) => {
      const pos = parseInt(c.status?.position?.displayName || idx + 1);
      const isBottom27 = pos > 27;
      const stats = c.statistics || [];
      const getStat = (abbr) => parseInt(stats.find(x => x.abbreviation===abbr)?.displayValue || 0) || 0;
      const birdies = getStat('birdies');
      const eagles  = getStat('eagles');
      const bogeys  = getStat('bogeys');
      const doubles = getStat('doubles');
      const strokePts = (eagles*8)+(birdies*3)+(bogeys*-1)+(doubles*-3);
      const finPts = isBottom27 ? -10 : finishPts(pos);

      return {
        player_name: c.athlete?.displayName || 'Unknown',
        tour: 'LIV',
        tournament_name: tournamentName,
        tournament_type: 'standard',
        round: parseInt(round),
        position: String(pos),
        thru: c.status?.thru || 54,
        total_score: parseInt(c.score) || 0,
        round_score: 0,
        birdies, eagles, bogeys, doubles_or_worse: doubles,
        stroke_points: strokePts,
        finish_points: finPts,
        total_points: strokePts + finPts,
        status: isBottom27 ? 'bottom27' : 'active',
        updated_at: new Date().toISOString()
      };
    });

    console.log(`LIV: ${players.length} players | ${tournamentName}`);
    return players.length ? { players } : null;
  } catch (err) {
    console.log('LIV: No active event this week');
    return null;
  }
}

// ── Write to Supabase ─────────────────────────────────────
async function writeScores(players) {
  if (!players?.length) return;
  const { error } = await supabase
    .from('live_scores')
    .upsert(players, { onConflict: 'player_name,tournament_name,round' });
  if (error) console.error('Supabase error:', error.message);
  else console.log(`✅ Wrote ${players.length} scores to Supabase`);
}

// ── Schema check ──────────────────────────────────────────
async function checkSchema() {
  const { error } = await supabase.from('live_scores').select('player_name').limit(1);
  if (error?.code === '42P01') {
    console.error('❌ live_scores table missing — run the SQL setup in Supabase first');
    process.exit(1);
  }
  console.log('✅ live_scores table ready');
}

// ── Main loop ─────────────────────────────────────────────
async function scrape() {
  console.log(`\n⏰ ${new Date().toISOString()}`);
  const pga = await fetchESPN();
  if (pga?.players?.length) await writeScores(pga.players);
  else console.log('PGA: No active tournament');

  const liv = await fetchLIV();
  if (liv?.players?.length) await writeScores(liv.players);
}

async function main() {
  console.log('🏌️  The Field — Live Scoring Scraper v2');
  console.log('=========================================');
  await checkSchema();
  await scrape();
  setInterval(scrape, INTERVAL_MS);
  console.log(`\n⏱  Scraping every 5 minutes...`);
}

main().catch(console.error);
