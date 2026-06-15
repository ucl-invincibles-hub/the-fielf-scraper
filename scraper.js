// THE FIELD — Live Scoring Scraper v5
// Updated scoring table (June 2026): all values even so VC x1.5 never produces a fraction
// Major win +42 (1.5x of +28) · Tournament win +28 · 2nd +20 · 3rd +14 · Top5 +10 · Top10 +6 · Top20 +2 · Missed cut/bottom27 -10
// Hole in one +20 · Eagle +8 · Birdie +4 · Par 0 · Bogey -2 · Double -4 · Triple -6 · Blob -8
// Signature event multiplier removed — only Major events carry a multiplier (1.5x)

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://peekrbzmaocuportertr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWtyYnptYW9jdXBvcnRlcnRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5MjM2OCwiZXhwIjoyMDk2NzY4MzY4fQ.4XbODFXnJBOphYw6p1YvskqHwclH_s22G_VbykXQV2U';
const INTERVAL_MS = 5 * 60 * 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TOURNAMENT_TYPES = {
  major: ['masters','u.s. open','us open','the open','open championship','pga championship']
};

function getTournamentType(name) {
  const n = (name || '').toLowerCase();
  if (TOURNAMENT_TYPES.major.some(m => n.includes(m))) return 'major';
  return 'standard';
}

function getMultiplier(type) {
  return type === 'major' ? 1.5 : 1;
}

function calcFinishPoints(posNum, type) {
  const mult = getMultiplier(type);
  let pts = 0;
  if (posNum === 1) pts = 28;
  else if (posNum === 2) pts = 20;
  else if (posNum === 3) pts = 14;
  else if (posNum <= 5) pts = 10;
  else if (posNum <= 10) pts = 6;
  else if (posNum <= 20) pts = 2;
  return Math.round(pts * mult);
}

// Estimate stroke points from cumulative score vs par
// We know total_score (e.g. -10 means 10 under) but not individual holes
// Use average round scoring as a proxy:
// Each round of golf has ~18 holes - distribute score across rounds played
// This is an approximation until we get hole-by-hole data
//
// New scoring scale: Birdie +4, Eagle +8, Bogey -2, Double -4
// Under-par blend (mostly birdies, some eagles): ~3.7 pts per shot under par
// Over-par blend (mostly bogeys, some doubles): ~-3.0 pts per shot over par
function estimateStrokePoints(totalScore, roundsPlayed) {
  if (!roundsPlayed || roundsPlayed === 0) return 0;
  const rounds = Math.max(1, roundsPlayed);

  const score = parseInt(totalScore) || 0;
  if (score < 0) {
    // Under par: mix of birdies and eagles
    return Math.round(Math.abs(score) * 3.7);
  } else if (score > 0) {
    // Over par: mix of bogeys and doubles
    return Math.round(score * -3.0);
  }
  return 0;
}

async function fetchPGA() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    const data = await res.json();

    const events = data.events || [];
    if (!events.length) { console.log('PGA: No active events'); return null; }

    const event = events[0];
    const tournamentName = event.name || 'PGA Event';
    const tournamentType = getTournamentType(tournamentName);
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const round = parseInt(competition.status?.period || 1);
    const statusDesc = competition.status?.type?.description || '';
    const isComplete = competition.status?.type?.completed || false;

    console.log(`\n📍 ${tournamentName} (${tournamentType}) R${round} | ${statusDesc}`);

    const players = [];

    for (const c of (competition.competitors || [])) {
      const name = c.athlete?.displayName || 'Unknown';

      // Position: ESPN uses status.position.displayName OR status.displayValue
      const statusVal = c.status?.displayValue || '';
      const positionDisplay = c.status?.position?.displayName || '';

      // Detect cut
      const isCut = statusVal.toUpperCase() === 'CUT' ||
                    statusVal.toUpperCase() === 'WD' ||
                    statusVal.toUpperCase() === 'DQ';

      // Parse position number - try multiple fields
      let posNum = 999;
      let posStr = 'CUT';

      if (!isCut) {
        // positionDisplay might be "1", "T2", "T10" etc
        const posRaw = positionDisplay || statusVal;
        posStr = posRaw || '-';
        posNum = parseInt(posRaw.replace(/[^0-9]/g, '')) || 999;
        // If still 999, try sorting by score later
      }

      const thru = c.status?.thru || 0;
      const totalScore = parseInt(c.score) || 0; // cumulative vs par

      // Current round score from linescores
      const linescores = c.linescores || [];
      const roundScore = linescores.length > 0 ?
        parseInt(linescores[linescores.length - 1]?.value || 0) || 0 : 0;

      // Rounds played = number of completed rounds
      const roundsPlayed = isComplete ? round : Math.max(0, round - (thru < 18 ? 1 : 0));

      // Stroke points estimated from total score
      const strokePts = estimateStrokePoints(totalScore, roundsPlayed);

      // Finish points only when tournament complete
      const finishPts = isCut ? -10 : (isComplete ? calcFinishPoints(posNum, tournamentType) : 0);
      const totalPts = strokePts + finishPts;

      players.push({
        player_name: name,
        tour: 'PGA',
        tournament_name: tournamentName,
        tournament_type: tournamentType,
        round,
        position: isCut ? 'CUT' : posStr,
        thru,
        total_score: totalScore,
        round_score: roundScore,
        birdies: 0,
        eagles: 0,
        bogeys: 0,
        doubles_or_worse: 0,
        stroke_points: strokePts,
        finish_points: finishPts,
        total_points: totalPts,
        status: isCut ? 'cut' : 'active',
        updated_at: new Date().toISOString()
      });
    }

    // Sort by total_score to assign positions if ESPN didn't provide them
    // (handles the position:999 issue)
    players.sort((a, b) => {
      if (a.status === 'cut' && b.status !== 'cut') return 1;
      if (a.status !== 'cut' && b.status === 'cut') return -1;
      return a.total_score - b.total_score;
    });

    // Re-assign positions if they're all 999
    const allPos999 = players.filter(p => p.status !== 'cut').every(p => p.position === '-' || p.position === '999');
    if (allPos999) {
      console.log('Positions not from ESPN — assigning from score order');
      let rank = 1;
      for (let i = 0; i < players.length; i++) {
        if (players[i].status === 'cut') break;
        if (i > 0 && players[i].total_score === players[i-1].total_score) {
          players[i].position = 'T' + (rank);
          players[i-1].position = 'T' + (rank);
        } else {
          if (i > 0) rank = i + 1;
          players[i].position = String(rank);
        }
        // Recalculate finish pts with new position
        const pn = parseInt(players[i].position.replace(/[^0-9]/g,'')) || 999;
        const fp = isComplete ? calcFinishPoints(pn, tournamentType) : 0;
        players[i].finish_points = fp;
        players[i].total_points = players[i].stroke_points + fp;
      }
    }

    const sample = players.slice(0, 3).map(p => `${p.position}:${p.player_name.split(' ').pop()}(${p.total_score},${p.total_points}pts)`).join(' ');
    console.log(`PGA: ${players.length} players | Top 3: ${sample}`);
    return { players };

  } catch(e) {
    console.error('PGA fetch error:', e.message);
    return null;
  }
}

async function fetchLIV() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/golf/liv/scoreboard';
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { console.log('LIV: No active event'); return null; }
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) { console.log('LIV: No active event'); return null; }
    const event = events[0];
    const competition = event.competitions?.[0];
    if (!competition) return null;
    const round = parseInt(competition.status?.period || 3);
    const isComplete = competition.status?.type?.completed || false;
    const tournamentName = event.name || 'LIV Event';
    const competitors = competition.competitors || [];

    const players = competitors.map((c, idx) => {
      const posStr = c.status?.position?.displayName || c.status?.displayValue || String(idx+1);
      const posNum = parseInt(posStr.replace(/[^0-9]/g,'')) || idx+1;
      const isBottom27 = posNum > 27;
      const totalScore = parseInt(c.score) || 0;
      const strokePts = estimateStrokePoints(totalScore, round);
      const finishPts = isBottom27 ? -10 : (isComplete ? calcFinishPoints(posNum, 'standard') : 0);
      return {
        player_name: c.athlete?.displayName || 'Unknown',
        tour: 'LIV', tournament_name: tournamentName, tournament_type: 'standard',
        round, position: posStr, thru: c.status?.thru || 0,
        total_score: totalScore, round_score: 0,
        birdies: 0, eagles: 0, bogeys: 0, doubles_or_worse: 0,
        stroke_points: strokePts, finish_points: finishPts,
        total_points: strokePts + finishPts,
        status: isBottom27 ? 'bottom27' : 'active',
        updated_at: new Date().toISOString()
      };
    });
    console.log(`LIV: ${players.length} players | ${tournamentName}`);
    return { players };
  } catch(e) { console.log('LIV: No active event'); return null; }
}

async function writeScores(players) {
  if (!players?.length) return;
  const { error } = await supabase.from('live_scores')
    .upsert(players, { onConflict: 'player_name,tournament_name,round' });
  if (error) console.error('Supabase error:', error.message);
  else console.log(`✅ Wrote ${players.length} players`);
}

async function checkSchema() {
  const { error } = await supabase.from('live_scores').select('player_name').limit(1);
  if (error?.code === '42P01') { console.error('❌ Table missing'); process.exit(1); }
  console.log('✅ live_scores table ready');
}

async function scrape() {
  console.log(`\n⏰ ${new Date().toISOString()}`);
  const pga = await fetchPGA();
  if (pga?.players?.length) await writeScores(pga.players);
  else console.log('PGA: No data');
  const liv = await fetchLIV();
  if (liv?.players?.length) await writeScores(liv.players);
}

// ═══════════ STEP 4: GLOBAL RANKINGS ═══════════
// For each saved squad, sum each of the 5 active players' total_points
// across all live_scores rows (their season contribution), applying
// captain x2 / vice-captain x1.5, then write season_total + week_total
// to the rankings table. Finally rank all users by season_total.
//
// Note: v1 — no auto-substitution. All 5 active players always count,
// reserves never do. Auto-sub can be layered in once this base pipeline
// is verified working.

async function calculateRankings() {
  console.log('\n📊 Calculating rankings...');

  // 1. Fetch all squads
  const { data: squads, error: squadsErr } = await supabase.from('squads').select('*');
  if (squadsErr) { console.error('rankings: squads fetch error:', squadsErr.message); return; }
  if (!squads?.length) { console.log('rankings: no squads saved yet'); return; }

  // 2. Fetch all players (for id -> name mapping)
  const { data: players, error: playersErr } = await supabase.from('players').select('id,name');
  if (playersErr) { console.error('rankings: players fetch error:', playersErr.message); return; }
  const playerNameById = {};
  (players || []).forEach(p => { playerNameById[String(p.id)] = p.name; });

  // 3. Fetch all live_scores
  const { data: scores, error: scoresErr } = await supabase.from('live_scores').select('*');
  if (scoresErr) { console.error('rankings: live_scores fetch error:', scoresErr.message); return; }

  // Find the most recent round per tournament (used for "week_total")
  let latestRound = 0;
  let latestTournament = null;
  (scores || []).forEach(s => {
    if (s.round > latestRound) { latestRound = s.round; latestTournament = s.tournament_name; }
  });

  // Group live_scores by player_name for fast lookup
  const scoresByPlayer = {};
  (scores || []).forEach(s => {
    if (!scoresByPlayer[s.player_name]) scoresByPlayer[s.player_name] = [];
    scoresByPlayer[s.player_name].push(s);
  });

  const results = [];

  for (const squad of squads) {
    const ids = squad.player_ids || [];
    const activeIds = ids.slice(0, 5); // first 5 are active, last 2 are reserves
    const capId = String(squad.captain_id || '');
    const vcId = String(squad.vice_captain_id || '');

    let seasonTotal = 0;
    let weekTotal = 0;

    for (const pid of activeIds) {
      const name = playerNameById[String(pid)];
      if (!name) continue;
      const rows = scoresByPlayer[name] || [];

      // Sum this player's points across every gameweek they've played
      let playerSeasonPts = 0;
      let playerWeekPts = 0;
      rows.forEach(r => {
        playerSeasonPts += (r.total_points || 0);
        if (r.round === latestRound && r.tournament_name === latestTournament) {
          playerWeekPts += (r.total_points || 0);
        }
      });

      // Apply captain / vice-captain multiplier to this player's contribution
      let mult = 1;
      if (String(pid) === capId) mult = 2;
      else if (String(pid) === vcId) mult = 1.5;

      seasonTotal += Math.round(playerSeasonPts * mult);
      weekTotal += Math.round(playerWeekPts * mult);
    }

    results.push({
      user_id: squad.user_id,
      team_name: squad.team_name || 'My Team',
      season_total: seasonTotal,
      week_total: weekTotal
    });
  }

  // 4. Rank by season_total descending
  results.sort((a, b) => b.season_total - a.season_total);
  results.forEach((r, i) => { r.rank = i + 1; r.updated_at = new Date().toISOString(); });

  // 5. Write to rankings table
  const { error: writeErr } = await supabase.from('rankings')
    .upsert(results, { onConflict: 'user_id' });
  if (writeErr) console.error('rankings: write error:', writeErr.message);
  else console.log(`✅ Rankings updated for ${results.length} squad(s)`);
}

async function main() {
  console.log('🏌️  The Field — Scraper v5');
  await checkSchema();
  await scrape();
  await calculateRankings();
  setInterval(async () => {
    await scrape();
    await calculateRankings();
  }, INTERVAL_MS);
  console.log(`\n⏱  Every 5 minutes...`);
}

main().catch(console.error);
