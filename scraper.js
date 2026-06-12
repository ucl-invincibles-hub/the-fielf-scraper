// ═══════════════════════════════════════════════════════
// THE FIELD — Live Scoring Scraper v3
// ESPN API + proper stroke data parsing
// ═══════════════════════════════════════════════════════

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://peekrbzmaocuportertr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWtyYnptYW9jdXBvcnRlcnRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5MjM2OCwiZXhwIjoyMDk2NzY4MzY4fQ.4XbODFXnJBOphYw6p1YvskqHwclH_s22G_VbykXQV2U';
const INTERVAL_MS = 5 * 60 * 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Scoring Rules ─────────────────────────────────────────
const TOURNAMENT_TYPES = {
  major: ['masters','u.s. open','us open','the open','open championship','pga championship'],
  signature: ['the players','arnold palmer','genesis invitational','rbc heritage','wells fargo',
               'memorial','travelers','genesis scottish','bmw championship','tour championship',
               'at&t pebble beach']
};

function getTournamentType(name) {
  const n = (name || '').toLowerCase();
  if (TOURNAMENT_TYPES.major.some(m => n.includes(m))) return 'major';
  if (TOURNAMENT_TYPES.signature.some(s => n.includes(s))) return 'signature';
  return 'standard';
}

function getMultiplier(type) {
  return type === 'major' ? 1.5 : type === 'signature' ? 1.25 : 1;
}

function calcFinishPoints(posNum, tournamentType) {
  if (!posNum || posNum >= 9999) return -10; // cut
  const mult = getMultiplier(tournamentType);
  let pts = 0;
  if (posNum === 1) pts = 25;
  else if (posNum === 2) pts = 15;
  else if (posNum === 3) pts = 12;
  else if (posNum <= 5) pts = 10;
  else if (posNum <= 10) pts = 6;
  else if (posNum <= 20) pts = 3;
  return Math.round(pts * mult);
}

// ── Fetch detailed scorecards for stroke play scoring ────
async function fetchScorecard(eventId, athleteId) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/summary?event=${eventId}&athlete=${athleteId}`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch(e) {
    return null;
  }
}

// ── Parse ESPN stat value ─────────────────────────────────
function getStat(statistics, names) {
  for (const name of names) {
    const s = statistics.find(x => 
      (x.abbreviation || '').toLowerCase() === name.toLowerCase() ||
      (x.name || '').toLowerCase().includes(name.toLowerCase())
    );
    if (s) {
      const v = parseInt(s.displayValue || s.value || 0);
      return isNaN(v) ? 0 : v;
    }
  }
  return 0;
}

function calcStrokePoints(stats) {
  const birdies = getStat(stats, ['birdies', 'bir', 'B']);
  const eagles  = getStat(stats, ['eagles', 'eag', 'E']);
  const hio     = getStat(stats, ['hio', 'holeinone', 'hole in one']);
  const bogeys  = getStat(stats, ['bogeys', 'bog', 'BO']);
  const doubles = getStat(stats, ['doubles', 'dbl', 'DB', 'double bogeys']);
  const triples = getStat(stats, ['triples', 'tri', 'TB', 'triple bogeys']);
  const blobs   = getStat(stats, ['others', 'oth', 'OT', 'worse']);

  return (hio * 15) + (eagles * 8) + (birdies * 3)
       + (bogeys * -1) + (doubles * -3) + (triples * -5) + (blobs * -8);
}

// ── Fetch PGA Tour leaderboard via ESPN ──────────────────
async function fetchPGA() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    const data = await res.json();

    const events = data.events || [];
    if (!events.length) { console.log('PGA: No active events'); return null; }

    const event = events[0];
    const eventId = event.id;
    const tournamentName = event.name || 'PGA Event';
    const tournamentType = getTournamentType(tournamentName);
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const round = competition.status?.period || 1;
    const statusDesc = competition.status?.type?.description || 'In Progress';
    const isComplete = competition.status?.type?.completed || false;

    console.log(`\n📍 ${tournamentName} (${tournamentType})`);
    console.log(`📋 Round ${round} | ${statusDesc} | ${competition.competitors?.length || 0} players`);

    const players = [];

    for (const c of (competition.competitors || [])) {
      const name = c.athlete?.displayName || 'Unknown';
      const posStr = c.status?.position?.displayName || c.status?.displayValue || '';
      const posNum = parseInt(posStr.replace(/[^0-9]/g, '')) || 999;
      const isCut = posStr.toUpperCase() === 'CUT' || c.status?.type?.id === '5';
      const thru = c.status?.thru || (isComplete ? 18 : 0);
      const totalScore = parseInt(c.score) || 0;

      // Get stroke stats from statistics array
      const stats = c.statistics || [];
      const strokePts = calcStrokePoints(stats);

      // Also try to get from linescores if statistics empty
      let altStrokePts = 0;
      if (strokePts === 0 && c.linescores && c.linescores.length > 0) {
        // linescores are scores per round — we can approximate from score vs par
        // This is less accurate but better than 0
        altStrokePts = 0; // Will rely on finish points for now
      }

      const finishPts = isCut ? -10 : (isComplete ? calcFinishPoints(posNum, tournamentType) : 0);
      const totalPts = strokePts + finishPts;

      players.push({
        player_name: name,
        tour: 'PGA',
        tournament_name: tournamentName,
        tournament_type: tournamentType,
        round: parseInt(round),
        position: isCut ? 'CUT' : posStr || String(posNum),
        thru: thru,
        total_score: totalScore,
        round_score: parseInt(c.linescores?.[c.linescores.length - 1]?.value || 0) || 0,
        birdies: getStat(stats, ['birdies','bir']),
        eagles: getStat(stats, ['eagles','eag']),
        bogeys: getStat(stats, ['bogeys','bog']),
        doubles_or_worse: getStat(stats, ['doubles','dbl']) + getStat(stats, ['triples','tri']) + getStat(stats, ['others','oth']),
        stroke_points: strokePts,
        finish_points: finishPts,
        total_points: totalPts,
        status: isCut ? 'cut' : 'active',
        updated_at: new Date().toISOString()
      });
    }

    console.log(`PGA: ${players.length} players | stroke pts sample: ${players.slice(0,3).map(p => p.player_name+':'+p.stroke_points).join(', ')}`);
    return { tournament: tournamentName, round, players };

  } catch(e) {
    console.error('PGA fetch error:', e.message);
    return null;
  }
}

// ── Fetch LIV ─────────────────────────────────────────────
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
    const isComplete = competition.status?.type?.completed || false;
    const competitors = competition.competitors || [];

    const players = competitors.map((c, idx) => {
      const posStr = c.status?.position?.displayName || String(idx + 1);
      const posNum = parseInt(posStr.replace(/[^0-9]/g, '')) || idx + 1;
      const isBottom27 = posNum > 27;
      const stats = c.statistics || [];
      const strokePts = calcStrokePoints(stats);
      const finishPts = isBottom27 ? -10 : (isComplete ? calcFinishPoints(posNum, 'standard') : 0);

      return {
        player_name: c.athlete?.displayName || 'Unknown',
        tour: 'LIV',
        tournament_name: tournamentName,
        tournament_type: 'standard',
        round: parseInt(round),
        position: posStr,
        thru: c.status?.thru || (isComplete ? 54 : 0),
        total_score: parseInt(c.score) || 0,
        round_score: 0,
        birdies: getStat(stats, ['birdies','bir']),
        eagles: getStat(stats, ['eagles','eag']),
        bogeys: getStat(stats, ['bogeys','bog']),
        doubles_or_worse: getStat(stats, ['doubles','dbl']),
        stroke_points: strokePts,
        finish_points: finishPts,
        total_points: strokePts + finishPts,
        status: isBottom27 ? 'bottom27' : 'active',
        updated_at: new Date().toISOString()
      };
    });

    console.log(`LIV: ${players.length} players | ${tournamentName}`);
    return players.length ? { players } : null;
  } catch(e) {
    console.log('LIV: No active event');
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
  else console.log(`✅ Wrote ${players.length} players to Supabase`);
}

// ── Schema check ──────────────────────────────────────────
async function checkSchema() {
  const { error } = await supabase.from('live_scores').select('player_name').limit(1);
  if (error?.code === '42P01') {
    console.error('❌ live_scores table missing');
    process.exit(1);
  }
  console.log('✅ live_scores table ready');
}

// ── Main loop ─────────────────────────────────────────────
async function scrape() {
  console.log(`\n⏰ ${new Date().toISOString()}`);
  const pga = await fetchPGA();
  if (pga?.players?.length) await writeScores(pga.players);
  else console.log('PGA: No active tournament');

  const liv = await fetchLIV();
  if (liv?.players?.length) await writeScores(liv.players);
}

async function main() {
  console.log('🏌️  The Field — Live Scoring Scraper v3');
  console.log('=========================================');
  await checkSchema();
  await scrape();
  setInterval(scrape, INTERVAL_MS);
  console.log(`\n⏱  Scraping every 5 minutes...`);
}

main().catch(console.error);
