// THE FIELD — Live Scoring Scraper v6 (PGA-only, LIV removed Sept 2026)
// Updated scoring table (June 2026): all values even so VC x1.5 never produces a fraction
// Major win +42 (1.5x of +28) · Tournament win +28 · 2nd +20 · 3rd +14 · Top5 +10 · Top10 +6 · Top20 +2 · Missed cut -10
// Hole in one +20 · Eagle +8 · Birdie +4 · Par 0 · Bogey -2 · Double -4 · Triple -6 · Blob -8
// Signature event multiplier removed — only Major events carry a multiplier (1.5x)

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

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

// Estimate stroke points from cumulative score vs par (FALLBACK ONLY —
// used when ESPN doesn't give us real per-hole data for this event).
// We know total_score (e.g. -10 means 10 under) but not individual holes.
function estimateStrokePoints(totalScore) {
  const score = parseInt(totalScore) || 0;
  if (score === 0) return 0;
  if (score < 0) {
    // Under par — blend of birdies (+4) and occasional eagles (+8)
    const eagles = Math.round(Math.abs(score) * 0.1);
    const birdies = Math.abs(score) - eagles;
    return eagles * 8 + birdies * 4;
  } else {
    // Over par — blend of bogeys (-2) and doubles (-4)
    const doubles = Math.round(score * 0.25);
    const bogeys = score - doubles;
    return bogeys * -2 + doubles * -4;
  }
}

// ════════════════════════════════════════════════
// REAL HOLE-BY-HOLE SCORING
// ESPN's linescores[period].linescores[] array holds each hole's
// score RELATIVE TO PAR for that hole (e.g. -1 = birdie, +1 = bogey)
// whenever ESPN actually provides granular data for an event — this
// was already being fetched and even logged ("REAL hole-by-hole" vs
// "ESTIMATED") but never actually used; scoring fell back to a
// statistical guess every time regardless. This function replaces
// that guess with a genuine count whenever real data is present.
//
// Known limit: a hole-in-one and a normal eagle on a longer hole
// both show up as the same relative value (there's no hole-par field
// in this payload to tell them apart), so aces are folded into the
// eagle tier rather than falsely claiming to detect them separately.
// ════════════════════════════════════════════════
function calculateRealHolePoints(linescores) {
  let points = 0, birdies = 0, eagles = 0, bogeys = 0, doublesOrWorse = 0;
  let holesCounted = 0;

  (linescores || []).forEach(roundLine => {
    (roundLine.linescores || []).forEach(hole => {
      const val = parseInt(hole?.value);
      if (isNaN(val) || Math.abs(val) > 3) return; // not real relative-to-par data
      holesCounted++;
      if (val <= -2) { points += 8; eagles++; }
      else if (val === -1) { points += 4; birdies++; }
      else if (val === 0) { /* par: 0 points */ }
      else if (val === 1) { points -= 2; bogeys++; }
      else if (val === 2) { points -= 4; doublesOrWorse++; }
      else if (val === 3) { points -= 6; doublesOrWorse++; }
      else { points -= 8; doublesOrWorse++; } // val >= 4: a "blob"
    });
  });

  return { points, birdies, eagles, bogeys, doublesOrWorse, hasRealData: holesCounted > 0 };
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

    // Skip team match-play exhibitions entirely (Presidents Cup, Ryder
    // Cup, Solheim Cup). These aren't stroke-play events — there's no
    // per-player score-to-par or finishing position the way our whole
    // fantasy scoring system expects, and ESPN structures team pairings
    // completely differently, which was producing garbage ("Unknown"
    // players, 0 points, duplicate-key upsert errors) whenever one of
    // these landed on tour in the same window as a real PGA event.
    const TEAM_EVENTS = ['presidents cup', 'ryder cup', 'solheim cup'];
    const nameLower = tournamentName.toLowerCase();
    if (TEAM_EVENTS.some(t => nameLower.includes(t))) {
      console.log(`⏭️  Skipping team event: ${tournamentName} (not a fantasy-scorable stroke-play event)`);
      return null;
    }

    // Belt-and-braces: rather than maintaining a hardcoded list of all
    // ~36 real PGA Tour events (which drifts every year as tournaments
    // get renamed, moved, or added), require a genuine individual
    // stroke-play field size. Every real PGA Tour event has 65+
    // players; a 12-a-side team competition has 24 total. This catches
    // team events even if a future one isn't in the name list above,
    // and catches skills challenges / exhibitions / anything else with
    // an unusually small field, without needing to keep a name list
    // in sync with the schedule every season.
    const fieldSize = competition.competitors?.length || 0;
    if (fieldSize > 0 && fieldSize < 40) {
      console.log(`⏭️  Skipping ${tournamentName}: field size ${fieldSize} is too small for an individual stroke-play event`);
      return null;
    }

    // Write tournament info with real tee-time based transfer window
    try {
      const startDate = event.date || competition.date || null;  // Thursday first tee time (UTC)
      const endDate = event.endDate || null;                     // Sunday finish estimate (UTC)
      const venue = event.venues?.[0]?.fullName || competition.venue?.fullName || null;

      // Transfer window logic:
      //   OPEN:   1 hour after tournament ends (endDate + 1hr)  → managers can react to results
      //   LOCKED: 1 hour before first tee time (startDate - 1hr) → locks before play begins
      // If endDate missing, fall back: open = startDate - 5 days (previous Sunday 8pm-ish)
      let transferOpenAt = null;
      let transferLockAt = null;
      if (startDate) {
        const teeTime = new Date(startDate);
        transferLockAt = new Date(teeTime.getTime() - 60 * 60 * 1000).toISOString(); // -1hr from Thursday
        if (endDate) {
          const finish = new Date(endDate);
          transferOpenAt = new Date(finish.getTime() + 60 * 60 * 1000).toISOString(); // +1hr after Sunday
        } else {
          // No endDate — estimate: open 5 days before Thursday (previous Sunday evening)
          transferOpenAt = new Date(teeTime.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
        }
      }

      await supabase.from('tournament_info').upsert({
        id: 1,
        tournament_name: tournamentName,
        course: venue,
        first_tee_time: startDate,
        deadline: transferLockAt || (startDate ? new Date(new Date(startDate).getTime() - 60*60*1000).toISOString() : null),
        transfer_open_at: transferOpenAt,
        transfer_lock_at: transferLockAt,
        round: parseInt(competition.status?.period || 1),
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

      console.log(`🗓️  Transfer window: opens ${transferOpenAt ? new Date(transferOpenAt).toUTCString() : 'unknown'} | locks ${transferLockAt ? new Date(transferLockAt).toUTCString() : 'unknown'}`);
    } catch(e) { console.log('tournament_info write error:', e.message); }

    const round = parseInt(competition.status?.period || 1);
    const statusDesc = competition.status?.type?.description || '';
    const isComplete = competition.status?.type?.completed || false;

    console.log(`\n📍 ${tournamentName} (${tournamentType}) R${round} | ${statusDesc}`);

    const players = [];
    const round2Checkpoints = [];

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

      // ESPN's golf API does not reliably expose a flat status.thru field.
      // The real hole-progress data lives nested inside linescores: each
      // competitor.linescores[] entry is one ROUND (period 1-4), and each of
      // those has its own nested .linescores[] array of individual holes
      // played so far. The length of that nested array for the player's
      // current round IS the accurate "holes completed" count.
      const linescores = c.linescores || [];
      const currentRoundLine = linescores.find(ls => ls.period === round);
      const thru = currentRoundLine?.linescores?.length || 0;
      // Debug first player to see raw structure
      if (players.length === 0) {
        const sampleHoles = linescores[0]?.linescores || [];
        const sampleVal = parseInt(sampleHoles[0]?.value || '99');
        const mode = Math.abs(sampleVal) <= 3 ? '✅ REAL hole-by-hole' : '⚠️ ESTIMATED (raw strokes)';
        console.log('ESPN scoring mode:', mode, '| first hole value:', sampleHoles[0]?.value, '| thru:', thru);
      }
      const totalScore = parseInt(c.score) || 0; // cumulative vs par

      // Current round score (raw strokes) from the matched round's linescore entry
      const roundScore = currentRoundLine ?
        parseInt(currentRoundLine?.value || 0) || 0 : 0;

      // Rounds played — treat current in-progress round as counting if player has a score
      const roundsPlayed = isComplete ? round : (totalScore !== 0 || thru > 0 ? round : Math.max(0, round - 1));

      // Stroke points: use REAL hole-by-hole counting whenever ESPN
      // actually gives us per-hole data for this event, falling back
      // to the statistical estimate only when it doesn't.
      const holeData = calculateRealHolePoints(linescores);
      const strokePts = holeData.hasRealData ? holeData.points : estimateStrokePoints(totalScore);

      // Finish points only when the TOURNAMENT is complete, not just a round.
      // ESPN's competition.status.type.completed flag has been observed to
      // flicker true briefly between rounds (e.g. right as Saturday's round
      // wraps before Sunday's tee times begin), which would otherwise let a
      // 2-minute scrape lock in a player's mid-tournament position as if it
      // were their final result. Standard stroke-play majors/PGA events run
      // 4 rounds, so require round >= 4 as well before honoring "complete".
      const finishPts = isCut ? -10 : (isComplete && round >= 4 ? calcFinishPoints(posNum, tournamentType) : 0);
      const totalPts = strokePts + finishPts;

      // Snapshot each player's cumulative points while Round 2 is live,
      // refreshed every scrape so it converges to the accurate final
      // R1+R2 total by the time Round 3 begins. This is the only way
      // to later split points correctly for a mid-tournament manual
      // substitution — live_scores only keeps one row per player per
      // tournament (continuously overwritten), so without this
      // checkpoint there'd be no way to know what a player had scored
      // "so far" once the tournament moves on.
      if (round === 2) {
        round2Checkpoints.push({ player_name: name, tournament_name: tournamentName, points_at_r2: totalPts });
      }

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
        birdies: holeData.hasRealData ? holeData.birdies : 0,
        eagles: holeData.hasRealData ? holeData.eagles : 0,
        bogeys: holeData.hasRealData ? holeData.bogeys : 0,
        doubles_or_worse: holeData.hasRealData ? holeData.doublesOrWorse : 0,
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
        const fp = (isComplete && round >= 4) ? calcFinishPoints(pn, tournamentType) : 0;
        players[i].finish_points = fp;
        players[i].total_points = players[i].stroke_points + fp;
      }
    }

    const sample = players.slice(0, 3).map(p => `${p.position}:${p.player_name.split(' ').pop()}(${p.total_score},${p.total_points}pts)`).join(' ');
    console.log(`PGA: ${players.length} players | Top 3: ${sample}`);
    return { players, round2Checkpoints };

  } catch(e) {
    console.error('PGA fetch error:', e.message);
    return null;
  }
}

// ════════════════════════════════════════════════
// SEASON HISTORY ARCHIVE
// Called right before a tournament's live_scores get
// wiped for the new gameweek. Snapshots each user's
// just-finished week_total (last computed by
// calculateRankings while that tournament was still
// live) into gameweek_history, so season_total can
// keep accumulating across the whole season instead
// of resetting to only the current week every time.
// Requires a gameweek_history table:
//   id uuid default gen_random_uuid() primary key,
//   user_id uuid not null,
//   tournament_name text not null,
//   points int not null default 0,
//   created_at timestamptz default now(),
//   unique(user_id, tournament_name)
// ════════════════════════════════════════════════
// ════════════════════════════════════════════════
// SWEEPSTAKE PAYOUTS — the actual money-out half of Stripe Connect.
// Called at the tournament transition point, same as
// archiveGameweekResults, right while rankings.week_total still
// reflects the tournament that's ending. Handles both the global
// sweepstake (grouped by stake tier) and every private sweepstake
// tied to this tournament (grouped by sweepstake_id). Also retries
// any past winner who's since finished Connect onboarding.
// ════════════════════════════════════════════════
async function payoutSweepstakeWinners(completedTournamentName) {
  try {
    const { data: rankings } = await supabase.from('rankings').select('user_id,week_total');
    const weekTotalByUser = {};
    (rankings || []).forEach(r => { weekTotalByUser[r.user_id] = r.week_total || 0; });

    const { data: payoutRows } = await supabase.from('payout_details')
      .select('user_id,stripe_connect_account_id,connect_onboarded');
    const connectByUser = {};
    (payoutRows || []).forEach(p => { connectByUser[p.user_id] = p; });

    async function sendPayout(userId, amountPence) {
      const pd = connectByUser[userId];
      if (!pd?.stripe_connect_account_id || !pd?.connect_onboarded) {
        return { status: 'pending_onboarding', transferId: null };
      }
      try {
        const transfer = await stripe.transfers.create({
          amount: amountPence,
          currency: 'gbp',
          destination: pd.stripe_connect_account_id
        });
        return { status: 'paid', transferId: transfer.id };
      } catch(e) {
        console.error(`Payout transfer failed for ${userId}:`, e.message);
        return { status: 'failed', transferId: null };
      }
    }

    // ---- Retry anyone still pending from a PAST tournament who has
    // since completed onboarding, before processing this week's new
    // winners ----
    const { data: pendingGlobal } = await supabase.from('sweepstake_entries')
      .select('id,user_id,payout_amount_pence').eq('payout_status', 'pending_onboarding');
    for (const entry of (pendingGlobal || [])) {
      const result = await sendPayout(entry.user_id, entry.payout_amount_pence);
      if (result.status !== 'pending_onboarding') {
        await supabase.from('sweepstake_entries').update({
          payout_status: result.status, stripe_transfer_id: result.transferId
        }).eq('id', entry.id);
        console.log(`💸 Retried pending payout for ${entry.user_id}: ${result.status}`);
      }
    }
    const { data: pendingPrivate } = await supabase.from('private_sweepstake_entries')
      .select('id,user_id,payout_amount_pence').eq('payout_status', 'pending_onboarding');
    for (const entry of (pendingPrivate || [])) {
      const result = await sendPayout(entry.user_id, entry.payout_amount_pence);
      if (result.status !== 'pending_onboarding') {
        await supabase.from('private_sweepstake_entries').update({
          payout_status: result.status, stripe_transfer_id: result.transferId
        }).eq('id', entry.id);
        console.log(`💸 Retried pending private payout for ${entry.user_id}: ${result.status}`);
      }
    }

    // ---- GLOBAL SWEEPSTAKE: grouped by stake tier ----
    const { data: entries } = await supabase.from('sweepstake_entries')
      .select('id,user_id,stake_pence').eq('tournament_name', completedTournamentName)
      .eq('payment_status', 'paid').eq('payout_status', 'not_applicable');

    const byTier = {};
    (entries || []).forEach(e => {
      if (!byTier[e.stake_pence]) byTier[e.stake_pence] = [];
      byTier[e.stake_pence].push(e);
    });

    for (const tier of Object.keys(byTier)) {
      const tierEntries = byTier[tier];
      const pot = tierEntries.reduce((sum, e) => sum + e.stake_pence, 0);
      const maxScore = Math.max(...tierEntries.map(e => weekTotalByUser[e.user_id] || 0));
      const winners = tierEntries.filter(e => (weekTotalByUser[e.user_id] || 0) === maxScore);
      const payoutTotal = Math.floor(pot * 0.9);
      const perWinner = Math.floor(payoutTotal / winners.length);

      for (const entry of tierEntries) {
        const isWinner = winners.includes(entry);
        if (!isWinner) {
          await supabase.from('sweepstake_entries').update({ payout_status: 'no_win' }).eq('id', entry.id);
          continue;
        }
        const result = await sendPayout(entry.user_id, perWinner);
        await supabase.from('sweepstake_entries').update({
          payout_status: result.status, payout_amount_pence: perWinner, stripe_transfer_id: result.transferId
        }).eq('id', entry.id);
        console.log(`🏆 Global sweepstake (£${tier/100} tier) winner ${entry.user_id}: £${(perWinner/100).toFixed(2)} — ${result.status}`);
      }
    }

    // ---- PRIVATE SWEEPSTAKES: grouped by sweepstake_id ----
    const { data: privateSweeps } = await supabase.from('private_sweepstakes')
      .select('id,total_pot_pence').eq('tournament_name', completedTournamentName).eq('status', 'open');

    for (const sweep of (privateSweeps || [])) {
      const { data: pEntries } = await supabase.from('private_sweepstake_entries')
        .select('id,user_id').eq('sweepstake_id', sweep.id).eq('payment_status', 'paid');
      if (!pEntries?.length) continue;

      const maxScore = Math.max(...pEntries.map(e => weekTotalByUser[e.user_id] || 0));
      const winners = pEntries.filter(e => (weekTotalByUser[e.user_id] || 0) === maxScore);
      const payoutTotal = Math.floor((sweep.total_pot_pence || 0) * 0.9);
      const perWinner = Math.floor(payoutTotal / winners.length);

      for (const entry of pEntries) {
        const isWinner = winners.includes(entry);
        if (!isWinner) {
          await supabase.from('private_sweepstake_entries').update({ payout_status: 'no_win' }).eq('id', entry.id);
          continue;
        }
        const result = await sendPayout(entry.user_id, perWinner);
        await supabase.from('private_sweepstake_entries').update({
          payout_status: result.status, payout_amount_pence: perWinner, stripe_transfer_id: result.transferId
        }).eq('id', entry.id);
        console.log(`🏆 Private sweepstake ${sweep.id} winner ${entry.user_id}: £${(perWinner/100).toFixed(2)} — ${result.status}`);
      }
      await supabase.from('private_sweepstakes').update({ status: 'completed' }).eq('id', sweep.id);
    }
  } catch(e) {
    console.error('payoutSweepstakeWinners error:', e.message);
  }
}

async function archiveGameweekResults(completedTournamentName) {
  try {
    const { data: rankings, error } = await supabase
      .from('rankings')
      .select('user_id, week_total');
    if (error) { console.error('archiveGameweekResults: rankings fetch error:', error.message); return; }
    if (!rankings?.length) { console.log('archiveGameweekResults: no rankings to archive'); return; }

    const rows = rankings.map(r => ({
      user_id: r.user_id,
      tournament_name: completedTournamentName,
      points: r.week_total || 0
    }));

    const { error: insErr } = await supabase.from('gameweek_history')
      .upsert(rows, { onConflict: 'user_id,tournament_name' });
    if (insErr) console.error('archiveGameweekResults: insert error:', insErr.message);
    else console.log(`🗄️  Archived ${rows.length} result(s) for ${completedTournamentName}`);
  } catch(e) {
    console.log('archiveGameweekResults error:', e.message);
  }
}

async function writeScores(players) {
  if (!players?.length) return;
  
  const newTournament = players[0]?.tournament_name;
  const tour = players[0]?.tour; // 'PGA'
  
  if (newTournament && tour) {
    const { data: existing } = await supabase
      .from('live_scores')
      .select('tournament_name')
      .eq('tour', tour)
      .limit(1);
    const oldTournament = existing?.[0]?.tournament_name;
    if (oldTournament && oldTournament !== newTournament) {
      console.log(`🔄 New ${tour} tournament: ${newTournament} (was ${oldTournament}) — clearing old ${tour} data`);
      await archiveGameweekResults(oldTournament);
      await payoutSweepstakeWinners(oldTournament);
      // Pricing and transfer-banking both need the completed tournament's
      // final results — they MUST run before the delete below, not after.
      // (This was previously ordered delete-then-price, which meant
      // updatePrices always queried an already-empty table and silently
      // did nothing — prices never actually moved from real results.)
      const MAJORS = ['Masters Tournament', 'PGA Championship', 'U.S. Open', 'The Open'];
      const isMajor = MAJORS.some(m => oldTournament.includes(m));
      await updatePrices(oldTournament, isMajor);
      await bankTransfers(oldTournament);
      await supabase.from('live_scores').delete()
        .eq('tournament_name', oldTournament)
        .eq('tour', tour);
    }
  }

  const { error } = await supabase.from('live_scores')
    .upsert(players, { onConflict: 'player_name,tournament_name' });
  if (error) console.error('Supabase error:', error.message);
  else console.log(`✅ Wrote ${players.length} ${tour||''} players`);
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
  if (pga?.round2Checkpoints?.length) {
    const { error } = await supabase.from('round_checkpoints')
      .upsert(pga.round2Checkpoints, { onConflict: 'player_name,tournament_name' });
    if (error) console.error('round_checkpoints write error:', error.message);
  }
}

// ═══════════ STEP 4: GLOBAL RANKINGS ═══════════
// v2 — fixed to match the real 6-player squad format (4 active + 2
// reserves — the 5-active assumption was a leftover from an old
// 7-player format and was silently scoring the wrong player every
// week). Also adds:
//   - Auto-substitution: an active player with no row in this week's
//     field (not "cut" — genuinely absent, e.g. withdrawn/not entered)
//     is swapped for the highest-scoring reserve who IS in the field.
//   - Chip effects: reads chip_usage for the CURRENT tournament and
//     applies Triple Captain (3x), Vice (VC at 2x), Full Bag (all 6
//     score). Mulligan affects transfers, not scoring — handled in
//     the transfer-allowance path, not here.
//   - Season-long accumulation: season_total is now historical points
//     from gameweek_history (archived at each tournament transition,
//     see archiveGameweekResults) PLUS the current, still-live week.

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
  (scores || []).forEach(s => {
    const updated = new Date(s.updated_at || 0);
    if (!latestUpdated || updated > latestUpdated) {
      latestUpdated = updated;
      latestTournament = s.tournament_name;
    }
  });

  // Group live_scores by player_name for fast lookup
  const scoresByPlayer = {};
  (scores || []).forEach(s => {
    if (!scoresByPlayer[s.player_name]) scoresByPlayer[s.player_name] = [];
    scoresByPlayer[s.player_name].push(s);
  });
  // A player "is in the field this week" if they have any row at all
  // for the current tournament (cut still counts — they teed it up).
  function isInFieldThisWeek(name) {
    const rows = scoresByPlayer[name] || [];
    return rows.some(r => r.tournament_name === latestTournament);
  }
  function weekPointsFor(name) {
    const rows = scoresByPlayer[name] || [];
    let pts = 0;
    rows.forEach(r => { if (r.tournament_name === latestTournament) pts += (r.total_points || 0); });
    return pts;
  }

  // 3b. Fetch historical (archived) season points — see archiveGameweekResults()
  const { data: history, error: historyErr } = await supabase.from('gameweek_history').select('user_id,points');
  if (historyErr) console.error('rankings: gameweek_history fetch error:', historyErr.message);
  const historicalByUser = {};
  (history || []).forEach(h => {
    historicalByUser[h.user_id] = (historicalByUser[h.user_id] || 0) + (h.points || 0);
  });

  // 3c. Fetch chip usage active for THIS gameweek only
  const { data: chipRows, error: chipErr } = await supabase.from('chip_usage')
    .select('user_id,chip_name').eq('tournament_name', latestTournament || '');
  if (chipErr) console.error('rankings: chip_usage fetch error:', chipErr.message);
  const chipByUser = {};
  (chipRows || []).forEach(c => { chipByUser[c.user_id] = c.chip_name; });

  // 3d. Manual mid-tournament substitutions for the CURRENT week, and
  // the round-2 checkpoints needed to split their points correctly —
  // see makeSub() on the frontend and the round2Checkpoints capture
  // in fetchPGA(). The rulebook fixes this swap to always land at the
  // R2/R3 boundary, so a simple "before/after checkpoint" split is
  // accurate without needing to know exactly which round it happened.
  const { data: subRows, error: subErr } = await supabase.from('manual_substitutions')
    .select('user_id,outgoing_player_id,incoming_player_id').eq('tournament_name', latestTournament || '');
  if (subErr) console.error('rankings: manual_substitutions fetch error:', subErr.message);
  const manualSubByUser = {};
  (subRows || []).forEach(s => { manualSubByUser[s.user_id] = s; });

  const { data: checkpoints, error: cpErr } = await supabase.from('round_checkpoints')
    .select('player_name,points_at_r2').eq('tournament_name', latestTournament || '');
  if (cpErr) console.error('rankings: round_checkpoints fetch error:', cpErr.message);
  const checkpointByName = {};
  (checkpoints || []).forEach(c => { checkpointByName[c.player_name] = c.points_at_r2 || 0; });

  const results = [];

  for (const squad of squads) {
    const ids = (squad.player_ids || []).map(String);
    const activeChip = chipByUser[squad.user_id] || null;
    // Full Bag: all 6 score. Otherwise: first 4 active, last 2 reserve.
    let activeIds = activeChip === 'benchboost' ? ids.slice(0, 6) : ids.slice(0, 4);
    const reserveIds = activeChip === 'benchboost' ? [] : ids.slice(4, 6);
    const capId = String(squad.captain_id || '');
    const vcId = String(squad.vice_captain_id || '');
    const manualSub = manualSubByUser[squad.user_id] || null;

    // Auto-substitution: if one OR TWO active players are genuinely
    // absent from this week's field entirely (not cut — never teed
    // it up at all), the highest-scoring reserve(s) who ARE in the
    // field sub in automatically — same idea as FPL's bench order,
    // just ranked by this week's actual points rather than a
    // pre-set priority list. Handles either one or both active slots
    // being absent at once.
    if (reserveIds.length) {
      const availableReserves = reserveIds
        .map(pid => ({ pid, name: playerNameById[pid] }))
        .filter(r => r.name && isInFieldThisWeek(r.name))
        .map(r => ({ ...r, pts: weekPointsFor(r.name) }))
        .sort((a, b) => b.pts - a.pts);
      let reserveCursor = 0;
      activeIds = activeIds.map(pid => {
        const name = playerNameById[pid];
        if (name && !isInFieldThisWeek(name) && reserveCursor < availableReserves.length) {
          const sub = availableReserves[reserveCursor++];
          console.log(`🔄 Auto-sub for ${squad.team_name || squad.user_id}: ${name} absent, subbing in ${sub.name}`);
          return sub.pid;
        }
        return pid;
      });
    }

    let seasonTotal = historicalByUser[squad.user_id] || 0;
    let weekTotal = 0;

    // Captain auto-promotion: the rulebook explicitly promises that if
    // the captain doesn't play this week, the vice captain "becomes
    // captain and scores 2x" — this was never actually implemented.
    // Auto-substitution above only swaps an absent ACTIVE player's
    // points slot for a reserve; it doesn't touch who holds the
    // captain/VC multiplier, so this is a separate check.
    const captainName = playerNameById[capId];
    const captainAbsent = captainName && !isInFieldThisWeek(captainName);

    function multiplierFor(pid) {
      if (pid === capId) return activeChip === 'triplecap' ? 3 : 2;
      if (pid === vcId) return (activeChip === 'vice' || captainAbsent) ? 2 : 1.5;
      return 1;
    }

    for (const pid of activeIds) {
      const name = playerNameById[pid];
      if (!name) continue;

      // A manually-subbed-in player only earns points from Round 3
      // onward — their full-tournament total minus their own R1+R2
      // checkpoint (they still played R1-R2 as themselves in real
      // life, just not for this fantasy slot).
      let playerWeekPts = weekPointsFor(name);
      if (manualSub && pid === manualSub.incoming_player_id) {
        playerWeekPts = playerWeekPts - (checkpointByName[name] || 0);
      }

      weekTotal += Math.round(playerWeekPts * multiplierFor(pid));
    }

    // The outgoing half of a manual substitution is no longer in
    // activeIds at all (they're sitting in the bag now) — but their
    // banked R1-R2 points still count, so they're added separately
    // here rather than lost, matching "the outgoing player banks
    // their R1/R2 points" in the rulebook.
    if (manualSub) {
      const outgoingName = playerNameById[manualSub.outgoing_player_id];
      if (outgoingName) {
        const bankedPts = checkpointByName[outgoingName] || 0;
        weekTotal += Math.round(bankedPts * multiplierFor(manualSub.outgoing_player_id));
      }
    }

    seasonTotal += weekTotal;

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

const RESEND_KEY = process.env.RESEND_KEY;

async function sendWelcomeEmail(email, teamName) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'The Field Fantasy Golf <hello@mail.thefieldfantasygolf.com>',
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
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8d8c8;font-style:italic;line-height:1.8;margin:0 0 12px">The Field is that — but all season long, across the PGA Tour, with a prize at the end worth a lot more than a round of drinks."</p>
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8a830;font-weight:700;margin:0">Pick your 4-ball. Name your captain. Let them play.</p>
  </div>
  <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(200,168,48,0.2);border-radius:8px;padding:24px;margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#c8a830;text-transform:uppercase;margin-bottom:16px">How it works</div>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.8;margin:0 0 10px"><strong style="color:#f0f0f0">1. Pick 6 golfers</strong> from the PGA Tour within a £50m budget. Mix the world number one with a rising underdog. The bold call wins leagues.</p>
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
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0 0 12px">Create a private league with your mates and set an entry fee. £5, £10, £20, £50 — your call. Winner takes the pot at the end of the season.</p>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0 0 14px">And the days of chasing your mates round the houses for your fantasy winnings? Behind you. Stripe handles every payment. The gentleman always gets paid.</p>
    <p style="font-family:Georgia,serif;font-size:14px;color:#c8a830;font-style:italic;margin:0;text-align:center">"A gentleman always pays his debts — and a gentleman always collects what he is owed."</p>
  </div>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(74,222,128,0.15);border-radius:8px;padding:20px;margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#4ade80;text-transform:uppercase;margin-bottom:12px">Payments &amp; Your Data</div>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0 0 10px">Every payment — entries and winnings alike — is handled entirely by Stripe, a payments platform trusted by millions of businesses worldwide. Your card details go straight to Stripe when you enter a sweepstake; if you win, you'll connect your bank details once through Stripe's own secure onboarding, and your winnings are sent straight to your bank account automatically.</p>
    <p style="font-size:13px;color:#c8d8c8;line-height:1.7;margin:0">The Field never sees or stores your card number, bank details, or any identity documents. That information stays with Stripe, not with us. Full details are in the app's Rules menu under "Payments &amp; Your Data."</p>
  </div>
  <table style="width:100%;border:1px solid rgba(200,168,48,0.25);border-radius:8px;border-collapse:separate;border-spacing:0;margin-bottom:28px;overflow:hidden">
    <tr><td colspan="3" style="padding:14px 20px;border-bottom:1px solid rgba(200,168,48,0.15);text-align:center;font-size:11px;font-weight:700;letter-spacing:2px;color:#c8a830;text-transform:uppercase">Season Prizes</td></tr>
    <tr>
      <td style="padding:18px 14px;text-align:center;border-right:1px solid rgba(200,168,48,0.1);width:33%"><div style="font-size:20px;margin-bottom:6px">🥇</div><div style="font-size:10px;font-weight:700;color:#c8a830;margin-bottom:6px">1ST PLACE</div><div style="font-family:Georgia,serif;font-size:12px;color:#f0f0f0;line-height:1.5">Sunday Hospitality at The Open Championship</div></td>
      <td style="padding:18px 14px;text-align:center;border-right:1px solid rgba(200,168,48,0.1);width:33%"><div style="font-size:20px;margin-bottom:6px">🥈</div><div style="font-size:10px;font-weight:700;color:#9ca3af;margin-bottom:6px">2ND PLACE</div><div style="font-family:Georgia,serif;font-size:12px;color:#f0f0f0;line-height:1.5">Golf Holiday (destination TBC)</div></td>
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
    console.log('🔍 Checking new signups...');
    const { data: users, error } = await supabase.auth.admin.listUsers();
    if (error) { console.log('❌ listUsers error:', error.message); return; }
    if (!users || !users.users) { console.log('❌ No users data returned'); return; }

    const { data: welcomed } = await supabase.from('welcomed_users').select('user_id');
    const welcomedIds = new Set((welcomed || []).map(w => w.user_id));
    console.log(`👥 Total users: ${users.users.length}, Already welcomed: ${welcomedIds.size}`);

    for (const user of users.users) {
      if (!welcomedIds.has(user.id) && user.email) {
        console.log(`📧 Sending welcome to: ${user.email}`);
        await sendWelcomeEmail(user.email);
        await supabase.from('welcomed_users').insert({ user_id: user.id, email: user.email, sent_at: new Date().toISOString() });
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log('✅ checkNewSignups complete');
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

// ════════════════════════════════════════════════
// DYNAMIC PRICING
// Runs after each tournament completes.
// Price changes are applied to the players table
// and take effect immediately for the next gameweek.
//
// RISES (capped only by floor, no upper ceiling):
//   Major win:      +£0.5m
//   Tournament win: +£0.2m
//   Top 5:          +£0.1m
//
// DROPS:
//   Missed cut: −£0.2m
//
// FLOOR: £3.8m (nobody goes below)
// CEILING: None — Scheffler can keep rising.
//
// Sell price: players always sell at their CURRENT
// market price, so managers who hold rising players
// profit in transfer budget when they sell.
// ════════════════════════════════════════════════
async function updatePrices(completedTournamentName, isMajor = false) {
  try {
    console.log(`💰 Updating prices after: ${completedTournamentName} (major: ${isMajor})`);

    // Fetch final results for this tournament (round 4)
    const { data: scores, error: scErr } = await supabase
      .from('live_scores')
      .select('player_name, position, status, round, tour')
      .eq('tournament_name', completedTournamentName);

    if (scErr || !scores?.length) {
      console.log('updatePrices: no scores found for', completedTournamentName);
      return;
    }

    // Dedupe to one row per player (latest round)
    const byPlayer = {};
    scores.forEach(s => {
      if (!byPlayer[s.player_name] || s.round > byPlayer[s.player_name].round) {
        byPlayer[s.player_name] = s;
      }
    });

    // Fetch current player prices
    const { data: players } = await supabase
      .from('players')
      .select('id, name, price')
      .eq('is_active', true);
    if (!players?.length) return;

    const priceByName = {};
    players.forEach(p => { priceByName[p.name] = { id: p.id, price: parseFloat(p.price) }; });

    const FLOOR = 3.8;
    const updates = [];

    Object.values(byPlayer).forEach(row => {
      const player = priceByName[row.player_name];
      if (!player) return;

      // Strip non-numeric prefixes ("T2" -> "2") — ties are common in golf
      // and parseInt alone fails on a leading "T", silently defaulting
      // every tied position to 999 and missing their price bump.
      const pos = parseInt(String(row.position || '').replace(/[^0-9]/g, '')) || 999;
      const isCut = row.status === 'cut';
      let delta = 0;

      if (isCut) {
        delta = -0.2;
      } else if (pos === 1) {
        delta = isMajor ? 0.5 : 0.2;
      } else if (pos <= 5) {
        delta = 0.1;
      }
      // pos 6-10 and beyond: no change this week (keeps pricing movements meaningful)

      if (delta !== 0) {
        const newPrice = Math.max(FLOOR, Math.round((player.price + delta) * 10) / 10);
        if (newPrice !== player.price) {
          updates.push({ id: player.id, name: row.player_name, oldPrice: player.price, newPrice });
        }
      }
    });

    if (!updates.length) { console.log('updatePrices: no price changes this week'); return; }

    // Apply updates one at a time to log clearly
    for (const u of updates) {
      const { error } = await supabase.from('players')
        .update({ price: u.newPrice })
        .eq('id', u.id);
      if (error) {
        console.error(`updatePrices: error updating ${u.name}:`, error.message);
      } else {
        const dir = u.newPrice > u.oldPrice ? '↑' : '↓';
        console.log(`${dir} ${u.name}: £${u.oldPrice}m → £${u.newPrice}m`);
      }
    }

    console.log(`✅ Price update complete — ${updates.length} player(s) changed`);
  } catch(e) {
    console.log('updatePrices error:', e.message);
  }
}

// NOTE: superseded by an equivalent lookup done directly in the
// frontend's loadTransferAllowance() — kept here only as a reference;
// this was defined but never actually called by anything.
async function getBankedTransfers(userId) {
  try {
    const { data } = await supabase.from('transfer_allowance')
      .select('banked_for_next').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(1);
    return (data && data.length && data[0].banked_for_next) ? data[0].banked_for_next : 1;
  } catch(e) { return 1; }
}

// ============================================
// PAYMENTS API SERVER
// ============================================

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // needed for Stripe webhook signature check
}));

// CORS for frontend calls
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Helper — verify user from Supabase auth token
async function getUserFromToken(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

// Helper — check master payments switch
async function paymentsEnabled() {
  try {
    const { data } = await supabase.from('platform_settings').select('payments_enabled').eq('id', 1).single();
    return data ? data.payments_enabled : false;
  } catch(e) { return false; }
}

// ---- GLOBAL SWEEPSTAKE: Create Checkout Session ----
app.post('/api/sweepstake/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    const enabled = await paymentsEnabled();
    if (!enabled) return res.status(403).json({ error: 'Payments are not yet enabled' });

    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { stakePence, tournamentName } = req.body;
    if (!stakePence || !tournamentName) return res.status(400).json({ error: 'Missing stakePence or tournamentName' });

    // Enforce the entry deadline server-side. This was previously
    // unchecked entirely — anyone could pay to "enter" a sweepstake
    // after the tournament had already finished (or was well underway
    // and the leaderboard already known), guaranteeing themselves a
    // win with zero real risk. The rulebook has always claimed entries
    // close one hour before Thursday's first tee time; this makes that
    // actually true, reusing the same lock timestamp already computed
    // for transfers rather than inventing a separate one.
    const { data: tInfo } = await supabase.from('tournament_info')
      .select('transfer_lock_at,tournament_name').eq('id', 1).single();
    if (tInfo && tInfo.tournament_name === tournamentName && tInfo.transfer_lock_at) {
      if (new Date() >= new Date(tInfo.transfer_lock_at)) {
        return res.status(403).json({ error: 'Entries for this week\'s sweepstake have closed.' });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: `The Field — Weekly Sweepstake (${tournamentName})` },
          unit_amount: stakePence
        },
        quantity: 1
      }],
      metadata: { user_id: user.id, type: 'global_sweepstake', tournament_name: tournamentName, stake_pence: String(stakePence) },
      success_url: 'https://thefieldfantasygolf.com/?payment=success',
      cancel_url: 'https://thefieldfantasygolf.com/?payment=cancelled'
    });

    // Pre-create pending entry
    await supabase.from('sweepstake_entries').insert({
      user_id: user.id,
      tournament_name: tournamentName,
      stake_pence: stakePence,
      stripe_session_id: session.id,
      payment_status: 'pending'
    });

    res.json({ url: session.url });
  } catch(e) {
    console.log('checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- PRIVATE SWEEPSTAKE: Create Checkout Session ----
// ---- Private Sweepstake: Create ----
app.post('/api/private-sweepstake/create', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    const enabled = await paymentsEnabled();
    if (!enabled) return res.status(403).json({ error: 'Payments are not yet enabled' });

    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { stakeAmountPence, tournamentName, gameweek } = req.body;
    if (!stakeAmountPence || stakeAmountPence < 100) {
      return res.status(400).json({ error: 'Minimum stake is £1' });
    }
    if (stakeAmountPence > 1000000) {
      return res.status(400).json({ error: 'Maximum stake is £10,000' });
    }

    // Don't allow creating a private sweepstake for a tournament that's
    // already locked — same gap as the global sweepstake and the join
    // endpoint above.
    const { data: tInfoCreate } = await supabase.from('tournament_info')
      .select('transfer_lock_at,tournament_name').eq('id', 1).single();
    if (tInfoCreate && tInfoCreate.tournament_name === tournamentName && tInfoCreate.transfer_lock_at) {
      if (new Date() >= new Date(tInfoCreate.transfer_lock_at)) {
        return res.status(403).json({ error: 'This week\'s entries have closed — create one for the next gameweek instead.' });
      }
    }

    // Generate a unique 6-char invite code
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Insert the sweepstake record
    const { data: sweep, error: insertErr } = await supabase.from('private_sweepstakes').insert({
      created_by: user.id,
      code,
      stake_amount_pence: stakeAmountPence,
      tournament_name: tournamentName || gameweek || 'This Week',
      gameweek: gameweek || '',
      status: 'open',
      total_pot_pence: 0
    }).select().single();

    if (insertErr) throw new Error(insertErr.message);

    // Creator immediately goes to Stripe checkout to pay their own entry
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: `The Field — Private Sweepstake · ${tournamentName || 'This Week'} · £${(stakeAmountPence / 100).toFixed(stakeAmountPence % 100 === 0 ? 0 : 2)} stake` },
          unit_amount: stakeAmountPence
        },
        quantity: 1
      }],
      metadata: { user_id: user.id, type: 'private_sweepstake', sweepstake_id: sweep.id },
      success_url: 'https://thefieldfantasygolf.com/?payment=success&sweep_code=' + code,
      cancel_url: 'https://thefieldfantasygolf.com/?payment=cancelled'
    });

    // Pre-insert pending entry for creator
    await supabase.from('private_sweepstake_entries').insert({
      sweepstake_id: sweep.id,
      user_id: user.id,
      stripe_session_id: session.id,
      payment_status: 'pending'
    });

    res.json({ url: session.url, code, sweepstakeId: sweep.id });
  } catch(e) {
    console.log('private sweepstake create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Private Sweepstake: Get mine (for this week's entries panel) ----
app.get('/api/private-sweepstake/my', async (req, res) => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    // Sweepstakes I created
    const { data: created } = await supabase.from('private_sweepstakes')
      .select('id, code, stake_amount_pence, tournament_name, status, total_pot_pence')
      .eq('created_by', user.id)
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    // Sweepstakes I've entered (paid) but didn't create
    const { data: entered } = await supabase.from('private_sweepstake_entries')
      .select('sweepstake_id, private_sweepstakes(id, code, stake_amount_pence, tournament_name, status, total_pot_pence)')
      .eq('user_id', user.id)
      .eq('payment_status', 'paid');

    const myEntries = (entered || []).map(function(e) { return e.private_sweepstakes; })
      .filter(function(s) { return s && s.status === 'open'; });

    // Dedupe (creator who already paid is in both)
    const seen = {};
    const all = [...(created || []), ...myEntries].filter(function(s) {
      if (!s || seen[s.id]) return false;
      seen[s.id] = true;
      return true;
    });

    res.json({ sweepstakes: all });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Private Sweepstake: Join by code (lookup) ----
app.get('/api/private-sweepstake/lookup/:code', async (req, res) => {
  try {
    const { data: sweep } = await supabase.from('private_sweepstakes')
      .select('id, code, stake_amount_pence, tournament_name, status, total_pot_pence')
      .eq('code', req.params.code.toUpperCase())
      .eq('status', 'open')
      .single();
    if (!sweep) return res.status(404).json({ error: 'Sweepstake not found or closed' });
    res.json({ sweep });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/private-sweepstake/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    const enabled = await paymentsEnabled();
    if (!enabled) return res.status(403).json({ error: 'Payments are not yet enabled' });

    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { sweepstakeId } = req.body;
    if (!sweepstakeId) return res.status(400).json({ error: 'Missing sweepstakeId' });

    const { data: sweep } = await supabase.from('private_sweepstakes').select('*').eq('id', sweepstakeId).single();
    if (!sweep) return res.status(404).json({ error: 'Sweepstake not found' });
    if (sweep.status !== 'open') return res.status(400).json({ error: 'Sweepstake is no longer open' });

    // Same missing deadline check as the global sweepstake — this
    // relied on sweep.status flipping away from 'open' once the
    // tournament locked, but nothing in the codebase actually does
    // that transition, so it never took effect. Checking directly
    // against the real tee-time-based lock instead.
    const { data: tInfo } = await supabase.from('tournament_info')
      .select('transfer_lock_at,tournament_name').eq('id', 1).single();
    if (tInfo && tInfo.tournament_name === sweep.tournament_name && tInfo.transfer_lock_at) {
      if (new Date() >= new Date(tInfo.transfer_lock_at)) {
        return res.status(403).json({ error: 'Entries for this sweepstake have closed.' });
      }
    }

    // Check not already entered
    const { data: existing } = await supabase.from('private_sweepstake_entries')
      .select('id').eq('sweepstake_id', sweepstakeId).eq('user_id', user.id).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already entered this sweepstake' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: `The Field — Private Sweepstake (${sweep.tournament_name || sweep.gameweek})` },
          unit_amount: sweep.stake_amount_pence
        },
        quantity: 1
      }],
      metadata: { user_id: user.id, type: 'private_sweepstake', sweepstake_id: sweepstakeId },
      success_url: 'https://thefieldfantasygolf.com/?payment=success',
      cancel_url: 'https://thefieldfantasygolf.com/?payment=cancelled'
    });

    await supabase.from('private_sweepstake_entries').insert({
      sweepstake_id: sweepstakeId,
      user_id: user.id,
      stripe_session_id: session.id,
      payment_status: 'pending'
    });

    res.json({ url: session.url });
  } catch(e) {
    console.log('private checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- STRIPE WEBHOOK: Confirm payments ----
app.post('/api/stripe/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.log('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const onboarded = !!(account.charges_enabled && account.payouts_enabled);
    supabase.from('payout_details').update({ connect_onboarded: onboarded })
      .eq('stripe_connect_account_id', account.id)
      .then(() => console.log(`🔗 Connect account ${account.id} onboarded=${onboarded}`));
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};

    try {
      if (meta.type === 'global_sweepstake') {
        await supabase.from('sweepstake_entries')
          .update({ payment_status: 'paid', stripe_payment_intent_id: session.payment_intent })
          .eq('stripe_session_id', session.id);
        console.log(`✅ Global sweepstake payment confirmed: ${meta.user_id}`);
      }
      if (meta.type === 'private_sweepstake') {
        await supabase.from('private_sweepstake_entries')
          .update({ payment_status: 'paid', stripe_payment_intent_id: session.payment_intent })
          .eq('stripe_session_id', session.id);
        // Update pot total
        const { data: sweep } = await supabase.from('private_sweepstakes').select('*').eq('id', meta.sweepstake_id).single();
        if (sweep) {
          await supabase.from('private_sweepstakes')
            .update({ total_pot_pence: (sweep.total_pot_pence || 0) + session.amount_total })
            .eq('id', meta.sweepstake_id);
        }
        console.log(`✅ Private sweepstake payment confirmed: ${meta.user_id}`);
      }
    } catch(e) { console.log('Webhook processing error:', e.message); }
  }

  res.json({ received: true });
});

// ---- Get payments enabled status (public) ----
app.get('/api/payments-status', async (req, res) => {
  const enabled = await paymentsEnabled();
  res.json({ enabled });
});

// ---- Save payout bank details ----
app.post('/api/payout-details', async (req, res) => {
  try {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { accountHolderName, sortCode, accountNumberLast4, payoutEmail } = req.body;
    await supabase.from('payout_details').upsert({
      user_id: user.id,
      account_holder_name: accountHolderName,
      sort_code: sortCode,
      account_number_last4: accountNumberLast4,
      payout_email: payoutEmail,
      updated_at: new Date().toISOString()
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// STRIPE CONNECT — real automatic payouts
// Previously there was no automatic payout system at all: entries
// were taken via Stripe Checkout, but nothing ever determined a
// winner or paid them — that was a fully manual process (look up the
// winner, personally bank-transfer them, mark it paid in the admin
// dashboard). This replaces that with genuine Stripe Connect Express
// accounts: Stripe hosts onboarding (collecting bank details and ID
// verification directly, so this platform never touches that data),
// and once onboarded, paying a winner is a single transfer() call.
// ════════════════════════════════════════════════

// ---- Create/resume Connect onboarding ----
app.post('/api/connect/onboard-link', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { data: existing } = await supabase.from('payout_details')
      .select('stripe_connect_account_id').eq('user_id', user.id).maybeSingle();

    let accountId = existing?.stripe_connect_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        email: user.email || undefined,
        capabilities: { transfers: { requested: true } }
      });
      accountId = account.id;
      await supabase.from('payout_details').upsert({
        user_id: user.id,
        stripe_connect_account_id: accountId,
        connect_onboarded: false,
        updated_at: new Date().toISOString()
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://thefieldfantasygolf.com/?connect=refresh',
      return_url: 'https://thefieldfantasygolf.com/?connect=complete',
      type: 'account_onboarding'
    });

    res.json({ url: accountLink.url });
  } catch(e) {
    console.log('connect onboard-link error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Check onboarding status ----
app.get('/api/connect/status', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    const user = await getUserFromToken(req.headers.authorization);
    if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { data: pd } = await supabase.from('payout_details')
      .select('stripe_connect_account_id,connect_onboarded').eq('user_id', user.id).maybeSingle();

    if (!pd?.stripe_connect_account_id) return res.json({ onboarded: false, hasAccount: false });

    // Re-check with Stripe directly rather than trusting our cached flag,
    // in case the account.updated webhook was missed for any reason.
    const account = await stripe.accounts.retrieve(pd.stripe_connect_account_id);
    const onboarded = !!(account.charges_enabled && account.payouts_enabled);
    if (onboarded !== pd.connect_onboarded) {
      await supabase.from('payout_details').update({ connect_onboarded: onboarded }).eq('user_id', user.id);
    }
    res.json({ onboarded, hasAccount: true });
  } catch(e) {
    console.log('connect status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Admin: who's owed payouts ----
const ADMIN_EMAIL = 'tjslondonlimited@gmail.com';
async function requireAdmin(req) {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user || !user.email || user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return null;
  return user;
}

app.get('/api/admin/payouts', async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Not authorized' });

    const { data: entries, error: entriesErr } = await supabase
      .from('sweepstake_entries')
      .select('*')
      .order('created_at', { ascending: false });
    if (entriesErr) throw entriesErr;

    const { data: payoutDetails, error: pdErr } = await supabase
      .from('payout_details')
      .select('*');
    if (pdErr) throw pdErr;

    const { data: users, error: usersErr } = await supabase.auth.admin.listUsers();
    if (usersErr) throw usersErr;

    const pdByUser = {};
    (payoutDetails || []).forEach(pd => { pdByUser[pd.user_id] = pd; });
    const emailByUser = {};
    (users && users.users ? users.users : []).forEach(u => { emailByUser[u.id] = u.email; });

    const enriched = (entries || []).map(e => ({
      ...e,
      user_email: emailByUser[e.user_id] || null,
      payout_details: pdByUser[e.user_id] || null
    }));

    res.json({ entries: enriched });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/mark-paid', async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Not authorized' });

    const { entryId, payoutReference } = req.body;
    if (!entryId) return res.status(400).json({ error: 'Missing entryId' });

    const { error } = await supabase.from('sweepstake_entries').update({
      payout_status: 'paid',
      payout_method: 'bank_transfer',
      payout_reference: payoutReference || null,
      paid_out_at: new Date().toISOString()
    }).eq('id', entryId);
    if (error) throw error;

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💳 Payments API listening on port ${PORT}`));

async function main() {
  console.log('🏌️  The Field — Scraper v6 (PGA-only)');
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
