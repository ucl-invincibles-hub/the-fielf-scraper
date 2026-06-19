// THE FIELD — Live Scoring Scraper v5
// Updated scoring table (June 2026): all values even so VC x1.5 never produces a fraction
// Major win +42 (1.5x of +28) · Tournament win +28 · 2nd +20 · 3rd +14 · Top5 +10 · Top10 +6 · Top20 +2 · Missed cut/bottom27 -10
// Hole in one +20 · Eagle +8 · Birdie +4 · Par 0 · Bogey -2 · Double -4 · Triple -6 · Blob -8
// Signature event multiplier removed — only Major events carry a multiplier (1.5x)

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://peekrbzmaocuportertr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWtyYnptYW9jdXBvcnRlcnRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE5MjM2OCwiZXhwIjoyMDk2NzY4MzY4fQ.4XbODFXnJBOphYw6p1YvskqHwclH_s22G_VbykXQV2U';
const INTERVAL_MS = 2 * 60 * 1000;

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
  const score = parseInt(totalScore) || 0;
  if (score === 0) return 0;
  if (score < 0) {
    // Assume all shots under par are birdies: -1 = +4pts
    return Math.abs(score) * 4;
  } else {
    // Assume all shots over par are bogeys: +1 = -2pts
    return score * -2;
  }
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

    // Write tournament info including start time for deadline calculation
    try {
      const startDate = event.date || competition.date || null;
      const venue = event.venues?.[0]?.fullName || competition.venue?.fullName || null;
      await supabase.from('tournament_info').upsert({
        id: 1,
        tournament_name: tournamentName,
        course: venue,
        first_tee_time: startDate,
        deadline: startDate ? new Date(new Date(startDate).getTime() - 60*60*1000).toISOString() : null,
        round: parseInt(competition.status?.period || 1),
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
    } catch(e) { console.log('tournament_info write error:', e.message); }

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

      const thru = c.status?.thru || c.status?.period || 0;
      // Debug first player to see raw structure
      if (players.length === 0) console.log('ESPN competitor status sample:', JSON.stringify(c.status));
      const totalScore = parseInt(c.score) || 0; // cumulative vs par

      // Current round score from linescores
      const linescores = c.linescores || [];
      const roundScore = linescores.length > 0 ?
        parseInt(linescores[linescores.length - 1]?.value || 0) || 0 : 0;

      // Rounds played — treat current in-progress round as counting if player has a score
      const roundsPlayed = isComplete ? round : (totalScore !== 0 || thru > 0 ? round : Math.max(0, round - 1));

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
  
  // Check if tournament has changed — if so clear old data first
  const newTournament = players[0]?.tournament_name;
  if (newTournament) {
    const { data: existing } = await supabase
      .from('live_scores')
      .select('tournament_name')
      .limit(1);
    const oldTournament = existing?.[0]?.tournament_name;
    if (oldTournament && oldTournament !== newTournament) {
      console.log(`🔄 New tournament detected: ${newTournament} (was ${oldTournament}) — clearing old data`);
      await supabase.from('live_scores').delete().eq('tournament_name', oldTournament);
      await bankTransfers(oldTournament);
    }
  }

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

  // Find the most recently updated tournament (used for "week_total")
  let latestTournament = null;
  let latestUpdated = null;
  let latestRound = 0;
  (scores || []).forEach(s => {
    const updated = new Date(s.updated_at || 0);
    if (!latestUpdated || updated > latestUpdated) {
      latestUpdated = updated;
      latestTournament = s.tournament_name;
    }
  });
  // Get highest round for that tournament
  (scores || []).forEach(s => {
    if (s.tournament_name === latestTournament && s.round > latestRound) {
      latestRound = s.round;
    }
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

async function fetchNews() {
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/news?limit=20', { timeout: 15000 });
    if (!res.ok) return;
    const data = await res.json();
    const articles = (data.articles || []).map(a => ({
      headline: a.headline || a.title || '',
      summary: a.description || '',
      url: a.links?.web?.href || 'https://www.espn.com/golf/',
      author: a.byline || 'ESPN Golf',
      published_at: a.published || a.lastModified || new Date().toISOString(),
      tour: 'PGA'
    })).filter(a => a.headline);

    if (!articles.length) return;

    const { error } = await supabase.from('golf_news')
      .upsert(articles, { onConflict: 'url' });
    if (error) console.error('News write error:', error.message);
    else console.log(`✅ News: ${articles.length} articles`);
  } catch(e) {
    console.log('News fetch error:', e.message);
  }
}

const RESEND_KEY = process.env.RESEND_KEY || 're_BHDrpAUM_MgkUxYGobae6yuy3Fu5Nskno';

async function sendWelcomeEmail(email, teamName) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'The Field Fantasy Golf <office@mail.thefieldfantasygolf.com>',
        to: email,
        subject: 'Welcome to The Field ⛳',
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f0e8;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:40px 20px">
<div style="background:#0f1a0f;border-radius:12px;overflow:hidden">
<div style="padding:40px 40px 32px;text-align:center;border-bottom:1px solid rgba(200,168,48,0.2)">
  <div style="font-family:Georgia,serif;font-size:32px;font-weight:700;color:#f0f0f0;letter-spacing:2px;margin-bottom:4px">The Field</div>
  <div style="font-size:11px;font-weight:700;letter-spacing:3px;color:#c8a830;text-transform:uppercase;margin-bottom:2px">Fantasy Golf</div>
  <div style="font-style:italic;font-family:Georgia,serif;font-size:13px;color:#c8a830">The Gentlemen's Game</div>
</div>
<div style="padding:40px">
  <p style="font-family:Georgia,serif;font-size:22px;color:#f0f0f0;margin:0 0 6px;font-weight:700">You're in. Welcome to The Field.</p>
  <p style="font-size:13px;color:#4a6b4a;margin:0 0 24px;line-height:1.6;font-style:italic">Fantasy golf the way it was always meant to be played.</p>
  <p style="font-size:14px;color:#c8d8c8;line-height:1.9;margin:0 0 10px">Most fantasy golf is a leaderboard check on Sunday afternoon. <strong style="color:#f0f0f0">The Field is different.</strong> Your squad scores in real time — every birdie earns, every eagle flies, and every triple bogey on the 18th on a Saturday evening will have your group chat absolutely on fire.</p>
  <p style="font-size:14px;color:#c8d8c8;line-height:1.9;margin:0 0 20px">Your Captain earns double points. Which also means when he makes a blob on the par 5 — you'll feel it. That's the beauty of it.</p>
  <div style="background:rgba(200,168,48,0.06);border:1px solid rgba(200,168,48,0.2);border-radius:8px;padding:20px;margin-bottom:28px;text-align:center">
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8d8c8;font-style:italic;line-height:1.8;margin:0 0 12px">"Golf has always been played in 4-balls. Saturday morning. Four players. A small wager. Eighteen holes. Settle up at the 19th over a pint.</p>
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8d8c8;font-style:italic;line-height:1.8;margin:0 0 12px">The Field is that — but all season long, across the PGA Tour and LIV Golf, with a prize at the end worth a lot more than a round of drinks."</p>
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8a830;font-weight:700;margin:0">Pick your 4-ball. Name your captain. Let them play.</p>
  </div>
  <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(200,168,48,0.2);border-radius:8px;padding:24px;margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#c8a830;text-transform:uppercase;margin-bottom:16px">How it works</div>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.8;margin:0 0 10px"><strong style="color:#f0f0f0">1. Pick 7 golfers</strong> from the PGA Tour and LIV Golf within a £50m budget. Mix the world number one with a LIV dark horse. The bold call wins leagues.</p>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.8;margin:0 0 10px"><strong style="color:#f0f0f0">2. Name your Captain (2×) and Vice Captain (1.5×).</strong> Back the right man and the points stack up fast. Back the wrong one and the group chat will remind you. Repeatedly.</p>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.8;margin:0 0 10px"><strong style="color:#f0f0f0">3. Use your chips wisely.</strong> Triple Captain, Vice, Mulligan, Full Bag — one shot at each, all season. Use them well and you look like a genius. Use them badly and, well, see point 2.</p>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.8;margin:0"><strong style="color:#f0f0f0">4. Compete all season</strong> in private leagues, a global leaderboard, and a weekly sweepstake where the pot is entirely in your hands.</p>
  </div>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:20px;margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#4ade80;text-transform:uppercase;margin-bottom:12px">The Weekly Sweepstake</div>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0 0 12px">Each gameweek, enter The Field sweepstake. Pick your stake — from <strong style="color:#f0f0f0">The Shilling (£1)</strong> to <strong style="color:#f0f0f0">The Tenner (£10)</strong>. Every penny goes into the pot. The pot is split between the top finishers at the end of the week. No house edge. No nonsense.</p>
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8a830;font-style:italic;margin:0;text-align:center">"Create Your Own Luck. The Pot Is In Your Hands."</p>
  </div>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:20px;margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#4ade80;text-transform:uppercase;margin-bottom:12px">Paid Pot Leagues</div>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0 0 12px">Create a private league with your mates and set an entry fee. £5, £10, £20, £50 — your call. Winner takes the pot at the end of the season, paid automatically.</p>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0 0 14px">And the days of chasing your mates round the houses for your fantasy winnings? Behind you. Stripe handles it. The gentleman always gets paid.</p>
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8a830;font-style:italic;margin:0;text-align:center">"A gentleman always pays his debts — and a gentleman always collects what he is owed."</p>
  </div>
  <table style="width:100%;border:1px solid rgba(200,168,48,0.25);border-radius:8px;border-collapse:separate;border-spacing:0;margin-bottom:28px;overflow:hidden">
    <tr><td colspan="3" style="padding:14px 20px;border-bottom:1px solid rgba(200,168,48,0.15);text-align:center;font-size:11px;font-weight:700;letter-spacing:2px;color:#c8a830;text-transform:uppercase">Season Prizes</td></tr>
    <tr>
      <td style="padding:18px 14px;text-align:center;border-right:1px solid rgba(200,168,48,0.1);width:33%"><div style="font-size:20px;margin-bottom:6px">🥇</div><div style="font-size:10px;font-weight:700;color:#c8a830;margin-bottom:6px">1ST PLACE</div><div style="font-family:Georgia,serif;font-size:12px;color:#f0f0f0;line-height:1.5">Sunday Hospitality at The Open Championship</div></td>
      <td style="padding:18px 14px;text-align:center;border-right:1px solid rgba(200,168,48,0.1);width:33%"><div style="font-size:20px;margin-bottom:6px">🥈</div><div style="font-size:10px;font-weight:700;color:#9ca3af;margin-bottom:6px">2ND PLACE</div><div style="font-family:Georgia,serif;font-size:12px;color:#f0f0f0;line-height:1.5">Portugal Golf Holiday</div></td>
      <td style="padding:18px 14px;text-align:center;width:33%"><div style="font-size:20px;margin-bottom:6px">🥉</div><div style="font-size:10px;font-weight:700;color:#cd7f32;margin-bottom:6px">3RD PLACE</div><div style="font-family:Georgia,serif;font-size:12px;color:#f0f0f0;line-height:1.5">Premium Golf Equipment</div></td>
    </tr>
  </table>
  <div style="text-align:center;margin-bottom:32px">
    <a href="https://thefieldfantasygolf.com" style="display:inline-block;background:#1a6b35;color:#ffffff;font-weight:700;font-size:14px;padding:16px 40px;border-radius:8px;text-decoration:none;letter-spacing:0.5px">Build Your Squad Now</a>
    <div style="font-size:11px;color:#2a4a2a;margin-top:10px">Free to play. Transfers open now.</div>
  </div>
  <p style="font-size:13px;color:#4a6b4a;line-height:1.7;margin:0 0 16px">You're part of the beta — which means you're shaping what The Field becomes. If something isn't right, reply to this email. We actually read them.</p>
  <p style="font-family:Georgia,serif;font-size:14px;color:#c8a830;margin:0 0 14px;font-style:italic">The Gentlemen's Game awaits.</p>
  <p style="font-size:13px;color:#f0f0f0;margin:0;line-height:1.8">Brandon<br>Founder, The Field Fantasy Golf<br><a href="mailto:office@thefieldfantasygolf.com" style="color:#f0f0f0;text-decoration:none">office@thefieldfantasygolf.com</a><br><a href="https://thefieldfantasygolf.com" style="color:#f0f0f0;text-decoration:none">thefieldfantasygolf.com</a></p>
</div>
<div style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.06);text-align:center">
  <div style="font-size:10px;color:#1a3a1a">You're receiving this because you signed up to The Field Fantasy Golf.</div>
</div>
</div></div></body></html>`
      })
    });
    const data = await res.json();
    if (data.id) console.log(`✅ Welcome email sent to ${email}`);
    else console.log(`⚠️ Email send failed:`, data);
  } catch(e) {
    console.log('Welcome email error:', e.message);
  }
}

async function checkNewSignups() {
  try {
    // Get all users from auth
    const { data: users, error } = await supabase.auth.admin.listUsers();
    if (error || !users) return;

    // Get list of already-welcomed users
    const { data: welcomed } = await supabase
      .from('welcomed_users')
      .select('user_id');
    const welcomedIds = new Set((welcomed || []).map(w => w.user_id));

    // Send welcome to any new users
    for (const user of users.users) {
      if (!welcomedIds.has(user.id) && user.email) {
        await sendWelcomeEmail(user.email);
        // Mark as welcomed
        await supabase.from('welcomed_users').insert({ user_id: user.id, email: user.email, sent_at: new Date().toISOString() });
        // Small delay between emails
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch(e) {
    console.log('checkNewSignups error:', e.message);
  }
}


// Bank unused transfers at end of gameweek
// Called when scraper detects tournament has changed
async function bankTransfers(completedGameweek) {
  try {
    console.log(`🏦 Banking transfers for: ${completedGameweek}`);
    const { data: allowances } = await supabase
      .from('transfer_allowance')
      .select('*')
      .eq('gameweek', completedGameweek);
    if (!allowances || !allowances.length) { console.log('No transfer allowances to bank'); return; }
    for (const a of allowances) {
      const unused = Math.max(0, a.free_transfers_available - a.transfers_used);
      const nextFree = Math.min(2, 1 + (unused > 0 ? 1 : 0));
      console.log(`👤 User ${a.user_id}: ${nextFree} free transfers next week`);
      await supabase.from('transfer_allowance').update({ banked_for_next: nextFree })
        .eq('user_id', a.user_id).eq('gameweek', completedGameweek);
    }
    console.log(`✅ Transfer banking complete for ${completedGameweek}`);
  } catch(e) { console.log('bankTransfers error:', e.message); }
}

async function getBankedTransfers(userId) {
  try {
    const { data } = await supabase.from('transfer_allowance')
      .select('banked_for_next').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(1);
    return (data && data.length && data[0].banked_for_next) ? data[0].banked_for_next : 1;
  } catch(e) { return 1; }
}

async function main() {
  console.log('🏌️  The Field — Scraper v5');
  await checkSchema();
  await scrape();
  await calculateRankings();
  await fetchNews();
  await checkNewSignups();
  setInterval(async () => {
    await scrape();
    await calculateRankings();
    await fetchNews();
    await checkNewSignups();
  }, INTERVAL_MS);
  console.log(`\n⏱  Every 5 minutes...`);
}

main().catch(console.error);
