'use strict';

/* Dota Match Coach — OpenDota-powered match analyzer with per-player coaching. */

const API = 'https://api.opendota.com/api';
const CDN = 'https://cdn.cloudflare.steamstatic.com';

const GAME_MODES = {0:'Unknown',1:'All Pick',2:'Captains Mode',3:'Random Draft',4:'Single Draft',
  5:'All Random',12:'Least Played',16:'Captains Draft',18:'Ability Draft',19:'Event',
  20:'All Random Deathmatch',21:'1v1 Mid',22:'All Pick (Ranked)',23:'Turbo'};
const LANE_ROLE = {1:'Safe lane',2:'Mid',3:'Offlane',4:'Jungle'};

// OpenDota benchmarks: percentile vs recent matches on the SAME hero
const BENCH = [
  {k:'gold_per_min',        l:'Farm (GPM)'},
  {k:'xp_per_min',          l:'Experience (XPM)'},
  {k:'last_hits_per_min',   l:'Last hits / min'},
  {k:'lhten',               l:'Last hits at 10:00'},
  {k:'kills_per_min',       l:'Kills / min'},
  {k:'hero_damage_per_min', l:'Hero damage / min'},
  {k:'hero_healing_per_min',l:'Healing / min'},
  {k:'tower_damage',        l:'Tower damage'},
  {k:'stuns_per_min',       l:'Stuns / min'},
];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => n == null ? '—' : Math.round(n).toLocaleString('en-US');
const kfmt = n => Math.abs(n) >= 1000 ? (n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1) + 'k' : String(Math.round(n));
const pct = n => n == null ? '—' : Math.round(n * 100) + '%';
const clock = sec => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');

// ---------- constants (hero / item data), cached in localStorage ----------

let constantsPromise = null;
function getConstants(){
  if (constantsPromise) return constantsPromise;
  constantsPromise = (async () => {
    const KEY = 'dota_constants_v2';
    try {
      const cached = localStorage.getItem(KEY);
      if (cached) return JSON.parse(cached);
    } catch (e) { /* private mode — refetch */ }
    const [heroes, itemIds, items] = await Promise.all([
      fetch(API + '/constants/heroes').then(r => r.json()),
      fetch(API + '/constants/item_ids').then(r => r.json()),
      fetch(API + '/constants/items').then(r => r.json()),
    ]);
    const heroById = {};
    for (const id in heroes)
      heroById[id] = {name: heroes[id].localized_name, npc: heroes[id].name, img: heroes[id].img};
    const itemBySlug = {};
    for (const slug in items)
      itemBySlug[slug] = {name: items[slug].dname || slug, img: items[slug].img || '',
                          cost: items[slug].cost || 0};
    const itemById = {};
    for (const id in itemIds) itemById[id] = itemBySlug[itemIds[id]] || {name: itemIds[id], img: '', cost: 0};
    const c = {heroById, itemById, itemBySlug};
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {}
    return c;
  })();
  constantsPromise.catch(() => { constantsPromise = null; });
  return constantsPromise;
}

// ---------- match cache (localStorage, small LRU) ----------
// A finished match's parsed data never changes, so parsed matches are served from
// cache; unparsed ones are refetched (a requested parse may have landed since).

const MATCH_KEY = id => 'dota_match_v1_' + id;
const MATCH_INDEX = 'dota_match_index_v1';
const MATCH_CACHE_MAX = 3;

function cacheIndex(){
  try { return JSON.parse(localStorage.getItem(MATCH_INDEX)) || []; }
  catch (e) { return []; }
}

function getCachedMatch(id){
  try {
    const m = JSON.parse(localStorage.getItem(MATCH_KEY(id)));
    return m && m.players && m.players.length ? m : null;
  } catch (e) { return null; }
}

function cacheMatch(m){
  try {
    let index = cacheIndex().filter(e => e.id !== m.match_id);
    index.push({id: m.match_id, ts: Date.now()});
    // evict oldest beyond the cap, and retry once more per eviction on quota errors
    while (true){
      while (index.length > MATCH_CACHE_MAX)
        localStorage.removeItem(MATCH_KEY(index.shift().id));
      try {
        localStorage.setItem(MATCH_KEY(m.match_id), JSON.stringify(m));
        localStorage.setItem(MATCH_INDEX, JSON.stringify(index));
        return;
      } catch (e) {
        if (index.length <= 1) return;               // even alone it won't fit — give up
        localStorage.removeItem(MATCH_KEY(index.shift().id));
      }
    }
  } catch (e) { /* storage unavailable — skip caching */ }
}

async function loadMatch(id){
  const cached = getCachedMatch(id);
  if (cached && cached.version != null) return {m: cached, fromCache: true};
  const r = await fetch(`${API}/matches/${id}`);
  if (!r.ok) throw new Error(r.status === 404 ? 'match not found' : 'HTTP ' + r.status);
  const m = await r.json();
  if (m && m.players && m.players.length) cacheMatch(m);
  return {m, fromCache: false};
}

// ---------- analysis ----------

// death minutes per hero npc-name, reconstructed from everyone's kills_log
function deathLog(m){
  const map = {};
  for (const p of m.players || [])
    for (const k of p.kills_log || [])
      (map[k.key] = map[k.key] || []).push(k.time / 60);
  for (const k in map) map[k].sort((a, b) => a - b);
  return map;
}

// one enriched record per player
function buildRecords(m, c){
  const players = m.players || [];
  const deaths = deathLog(m);
  const bySide = side => players.filter(p => (p.player_slot < 128) === (side === 'radiant'));

  const recs = players.map((p, idx) => {
    const isRadiant = p.player_slot < 128;
    const team = bySide(isRadiant ? 'radiant' : 'dire');
    const teamKills = team.reduce((a, q) => a + (q.kills || 0), 0);
    const teamDeaths = team.reduce((a, q) => a + (q.deaths || 0), 0);
    const nwRank = team.filter(q => (q.net_worth || 0) > (p.net_worth || 0)).length + 1;
    const wards = (p.obs_placed || 0) + (p.sen_placed || 0);
    const support = (p.obs_placed || 0) >= 5 || (nwRank >= 4 && wards >= 3);
    const hero = c.heroById[p.hero_id] || {name: 'Hero #' + p.hero_id, npc: '', img: ''};
    return {
      p, idx, isRadiant, hero, support, nwRank,
      laneName: p.is_roaming ? 'Roaming' : (LANE_ROLE[p.lane_role] || '—'),
      kp: teamKills ? (p.kills + p.assists) / teamKills : null,
      deathShare: teamDeaths ? (p.deaths || 0) / teamDeaths : 0,
      deathMin: (hero.npc && deaths[hero.npc]) || [],
      cs10: p.lh_t ? p.lh_t[Math.min(10, p.lh_t.length - 1)] : null,
      gold10: p.gold_t ? p.gold_t[Math.min(10, p.gold_t.length - 1)] : null,
      xp10: p.xp_t ? p.xp_t[Math.min(10, p.xp_t.length - 1)] : null,
      laneOpp: [], laneVerdict: null,
    };
  });

  // lane opponents: radiant safe (1) faces dire off (3), mid faces mid, off faces safe
  const FACING = {1: 3, 2: 2, 3: 1};
  for (const r of recs){
    const face = FACING[r.p.lane_role];
    if (!face) continue;
    r.laneOpp = recs.filter(o => o.isRadiant !== r.isRadiant && o.p.lane_role === face);
    const opps = r.laneOpp.filter(o => o.gold10 != null);
    if (r.gold10 != null && r.xp10 != null && opps.length){
      const mine = r.gold10 + r.xp10;
      const theirs = opps.reduce((a, o) => a + o.gold10 + o.xp10, 0) / opps.length;
      const ratio = theirs ? mine / theirs : 1;
      r.laneVerdict = ratio >= 1.12 ? 'won' : ratio <= 0.88 ? 'lost' : 'even';
    }
  }
  // "who you fed": enemy heroes credited with your deaths (killed_by), how many of
  // your deaths each took, and what share of that enemy's total kills you personally
  // were. Gold handed over is estimated by apportioning the killer's kill-gold by
  // the share of their kills you gave them.
  for (const r of recs){
    const kb = r.p.killed_by || {};
    const list = [];
    for (const npc in kb){
      if (!npc.startsWith('npc_dota_hero_')) continue;   // ignore towers / creeps / neutrals
      const foe = recs.find(o => o.isRadiant !== r.isRadiant && o.hero.npc === npc);
      if (!foe) continue;
      const deaths = kb[npc];
      const theirKills = foe.p.kills || 0;
      const killGold = (foe.p.gold_reasons && foe.p.gold_reasons['11']) || 0;
      list.push({
        foe, deaths,
        shareOfKills: theirKills ? deaths / theirKills : null,
        goldEst: theirKills ? Math.round(killGold * deaths / theirKills) : 0,
      });
    }
    list.sort((a, b) => b.goldEst - a.goldEst || b.deaths - a.deaths);
    r.fedTo = list;
    r.fedDeaths = list.reduce((a, x) => a + x.deaths, 0);
    r.fedGoldEst = list.reduce((a, x) => a + x.goldEst, 0);
  }
  // team totals feed the role-value term (tower siege for cores, stacks for supports)
  const teamAgg = {};
  for (const side of [true, false]){
    const tm = recs.filter(x => x.isRadiant === side);
    teamAgg[side] = {
      tower:  tm.reduce((a, x) => a + (x.p.tower_damage || 0), 0),
      stacks: tm.reduce((a, x) => a + (x.p.camps_stacked || 0), 0),
    };
  }
  const durMin = (m.duration || 0) / 60;
  for (const r of recs)
    r.impact = impactScore(r, {team: teamAgg[r.isRadiant], durationMin: durMin,
                               won: r.isRadiant === !!m.radiant_win});
  return recs;
}

// Role-fair impact score (0–100). It leans on OpenDota's per-hero benchmark
// percentiles so a support isn't punished for low farm — each player is measured
// against others on the SAME hero — then blends in fight contribution, survival,
// and role value (vision for supports, objectives for cores), and finally folds
// in the match result so winning counts toward the score.
function impactScore(r, ctx){
  ctx = ctx || {};
  const p = r.p;
  const t = ctx.team || {};
  const durMin = ctx.durationMin || 0;
  const parts = [];
  const clamp = v => Math.max(0, Math.min(1, v));

  // Hero benchmarks: mean of per-hero percentiles, skipping categories the hero
  // structurally doesn't do (raw 0) so an empty stat isn't averaged in as noise.
  const bench = p.benchmarks;
  if (bench){
    const pcts = Object.keys(bench)
      .filter(k => bench[k] && bench[k].pct != null && bench[k].raw > 0)
      .map(k => bench[k].pct);
    if (pcts.length)
      parts.push({k: 'Hero benchmarks', w: 35, v: pcts.reduce((a, b) => a + b, 0) / pcts.length});
  }

  // Fight contribution: kill participation and teamfight presence folded into one
  // term rather than double-counting the same "were you in the fights?" signal.
  const fight = [];
  if (r.kp != null) fight.push(Math.min(r.kp, 1));
  if (p.teamfight_participation != null) fight.push(p.teamfight_participation);
  if (fight.length)
    parts.push({k: 'Fight contribution', w: 25, v: fight.reduce((a, b) => a + b, 0) / fight.length});

  // Survival: share of team deaths, softened — ≤12% is full marks, ≥42% is zero,
  // so one death in a low-death game no longer wipes the whole component.
  parts.push({k: 'Survival', w: 15, v: clamp(1 - (r.deathShare - 0.12) / 0.30)});

  // Role value: what benchmarks miss and what actually wins games in the role.
  // Supports earn it through vision, dewarding and stacks; cores through the
  // objective (tower) damage that converts a farm lead into the map.
  if (r.support){
    const obs = clamp((p.obs_placed || 0) / Math.max(1, durMin / 3));   // ~1 obs / 3 min = full
    const sen = clamp((p.sen_placed || 0) / Math.max(1, durMin / 4));   // ~1 sentry / 4 min = full
    const stacks = t.stacks ? clamp((p.camps_stacked || 0) / (t.stacks * 0.4)) : 0;
    parts.push({k: 'Vision & utility', w: 25, v: 0.5 * obs + 0.25 * sen + 0.25 * stacks});
  } else {
    const towerShare = t.tower ? (p.tower_damage || 0) / t.tower : 0;
    parts.push({k: 'Objective damage', w: 25, v: clamp(towerShare / 0.35)});  // 35% of team siege = full
  }

  const wsum = parts.reduce((a, b) => a + b.w, 0) || 1;
  let v = parts.reduce((a, b) => a + b.w * b.v, 0) / wsum;
  // Winning is the achievement: fold the result in at 10%, so an even game breaks
  // toward the winner and no performance scores 100 from the losing side — yet a
  // clearly stronger individual game on a loss still outranks a weak win.
  v = 0.9 * v + 0.1 * (ctx.won ? 1 : 0);
  return {score: Math.round(v * 100), parts, won: !!ctx.won};
}

// per-teamfight summary; tf.players is aligned with m.players order
function fightSummaries(m){
  return (m.teamfights || []).map(tf => {
    let radDelta = 0, direDelta = 0;
    const joined = [];
    (tf.players || []).forEach((fp, i) => {
      const p = (m.players || [])[i];
      if (!p) return;
      const d = fp.gold_delta || 0;
      if (p.player_slot < 128) radDelta += d; else direDelta += d;
      joined[i] = !!((fp.damage || 0) > 0 || (fp.deaths || 0) > 0 || (fp.healing || 0) > 0 ||
                     Object.keys(fp.ability_uses || {}).length);
    });
    return {start: tf.start, end: tf.end, deaths: tf.deaths, radDelta, direDelta,
            players: tf.players || [], joined};
  });
}

// ---------- coaching insights engine ----------

function insight(sev, title, ev, why, fix){ return {sev, title, ev, why, fix}; }

function buildInsights(r, ctx){
  const {m, c, durationMin, parsed, fights} = ctx;
  const p = r.p;
  const out = [];
  const core = !r.support;
  const roleWord = core ? 'core' : 'support';

  // --- laning ---
  const early = r.deathMin.filter(t => t < 12);
  if (early.length >= (core ? 2 : 3)){
    const sev = early.length >= (core ? 3 : 4) ? 'critical' : 'warn';
    out.push(insight(sev, 'Deaths during the laning stage',
      `Died ${early.length}× before 12:00 (at ${early.map(t => clock(t * 60)).join(', ')}).` +
      (r.laneVerdict === 'lost' ? ' The lane was lost on gold and experience by 10:00.' : ''),
      `Early deaths are the most expensive mistakes in Dota. Each one hands your lane opponent ` +
      `kill gold and experience, and while you walk back (or wait to respawn) you also miss a ` +
      `full wave or two of farm — so a single early death often swings the lane by 600–1,000 ` +
      `gold. Lose the lane and the deficit compounds: less farm → weaker timings → losing more fights.`,
      `Before committing to trades, check three things: your regen supply, the creep equilibrium ` +
      `(fighting under the enemy tower is usually a losing trade), and the minimap — if an enemy ` +
      `support is missing, assume they are moving to you. Respect level 2 and level 6 power ` +
      `spikes, and buy a few extra regen items instead of dying with full gold.`));
  }

  if (core && parsed && r.cs10 != null && !p.is_roaming){
    const target = p.lane_role === 3 ? 32 : 44;
    if (r.cs10 < target){
      const sev = r.cs10 < target * 0.6 ? 'critical' : 'warn';
      out.push(insight(sev, 'Low last hits at 10 minutes',
        `${r.cs10} last hits at 10:00 — ~${target}+ is a reasonable target for the ` +
        `${r.laneName.toLowerCase()}.`,
        `Last hits are the engine of a core's game. The difference between ${r.cs10} and ` +
        `${target} CS at minute 10 is roughly ${fmt((target - r.cs10) * 45)} gold — close to a ` +
        `full item component — and the gap keeps growing, because farm buys items that make ` +
        `farming faster.`,
        `Practice pure last-hitting in a lobby (50+ at 10:00 with no runes, no rotations is a good ` +
        `benchmark). In games, focus on creep equilibrium: don't auto-attack the wave, aggro ` +
        `enemy creeps to reset a pushing lane, and pull the wave toward your tower when zoned.`));
    }
  }

  const gpmPct = p.benchmarks && p.benchmarks.gold_per_min && p.benchmarks.gold_per_min.pct;
  if (core && gpmPct != null && gpmPct < 0.4){
    out.push(insight(gpmPct < 0.2 ? 'critical' : 'warn', 'Farming efficiency',
      `${fmt(p.gold_per_min)} GPM — bottom ${Math.round(gpmPct * 100)}% of recent ` +
      `${esc(r.hero.name)} players.`,
      `GPM measures “dead time” — minutes where your hero isn't gaining anything. Most low-GPM ` +
      `games aren't about last-hit mechanics; they're about standing still, walking without a ` +
      `destination, or watching fights you can't reach. Cores lose more gold to idle time than ` +
      `to deaths.`,
      `Adopt the rule “always have a next action”: as one camp dies, you should already know ` +
      `your next camp or wave. Push the wave in, then farm the nearest jungle while it bounces ` +
      `back. Ask supports to stack, and clear stacks on your power spikes. Watch a replay of ` +
      `just your hero for 10 minutes and count the seconds you spend doing nothing — it's usually ` +
      `eye-opening.`));
  }

  if (core && r.laneVerdict === 'won' && gpmPct != null && gpmPct < 0.45){
    out.push(insight('warn', 'Won the lane, but didn\'t convert it',
      `Ahead on gold + XP at 10:00, yet finished bottom ${Math.round(gpmPct * 100)}% in GPM for this hero.`,
      `A won lane is a temporary advantage — it decays unless you convert it into map control, ` +
      `towers and faster farm. Winning lane then farming passively lets the enemy cores catch up ` +
      `for free.`,
      `After winning a lane, immediately spend the lead: break the tower to open the enemy jungle, ` +
      `rotate to pressure mid, or take stacked camps. Your goal is to turn a 1k lead at 10:00 ` +
      `into a 4k lead at 20:00, not to preserve it.`));
  }
  if (core && r.laneVerdict === 'lost' && gpmPct != null && gpmPct >= 0.6){
    out.push(insight('good', 'Recovered from a lost lane',
      `Behind at 10:00 but still top ${Math.round((1 - gpmPct) * 100)}% GPM for this hero.`,
      `Recovering farm after a bad lane is one of the strongest skills a core can have — it means ` +
      `you found safe farming patterns instead of tilting into more deaths.`,
      `Keep doing this: when the lane is unwinnable, concede it early and move your farm to the ` +
      `jungle and safer waves rather than feeding under pressure.`));
  }

  // --- fighting ---
  const tf = p.teamfight_participation;
  if (parsed && tf != null && tf < (core ? 0.45 : 0.6) && durationMin > 20){
    out.push(insight('warn', 'Missing teamfights',
      `Present in only ${pct(tf)} of the team's fights` +
      (fights.length ? ` (${fights.length} fights in the match)` : '') + '.',
      `Every fight you miss is effectively a 4v5 — your team fights at 80% strength while you ` +
      `farm. A won fight is worth far more than a jungle camp: kill gold, map control, and ` +
      `usually a tower or Roshan afterward.`,
      `Farm *toward* where the next fight will happen, not away from it. Keep a TP scroll at all ` +
      `times and react to pings within 2–3 seconds. If you decide to skip a fight, make it a ` +
      `real decision (“I take two towers while they fight”), not an accident of camera position.`));
  }

  // feeding one specific hero — the single worst version of dying a lot.
  // key on the most-DEATHS hero (concentration), independent of the gold-sorted display.
  const fed = r.fedTo && r.fedTo.length
    ? r.fedTo.reduce((w, x) => x.deaths > w.deaths ? x : w)
    : null;
  if (fed && fed.deaths >= 4 && fed.shareOfKills != null && fed.shareOfKills >= 0.35){
    const heavy = fed.deaths >= 5 && fed.shareOfKills >= 0.5;
    out.push(insight(heavy ? 'critical' : 'warn', 'You kept feeding one hero',
      `Died to ${esc(fed.foe.hero.name)} ${fed.deaths}× — that's ${pct(fed.shareOfKills)} of their ` +
      `${fed.foe.p.kills} kills, and roughly ${fmt(fed.goldEst)} gold handed to a single enemy.`,
      `Feeding one hero is far worse than spreading deaths around: you're personally funding the ` +
      `enemy's win condition. Every kill you give ${esc(fed.foe.hero.name)} buys the item that kills ` +
      `you again — a snowball loop where one hero gets unstoppable off your net worth alone. A fed ` +
      `carry or mid ends games; the scoreboard's kill count hides that it was mostly one matchup.`,
      `Name the threat and play around it specifically. Learn ${esc(fed.foe.hero.name)}'s power ` +
      `spikes and key cooldowns, and buy the item that blunts them (BKB, Force Staff, Glimmer, ` +
      `detection — whatever fits). Don't path alone where they lurk, hold a TP to escape their ` +
      `initiation, and ask a teammate to babysit or counter-gank. Breaking this one pattern often ` +
      `swings the whole game.`));
  }

  if ((p.deaths || 0) >= 8 && r.deathShare >= 0.32){
    out.push(insight('warn', 'Carrying the team\'s death count',
      `${p.deaths} deaths — ${pct(r.deathShare)} of all deaths on your team.`,
      `Deaths feed the enemy twice: they gain kill gold and you lose farm time. Dying repeatedly ` +
      `also builds enemy killing-streak bounties, so the 8th death is worth much more to them ` +
      `than the 1st. Frequent deaths usually trace back to two habits: positioning at the front ` +
      `of vision, and staying on the map with a big gold buffer and no escape.`,
      `Review each death and label it: “bad position”, “no vision”, “greed”, or “worth it” ` +
      `(a death that bought your team an objective is fine!). If most are the first three, play ` +
      `one step further back than feels natural and carry a TP for escape routes.`));
  }

  // --- support duties ---
  if (r.support){
    const obs = p.obs_placed || 0;
    if (durationMin >= 20 && obs < durationMin / 4){
      out.push(insight('warn', 'Vision was thin',
        `${obs} observer wards in a ${Math.round(durationMin)}-minute game (~1 per ` +
        `${(durationMin / Math.max(obs, 1)).toFixed(0)} min).`,
        `Wards are the support's GPM. Good vision converts directly into gold for the whole team: ` +
        `cores farm dangerous areas safely, ganks get spotted, and fights start on your terms. ` +
        `A support who wards well “earns” more than one who gets a few extra last hits.`,
        `Ward on a rhythm: refresh before each objective (Roshan, tower push, night time) and ` +
        `place wards for the *next* phase of the game, not the last one — e.g. enemy jungle wards ` +
        `when you're ahead, defensive triangle wards when behind.`));
    }
    if ((p.sen_placed || 0) < obs * 0.5 && obs >= 4){
      out.push(insight('info', 'Few sentries — enemy vision lived',
        `${p.sen_placed || 0} sentries vs ${obs} observers.`,
        `Killing enemy wards is worth gold and, more importantly, blinds their rotations. If the ` +
        `enemy supports ward freely, every gank your team attempts is walking into a camera.`,
        `Carry a sentry when you go to ward — popular spots overlap, so you'll often deward and ` +
        `place in one trip. Sweep the Roshan pit and your carry's jungle when the map feels “watched”.`));
    }
    if (parsed && (p.camps_stacked || 0) === 0 && durationMin >= 20){
      out.push(insight('info', 'No camps stacked',
        `0 camps stacked all game.`,
        `Stacking multiplies your cores' farm at zero cost — a triple stack of ancients can be ` +
        `1,000+ gold delivered in one clear.`,
        `Set a mental alarm at x:50 each minute during lulls: pull the nearest camp at x:53–:55 ` +
        `and go back to what you were doing. Two stacks a game is a realistic habit to build.`));
    }
  }

  // --- itemization ---
  const counts = {};
  for (const k of ['item_0','item_1','item_2','item_3','item_4','item_5']){
    const id = p[k];
    if (id) counts[id] = (counts[id] || 0) + 1;
  }
  for (const id in counts){
    if (counts[id] >= 2 && (c.itemById[id] ? c.itemById[id].cost : 0) < 3000){
      out.push(insight('info', 'Gold parked in duplicate components',
        `Ended the game holding ${counts[id]}× ${esc(c.itemById[id] ? c.itemById[id].name : '#' + id)}.`,
        `Unfinished duplicate components are gold that fights for nobody. Item power in Dota is ` +
        `non-linear — one completed item usually beats two half-built ones.`,
        `Plan the next full item before you shop, and use the courier to complete items on the ` +
        `map instead of banking components in your backpack.`));
      break;
    }
  }

  if (core && parsed && Array.isArray(p.purchase_log)){
    const first = p.purchase_log
      .map(e => ({t: e.time, it: c.itemBySlug[e.key]}))
      .filter(e => e.it && e.it.cost >= 3400 && e.t > 0)
      .sort((a, b) => a.t - b.t)[0];
    if (first && first.t / 60 > 21){
      out.push(insight('warn', 'Late first big item',
        `First major item (${esc(first.it.name)}) completed at ${clock(first.t)}.`,
        `Items define timing windows. A core's first big item is usually their strongest power ` +
        `spike of the game — hitting it at 15:00 instead of 22:00 can mean winning the fights ` +
        `that decide the map. Late items mean you fight every mid-game battle a full item down.`,
        `Track a target timing for your first major item in every game (e.g. “Blink by 14:00”), ` +
        `and treat it like a deadline: if you're behind it, change something — safer farm, more ` +
        `stacks, fewer aimless rotations.`));
    }
  }

  // --- strengths (coaching is not just criticism) ---
  if (r.kp != null && r.kp >= 0.7 && (p.kills + p.assists) >= 10){
    out.push(insight('good', 'Excellent kill participation',
      `Involved in ${pct(r.kp)} of the team's kills (${p.kills}K ${p.assists}A).`,
      `High kill participation means you were where the game was happening — the single best ` +
      `simple indicator of map impact.`,
      `Keep it up. If you want to level up further, start *creating* those fights: smoke with ` +
      `teammates and pick fights on your timing rather than joining ones that break out.`));
  }
  const best = BENCH
    .map(b => ({b, v: p.benchmarks && p.benchmarks[b.k] && p.benchmarks[b.k].pct}))
    .filter(x => x.v != null && x.v >= 0.85 && p.benchmarks[x.b.k].raw > 0)
    .sort((a, b) => b.v - a.v).slice(0, 2);
  if (best.length){
    out.push(insight('good', 'Standout stats for this hero',
      best.map(x => `${x.b.l}: top ${Math.max(1, Math.round((1 - x.v) * 100))}% of ` +
        `${esc(r.hero.name)} players`).join(' · ') + '.',
      `These benchmarks compare you against thousands of recent games on the same hero, so a ` +
      `high percentile is a like-for-like strength, not a stat inflated by hero choice.`,
      `Lean into what you're good at when choosing heroes and roles — and use the weaker ` +
      `benchmarks above as your practice list.`));
  }
  const teamTower = ctx.recs.filter(x => x.isRadiant === r.isRadiant)
    .reduce((a, x) => a + (x.p.tower_damage || 0), 0);
  if (teamTower && (p.tower_damage || 0) / teamTower >= 0.4 && p.tower_damage > 2000){
    out.push(insight('good', 'Primary siege threat',
      `${fmt(p.tower_damage)} tower damage — ${pct(p.tower_damage / teamTower)} of the team's total.`,
      `Towers are the map. Every tower you take opens jungle, deep wards and rotation paths, ` +
      `and it's the pressure that forces enemies to respond on your terms.`,
      `Pair this strength with discipline: hit buildings when enemies show elsewhere on the map, ` +
      `and carry a TP to escape the collapse.`));
  }

  const order = {critical: 0, warn: 1, info: 2, good: 3};
  out.sort((a, b) => order[a.sev] - order[b.sev]);
  return out;
}

// ---------- match story ----------

function buildStory(m, c, recs, fights){
  const s = [];
  const durMin = (m.duration || 0) / 60;
  const heroOfSlot = slot => {
    const r = recs.find(x => x.p.player_slot === slot);
    return r ? r.hero.name : null;
  };
  const fb = (m.objectives || []).find(o => o.type === 'CHAT_MESSAGE_FIRSTBLOOD');
  if (fb){
    const h = fb.player_slot != null ? heroOfSlot(fb.player_slot) : null;
    s.push(`First blood at <b>${clock(fb.time)}</b>${h ? ` by <b>${esc(h)}</b>` : ''}.`);
  }
  const adv = m.radiant_gold_adv || [];
  if (adv.length > 10){
    const a10 = adv[10];
    s.push(`At 10:00 <b>${a10 >= 0 ? 'Radiant' : 'Dire'}</b> led the laning stage by ` +
      `<b>${fmt(Math.abs(a10))}</b> gold.`);
  }
  if (fights.length){
    const biggest = fights.reduce((w, f) =>
      Math.abs(f.radDelta - f.direDelta) > Math.abs(w.radDelta - w.direDelta) ? f : w, fights[0]);
    const swing = biggest.radDelta - biggest.direDelta;
    s.push(`The biggest fight came at <b>${clock(biggest.start)}</b> — a ` +
      `<b>${fmt(Math.abs(swing))}</b>-gold swing for ${swing >= 0 ? 'Radiant' : 'Dire'} ` +
      `(${biggest.deaths} deaths).`);
  }
  if (adv.length){
    const loserSign = m.radiant_win ? -1 : 1;
    const loserPeak = Math.max(...adv.map(v => v * loserSign));
    if (loserPeak >= 10000)
      s.push(`A real <b>comeback</b>: ${m.radiant_win ? 'Dire' : 'Radiant'} was up ` +
        `${fmt(loserPeak)} gold at their peak and still lost.`);
  }
  const rosh = {2: 0, 3: 0};
  for (const o of m.objectives || [])
    if (o.type === 'CHAT_MESSAGE_ROSHAN_KILL' && rosh[o.team] != null) rosh[o.team]++;
  if (rosh[2] + rosh[3] > 0)
    s.push(`Roshan: Radiant ${rosh[2]} — Dire ${rosh[3]}.`);
  s.push(`<b>${m.radiant_win ? 'Radiant' : 'Dire'}</b> closed it out in ${clock(m.duration || 0)}.`);
  return s;
}

// ---------- svg helpers ----------

const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs){
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function niceStep(raw){
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const mult of [1, 2, 5, 10]) if (mult * mag >= raw) return mult * mag;
  return 10 * mag;
}
function makeTip(container){
  const tip = document.createElement('div');
  tip.className = 'tip';
  container.appendChild(tip);
  return tip;
}

// ---------- advantage chart (gold / xp toggle) with objective markers ----------

function renderAdvChart(container, m, recs, mode){
  container.innerHTML = '';
  const adv = mode === 'xp' ? m.radiant_xp_adv : m.radiant_gold_adv;
  if (!adv || !adv.length) return;
  const W = 940, H = 300, P = {l: 58, r: 16, t: 44, b: 30};
  const n = adv.length;
  const plotW = W - P.l - P.r, plotH = H - P.t - P.b;
  const step = niceStep(Math.max(1000, ...adv.map(Math.abs)) / 2);
  const yMax = Math.max(step, Math.ceil(Math.max(...adv.map(Math.abs)) / step) * step);
  const x = t => P.l + plotW * (n > 1 ? t / (n - 1) : 0.5);   // t in minutes
  const y = v => P.t + plotH * (1 - (v + yMax) / (2 * yMax));

  const svg = el('svg', {viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Team ${mode === 'xp' ? 'experience' : 'gold'} advantage per minute`});

  for (let v = -yMax; v <= yMax; v += step){
    const gy = y(v);
    svg.appendChild(el('line', {x1: P.l, x2: W - P.r, y1: gy, y2: gy,
      style: `stroke:${v === 0 ? 'var(--baseline)' : 'var(--grid)'};stroke-width:1`}));
    const lbl = el('text', {x: P.l - 8, y: gy + 3.5, 'text-anchor': 'end',
      style: 'fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums'});
    lbl.textContent = v === 0 ? '0' : kfmt(v);
    svg.appendChild(lbl);
  }
  const xEvery = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += xEvery){
    const lbl = el('text', {x: x(i), y: H - 10, 'text-anchor': 'middle',
      style: 'fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums'});
    lbl.textContent = i + 'm';
    svg.appendChild(lbl);
  }

  const defs = el('defs', {});
  const clipTop = el('clipPath', {id: 'adv-clip-top'});
  clipTop.appendChild(el('rect', {x: 0, y: 0, width: W, height: y(0)}));
  const clipBot = el('clipPath', {id: 'adv-clip-bot'});
  clipBot.appendChild(el('rect', {x: 0, y: y(0), width: W, height: H - y(0)}));
  defs.appendChild(clipTop); defs.appendChild(clipBot);
  svg.appendChild(defs);

  const lineD = 'M' + adv.map((v, i) => `${x(i)},${y(v)}`).join(' L');
  const areaD = lineD + ` L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  for (const [clip, colorVar] of [['adv-clip-top', '--radiant'], ['adv-clip-bot', '--dire']]){
    svg.appendChild(el('path', {d: areaD, 'clip-path': `url(#${clip})`,
      style: `fill:var(${colorVar});opacity:.14`}));
    svg.appendChild(el('path', {d: lineD, 'clip-path': `url(#${clip})`,
      style: `fill:none;stroke:var(${colorVar});stroke-width:2;stroke-linejoin:round`}));
  }

  const lblR = el('text', {x: P.l + 6, y: P.t + 14,
    style: 'fill:var(--radiant);font-size:11px;font-weight:600'});
  lblR.textContent = 'Radiant ahead';
  const lblD = el('text', {x: P.l + 6, y: H - P.b - 8,
    style: 'fill:var(--dire);font-size:11px;font-weight:600'});
  lblD.textContent = 'Dire ahead';
  svg.appendChild(lblR); svg.appendChild(lblD);

  // objective markers along the top strip
  const heroOfSlot = slot => {
    const r = recs.find(q => q.p.player_slot === slot);
    return r ? r.hero.name : 'someone';
  };
  const markers = [];
  for (const o of m.objectives || []){
    const t = o.time / 60;
    if (o.type === 'building_kill' && /tower|rax|fort/.test(o.key || '')){
      const radiantLost = (o.key || '').includes('goodguys');
      const what = /fort/.test(o.key) ? 'Ancient' : /rax/.test(o.key) ? 'Barracks' : 'Tower';
      markers.push({t, shape: 'rect', team: radiantLost ? 'dire' : 'radiant',
        label: `${clock(o.time)} — ${radiantLost ? 'Dire' : 'Radiant'} destroyed a ${what}`});
    } else if (o.type === 'CHAT_MESSAGE_ROSHAN_KILL'){
      const team = o.team === 2 ? 'radiant' : 'dire';
      markers.push({t, shape: 'diamond', team,
        label: `${clock(o.time)} — ${team === 'radiant' ? 'Radiant' : 'Dire'} killed Roshan`});
    } else if (o.type === 'CHAT_MESSAGE_FIRSTBLOOD'){
      markers.push({t, shape: 'circle', team: null,
        label: `${clock(o.time)} — first blood` +
          (o.player_slot != null ? ` (${heroOfSlot(o.player_slot)})` : '')});
    }
  }
  markers.sort((a, b) => a.t - b.t);
  let lastX = -99, row = 0;
  for (const mk of markers){
    const mx = x(Math.min(mk.t, n - 1));
    row = (mx - lastX < 9) ? (row + 1) % 2 : 0;
    lastX = mx;
    const my = 14 + row * 12;
    const color = mk.team ? `var(--${mk.team})` : 'var(--ink-2)';
    let node;
    if (mk.shape === 'rect')
      node = el('rect', {x: mx - 3.5, y: my - 3.5, width: 7, height: 7, rx: 1,
        style: `fill:${color}`});
    else if (mk.shape === 'diamond')
      node = el('path', {d: `M${mx},${my - 5} L${mx + 5},${my} L${mx},${my + 5} L${mx - 5},${my} Z`,
        style: `fill:${color}`});
    else
      node = el('circle', {cx: mx, cy: my, r: 3.5, style: `fill:${color}`});
    const title = el('title', {});
    title.textContent = mk.label;
    node.appendChild(title);
    svg.appendChild(node);
  }

  // hover crosshair + tooltip
  const cross = el('line', {y1: P.t, y2: H - P.b,
    style: 'stroke:var(--baseline);stroke-width:1;visibility:hidden'});
  const dot = el('circle', {r: 4, style: 'fill:var(--surface);stroke-width:2;visibility:hidden'});
  svg.appendChild(cross); svg.appendChild(dot);
  container.appendChild(svg);
  const tip = makeTip(container);
  const unit = mode === 'xp' ? 'XP' : 'gold';

  const hit = el('rect', {x: P.l, y: P.t, width: plotW, height: plotH, fill: 'transparent'});
  svg.appendChild(hit);
  hit.addEventListener('mousemove', ev => {
    const box = svg.getBoundingClientRect();
    const mx = (ev.clientX - box.left) * (W / box.width);
    const i = Math.max(0, Math.min(n - 1, Math.round((mx - P.l) / plotW * (n - 1))));
    const v = adv[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.style.visibility = 'visible';
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(v));
    dot.style.stroke = v >= 0 ? 'var(--radiant)' : 'var(--dire)';
    dot.style.visibility = 'visible';
    tip.style.display = 'block';
    tip.innerHTML = `min ${i} — <b>${v >= 0 ? 'Radiant' : 'Dire'}</b> +${fmt(Math.abs(v))} ${unit}`;
    const tx = x(i) / W * box.width;
    tip.style.left = Math.min(tx + 12, box.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = (y(v) / H * box.height - 34) + 'px';
  });
  hit.addEventListener('mouseleave', () => {
    cross.style.visibility = 'hidden'; dot.style.visibility = 'hidden';
    tip.style.display = 'none';
  });
}

// ---------- net worth race (emphasis: you vs lane opponent vs the rest) ----------

function renderNetWorthChart(container, m, recs, sel){
  container.innerHTML = '';
  const withGold = recs.filter(r => Array.isArray(r.p.gold_t) && r.p.gold_t.length > 1);
  if (!withGold.length){
    container.innerHTML = '<p class="mini">Per-minute net worth needs a parsed match.</p>';
    return;
  }
  const me = recs.find(r => r.p.player_slot === sel);
  const opp = me && me.laneOpp.find(o => Array.isArray(o.p.gold_t) && !o.support) ||
              me && me.laneOpp.find(o => Array.isArray(o.p.gold_t));
  const n = Math.max(...withGold.map(r => r.p.gold_t.length));
  const W = 940, H = 300, P = {l: 58, r: 120, t: 20, b: 30};
  const plotW = W - P.l - P.r, plotH = H - P.t - P.b;
  const vMax = Math.max(...withGold.map(r => Math.max(...r.p.gold_t)));
  const step = niceStep(vMax / 4);
  const yMax = Math.ceil(vMax / step) * step;
  const x = i => P.l + plotW * (n > 1 ? i / (n - 1) : 0.5);
  const y = v => P.t + plotH * (1 - v / yMax);

  const svg = el('svg', {viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Gold earned per minute per player'});
  for (let v = 0; v <= yMax; v += step){
    svg.appendChild(el('line', {x1: P.l, x2: W - P.r, y1: y(v), y2: y(v),
      style: `stroke:${v === 0 ? 'var(--baseline)' : 'var(--grid)'};stroke-width:1`}));
    const lbl = el('text', {x: P.l - 8, y: y(v) + 3.5, 'text-anchor': 'end',
      style: 'fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums'});
    lbl.textContent = kfmt(v);
    svg.appendChild(lbl);
  }
  const xEvery = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += xEvery){
    const lbl = el('text', {x: x(i), y: H - 10, 'text-anchor': 'middle',
      style: 'fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums'});
    lbl.textContent = i + 'm';
    svg.appendChild(lbl);
  }

  const pathFor = r => 'M' + r.p.gold_t.map((v, i) => `${x(i)},${y(v)}`).join(' L');
  for (const r of withGold){
    if (r === me || r === opp) continue;
    svg.appendChild(el('path', {d: pathFor(r),
      style: 'fill:none;stroke:var(--deemph);stroke-width:1.5;stroke-linejoin:round;opacity:.85'}));
  }
  const emph = [];
  if (opp) emph.push({r: opp, color: 'var(--dire)', w: 2});
  if (me && Array.isArray(me.p.gold_t)) emph.push({r: me, color: 'var(--accent)', w: 2.5});
  const ends = [];
  for (const e of emph){
    svg.appendChild(el('path', {d: pathFor(e.r),
      style: `fill:none;stroke:${e.color};stroke-width:${e.w};stroke-linejoin:round`}));
    const last = e.r.p.gold_t.length - 1;
    const cy = y(e.r.p.gold_t[last]);
    svg.appendChild(el('circle', {cx: x(last), cy, r: 4,
      style: `fill:${e.color};stroke:var(--surface);stroke-width:2`}));
    ends.push({e, cy, vx: x(last)});
  }
  // direct end labels with collision nudge
  ends.sort((a, b) => a.cy - b.cy);
  for (let i = 1; i < ends.length; i++)
    if (ends[i].cy - ends[i - 1].cy < 14) ends[i].cy = ends[i - 1].cy + 14;
  for (const {e, cy, vx} of ends){
    svg.appendChild(el('circle', {cx: vx + 10, cy: cy - 3, r: 3.5, style: `fill:${e.color}`}));
    const lbl = el('text', {x: vx + 17, y: cy,
      style: 'fill:var(--ink-2);font-size:11px;font-weight:600'});
    lbl.textContent = e.r.hero.name;
    svg.appendChild(lbl);
  }

  const cross = el('line', {y1: P.t, y2: H - P.b,
    style: 'stroke:var(--baseline);stroke-width:1;visibility:hidden'});
  svg.appendChild(cross);
  container.appendChild(svg);
  const tip = makeTip(container);
  const hit = el('rect', {x: P.l, y: P.t, width: plotW, height: plotH, fill: 'transparent'});
  svg.appendChild(hit);
  hit.addEventListener('mousemove', ev => {
    const box = svg.getBoundingClientRect();
    const mx = (ev.clientX - box.left) * (W / box.width);
    const i = Math.max(0, Math.min(n - 1, Math.round((mx - P.l) / plotW * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.style.visibility = 'visible';
    const mine = me && me.p.gold_t ? me.p.gold_t[i] : null;
    const theirs = opp && opp.p.gold_t ? opp.p.gold_t[i] : null;
    let html = `min ${i}`;
    if (mine != null) html += ` — <b>you ${fmt(mine)}</b>`;
    if (theirs != null){
      html += ` · lane opp ${fmt(theirs)}`;
      if (mine != null) html += ` (${mine >= theirs ? '+' : '−'}${fmt(Math.abs(mine - theirs))})`;
    }
    tip.style.display = 'block';
    tip.innerHTML = html;
    const tx = x(i) / W * box.width;
    tip.style.left = Math.min(tx + 12, box.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = '10px';
  });
  hit.addEventListener('mouseleave', () => {
    cross.style.visibility = 'hidden'; tip.style.display = 'none';
  });
}

// ---------- teamfight ledger ----------

function renderFightsChart(container, m, recs, sel, fights){
  container.innerHTML = '';
  if (!fights.length){
    container.innerHTML = '<p class="mini">No teamfight data (needs a parsed match with fights).</p>';
    return;
  }
  const me = recs.find(r => r.p.player_slot === sel);
  const durMin = (m.duration || 1) / 60;
  const W = 460, H = 190, P = {l: 46, r: 10, t: 16, b: 40};
  const plotW = W - P.l - P.r, plotH = H - P.t - P.b;
  const deltas = fights.map(f => me.isRadiant ? f.radDelta : f.direDelta);
  const vMax = Math.max(1000, ...deltas.map(Math.abs));
  const step = niceStep(vMax / 2);
  const yMax = Math.ceil(vMax / step) * step;
  const x = t => P.l + plotW * Math.min(t / durMin, 1);
  const y = v => P.t + plotH * (1 - (v + yMax) / (2 * yMax));

  const svg = el('svg', {viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Gold swing per teamfight for your team'});
  for (let v = -yMax; v <= yMax; v += step){
    svg.appendChild(el('line', {x1: P.l, x2: W - P.r, y1: y(v), y2: y(v),
      style: `stroke:${v === 0 ? 'var(--baseline)' : 'var(--grid)'};stroke-width:1`}));
    const lbl = el('text', {x: P.l - 6, y: y(v) + 3.5, 'text-anchor': 'end',
      style: 'fill:var(--muted);font-size:10px;font-variant-numeric:tabular-nums'});
    lbl.textContent = v === 0 ? '0' : kfmt(v);
    svg.appendChild(lbl);
  }
  for (let t = 0; t <= durMin; t += 10){
    const lbl = el('text', {x: x(t), y: H - 22, 'text-anchor': 'middle',
      style: 'fill:var(--muted);font-size:10px;font-variant-numeric:tabular-nums'});
    lbl.textContent = t + 'm';
    svg.appendChild(lbl);
  }

  fights.forEach((f, fi) => {
    const v = deltas[fi];
    const bx = x(f.start / 60) - 4;
    const good = v >= 0;
    const bar = el('rect', {
      x: bx, width: 8,
      y: good ? y(v) : y(0),
      height: Math.max(2, Math.abs(y(v) - y(0))),
      rx: 2,
      style: `fill:var(--${good ? 'good' : 'critical'})`,
    });
    const fp = f.players[me.idx] || {};
    const joined = f.joined[me.idx];
    const title = el('title', {});
    title.textContent = `Fight at ${clock(f.start)} — your team ${good ? '+' : '−'}` +
      `${fmt(Math.abs(v))} gold, ${f.deaths} deaths. ` +
      (joined ? `You joined: ${fmt(fp.damage || 0)} damage` +
                ((fp.deaths || 0) ? `, died ${fp.deaths}×` : ', survived') + '.'
              : 'You were NOT in this fight.');
    bar.appendChild(title);
    svg.appendChild(bar);
    // participation dot under the axis area
    const dot = el('circle', {cx: bx + 4, cy: H - 8, r: 4,
      style: joined ? 'fill:var(--ink-2)'
                    : 'fill:none;stroke:var(--muted);stroke-width:1.5'});
    const t2 = el('title', {});
    t2.textContent = joined ? 'You were in this fight' : 'You missed this fight';
    dot.appendChild(t2);
    svg.appendChild(dot);
  });
  container.appendChild(svg);
}

// ---------- item timeline ----------

function renderItemTimeline(container, rec, c, duration){
  const log = Array.isArray(rec.p.purchase_log) ? rec.p.purchase_log : null;
  if (!log){
    container.innerHTML = '<p class="mini">Purchase timings need a parsed match.</p>';
    return;
  }
  const notable = log
    .map(e => ({t: e.time, it: c.itemBySlug[e.key], key: e.key}))
    .filter(e => e.it && e.it.cost >= 2000 && e.t > 0)
    .sort((a, b) => a.t - b.t)
    .slice(0, 14);
  if (!notable.length){
    container.innerHTML = '<p class="mini">No major items (≥2,000 gold) were completed.</p>';
    return;
  }
  const durMin = duration / 60;
  let html = '<div class="itl"><div class="axis"></div>';
  for (let t = 0; t <= durMin; t += 10)
    html += `<div class="tickl" style="left:${(t / durMin * 100).toFixed(1)}%">${t}m</div>`;
  const ROWS = [4, 46, 88];               // icon-row y offsets; axis sits at 128px
  const lastPct = ROWS.map(() => -99);
  for (const e of notable){
    const xp = Math.min(e.t / duration, 1) * 100;
    let row = lastPct.findIndex(v => xp - v >= 4);
    if (row < 0) row = lastPct.indexOf(Math.min(...lastPct));   // all crowded — least recent
    lastPct[row] = xp;
    const top = ROWS[row];
    const stemH = 128 - (top + 36);
    const img = e.it.img
      ? `<img src="${CDN}${esc(e.it.img)}" alt="" onerror="this.remove()">`
      : `<span class="mini">${esc(e.it.name.slice(0, 6))}</span>`;
    html += `<div class="it" style="left:${xp.toFixed(1)}%;top:${top}px" ` +
      `title="${esc(e.it.name)} — ${clock(e.t)}">${img}` +
      `<div class="tm">${clock(e.t)}</div>` +
      `<div class="stem" style="height:${Math.max(stemH, 0)}px"></div></div>`;
  }
  html += '</div>';
  html += `<details><summary>All notable purchases</summary><table><thead>
    <tr><th>Time</th><th>Item</th></tr></thead><tbody>` +
    notable.map(e => `<tr><td>${clock(e.t)}</td><td>${esc(e.it.name)}</td></tr>`).join('') +
    '</tbody></table></details>';
  container.innerHTML = html;
}

// ---------- impact ranking (worst → best across the whole match) ----------

function impactRankingHTML(recs, sel){
  // ascending score = worst first; performance rank counts best = #1
  const sorted = [...recs].sort((a, b) => a.impact.score - b.impact.score);
  const n = sorted.length;
  const rows = sorted.map((r, i) => {
    const p = r.p;
    const perfRank = n - i;                    // best player = #1
    const isWorst = i === 0, isBest = i === n - 1;
    const tag = isWorst ? '<span class="pill lost">WORST</span>'
              : isBest  ? '<span class="pill won">MVP</span>' : '';
    const v = r.impact.score / 100;
    const top = r.impact.parts.slice().sort((a, b) => b.w * b.v - a.w * a.v)[0];
    return `<div class="rankrow player${p.player_slot === sel ? ' sel' : ''}" data-slot="${p.player_slot}">
      <div class="pos">#${perfRank}</div>
      <div class="rk-hero">
        ${r.hero.img ? `<img src="${CDN}${esc(r.hero.img)}" alt="" onerror="this.remove()">` : ''}
        <span class="chip ${r.isRadiant ? 'radiant' : 'dire'}" title="${r.isRadiant ? 'Radiant' : 'Dire'}"></span>
        <div class="who">
          <div>${esc(r.hero.name)} ${tag}</div>
          <div class="p">${esc(p.personaname || 'Anonymous')} · ${esc(r.laneName)}${r.support ? ' · Sup' : ''}
            · <b style="color:var(--ink-2)">${p.kills}/${p.deaths}/${p.assists}</b></div>
        </div>
      </div>
      <div class="bar" title="Strongest area: ${esc(top.k)}">
        <i style="width:${Math.max(4, Math.round(v * 100))}%;background:${meterColor(v)}"></i></div>
      <div class="sc">${r.impact.score}</div>
    </div>`;
  }).join('');
  return `<div class="card">
    <h2>Player impact ranking <span class="mini">worst → best</span></h2>
    <p class="h2sub">All ten players scored 0–100 and ordered from lowest impact (top) to highest
      (bottom). Click any player for their full coaching report.</p>
    <div class="rank">${rows}</div>
    <p class="note">Role-adjusted: each player is measured against others on the <b>same hero</b>
      (OpenDota benchmarks, 35%), plus fight contribution — kill participation and teamfight
      presence (25%), survival / share of team deaths (15%), and role value (25%): vision, dewarding
      and stacks for supports, or objective (tower) damage for cores. The result is then folded 10%
      toward the match outcome, so no game scores 100 from the losing side. A guide for where to look
      — not a verdict on who to blame.</p>
  </div>`;
}

// ---------- scoreboard ----------

function itemIcons(p, c){
  const cells = [0,1,2,3,4,5].map(i => p['item_' + i]).filter(Boolean).map(id => {
    const it = c.itemById[id];
    if (it && it.img)
      return `<img src="${CDN}${esc(it.img)}" alt="" title="${esc(it.name)}" onerror="this.remove()">`;
    return `<span class="mini">${esc(it ? it.name : '#' + id)}</span>`;
  });
  return cells.join('') || '—';
}

function teamTable(recs, side, m, c, sel){
  const team = recs.filter(r => r.isRadiant === (side === 'radiant'));
  const maxNW = Math.max(1, ...recs.map(r => r.p.net_worth || 0));
  const maxDmg = Math.max(1, ...recs.map(r => r.p.hero_damage || 0));
  const rows = team.map(r => {
    const p = r.p;
    return `<tr class="player${p.player_slot === sel ? ' sel' : ''}" data-slot="${p.player_slot}">
      <td><div class="hero">
        ${r.hero.img ? `<img src="${CDN}${esc(r.hero.img)}" alt="" onerror="this.remove()">` : ''}
        <div class="who"><div>${esc(r.hero.name)} <span class="mini">lvl ${p.level ?? '—'}</span></div>
        <div class="p">${esc(p.personaname || 'Anonymous')}</div></div>
      </div></td>
      <td><span class="pill role">${esc(r.laneName)}${r.support ? ' · Sup' : ''}</span></td>
      <td><b>${p.kills}/${p.deaths}/${p.assists}</b></td>
      <td>${r.kp == null ? '—' : pct(r.kp)}</td>
      <td>${fmt(p.last_hits)}/${fmt(p.denies)}</td>
      <td>${fmt(p.gold_per_min)}</td>
      <td>${fmt(p.xp_per_min)}</td>
      <td>${kfmt(p.net_worth || 0)}<span class="microbar"><i style="width:${Math.round((p.net_worth || 0) / maxNW * 100)}%"></i></span></td>
      <td>${kfmt(p.hero_damage || 0)}<span class="microbar"><i style="width:${Math.round((p.hero_damage || 0) / maxDmg * 100)}%"></i></span></td>
      <td>${kfmt(p.tower_damage || 0)}</td>
      <td>${(p.obs_placed || 0) + (p.sen_placed || 0)}</td>
      <td class="items">${itemIcons(p, c)}</td>
    </tr>`;
  }).join('');
  const label = side === 'radiant' ? 'Radiant' : 'Dire';
  const kills = side === 'radiant' ? m.radiant_score : m.dire_score;
  const won = m.radiant_win === (side === 'radiant');
  return `<div class="card">
    <h2><span class="chip ${side}"></span>${label}
      <span class="mini">${kills} kills${won ? ' · winner' : ''}</span></h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Hero</th><th>Lane</th><th>K/D/A</th><th>KP</th><th>LH/DN</th><th>GPM</th>
      <th>XPM</th><th>Net worth</th><th>Hero dmg</th><th>Bldg</th><th>Wards</th><th>Items</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">Click a player for their coaching report ↓</p>
  </div>`;
}

// ---------- deep dive ----------

function meterColor(v){
  return v >= 0.5 ? 'var(--accent)' : v >= 0.25 ? 'var(--serious)' : 'var(--critical)';
}

function benchmarksHTML(r, m){
  const b = r.p.benchmarks;
  if (!b) return '<p class="mini">No benchmark data for this player.</p>';
  const turboNote = m && m.game_mode === 23
    ? ' This is a <b>Turbo</b> match — farm and XP numbers run hot, so read percentiles loosely.' : '';
  const rows = BENCH.map(({k, l}) => {
    const e = b[k];
    if (!e || e.pct == null || e.raw == null) return '';
    const v = Math.max(0, Math.min(1, e.pct));
    return `<div class="meter">
      <div class="l">${l}</div>
      <div class="bar"><i style="width:${Math.round(v * 100)}%;background:${meterColor(v)}"></i>
        <span class="median"></span></div>
      <div class="v"><b>${Number(e.raw) >= 100 || Number(e.raw) % 1 === 0
          ? fmt(e.raw) : Number(e.raw).toFixed(1)}</b>
        · top ${Math.max(1, Math.round((1 - v) * 100))}%</div>
    </div>`;
  }).filter(Boolean).join('');
  return rows ? `<div class="meters">${rows}</div>
    <p class="note">Percentile vs recent public matches on the same hero (OpenDota benchmarks).
    The tick marks the median. Blue = above median, orange = below, red = bottom quarter.${turboNote}</p>`
    : '<p class="mini">No benchmark data for this player.</p>';
}

function laneCompareHTML(r){
  const opp = r.laneOpp.filter(o => o.gold10 != null);
  if (r.gold10 == null || !opp.length)
    return '<p class="mini">Lane comparison needs a parsed match with lane data.</p>';
  const avg = f => opp.reduce((a, o) => a + (f(o) || 0), 0) / opp.length;
  const metrics = [
    {l: 'Last hits at 10:00', me: r.cs10, op: avg(o => o.cs10)},
    {l: 'Gold at 10:00',      me: r.gold10, op: avg(o => o.gold10)},
    {l: 'XP at 10:00',        me: r.xp10, op: avg(o => o.xp10)},
    {l: 'Deaths before 10:00', me: r.deathMin.filter(t => t < 10).length,
     op: avg(o => o.deathMin.filter(t => t < 10).length), badHigh: true},
  ];
  const rows = metrics.map(mt => {
    if (mt.me == null || mt.op == null) return '';
    const max = Math.max(mt.me, mt.op, 1);
    return `<div class="pair">
      <div class="pl">${mt.l}${mt.badHigh ? ' <span class="mini">(lower is better)</span>' : ''}</div>
      <div class="row"><div class="bar me" style="width:${(mt.me / max * 100).toFixed(0)}%"></div>
        <div class="val"><b>${Math.round(mt.me)}</b> you</div></div>
      <div class="row"><div class="bar opp" style="width:${(mt.op / max * 100).toFixed(0)}%"></div>
        <div class="val">${Math.round(mt.op)} opp</div></div>
    </div>`;
  }).filter(Boolean).join('');
  const names = r.laneOpp.map(o => esc(o.hero.name)).join(' + ');
  return `<div class="legend"><span><span class="chip accent"></span>You</span>
    <span><span class="chip gray"></span>Lane opponent${r.laneOpp.length > 1 ? 's (avg)' : ''}: ${names}</span></div>
    <div class="pairs">${rows}</div>`;
}

function feedingHTML(r){
  if (!r.fedTo || !r.fedTo.length)
    return `<p class="mini">${r.p.deaths
      ? 'No enemy hero is credited with your deaths (died to towers / creeps), or the match is unparsed.'
      : 'You never died — nothing fed. Clean game!'}</p>`;
  const maxG = Math.max(1, ...r.fedTo.map(x => x.goldEst));
  const top = r.fedTo[0];
  const rows = r.fedTo.map(x => {
    const title = `Died to ${x.foe.hero.name} ${x.deaths}×` +
      (x.shareOfKills != null ? ` — ${pct(x.shareOfKills)} of their ${x.foe.p.kills} kills` : '');
    return `<div class="feedrow" title="${esc(title)}">
      <div class="foe">
        ${x.foe.hero.img ? `<img src="${CDN}${esc(x.foe.hero.img)}" alt="" onerror="this.remove()">` : ''}
        <span>${esc(x.foe.hero.name)}</span></div>
      <div class="bartrack"><i style="width:${Math.max(4, Math.round(x.goldEst / maxG * 100))}%"></i></div>
      <div class="v"><b>~${fmt(x.goldEst)}g</b> <span class="mini">· ${x.deaths}×${
        x.shareOfKills != null ? ` · ${pct(x.shareOfKills)}` : ''}</span></div>
    </div>`;
  }).join('');
  const headline = r.fedTo.length === 1
    ? `All ${r.fedDeaths} of your deaths fed <b>${esc(top.foe.hero.name)}</b>`
    : `Your most expensive feeding went to <b>${esc(top.foe.hero.name)}</b> ` +
      `(~${fmt(top.goldEst)} gold from ${top.deaths} death${top.deaths > 1 ? 's' : ''})`;
  return `<p class="dd-summary" style="margin-top:0">${headline} — in total you handed the enemy
    roughly <b>${fmt(r.fedGoldEst)} gold</b> across ${r.fedDeaths} deaths.</p>
    <div class="feed">${rows}</div>
    <p class="note">Estimated gold each enemy earned from killing you — their kill income split by the
      share of their kills you gave them. <b>Bar length = gold fed</b>, and the label shows deaths (×)
      and your share of that hero's kills. Gold, not death count, drives this view: dying twice to a
      fed carry can feed more than four deaths to a support.</p>`;
}

function deathsHTML(r, m, fights){
  if (!r.deathMin.length)
    return `<p class="mini">${r.p.deaths ? 'Death timings need a parsed match.' : 'No deaths — clean game!'}</p>`;
  const adv = m.radiant_gold_adv || [];
  const items = r.deathMin.map(t => {
    const min = Math.floor(t);
    const inFight = fights.some(f => t * 60 >= f.start - 15 && t * 60 <= f.end + 15);
    let ctx = inFight ? 'in a teamfight' : 'caught alone';
    if (adv[min] != null){
      const lead = adv[min] * (r.isRadiant ? 1 : -1);
      ctx += lead >= 0 ? ` while ${fmt(lead)} gold ahead` : ` while ${fmt(-lead)} gold behind`;
    }
    return `<li><b>${clock(t * 60)}</b> — ${ctx}</li>`;
  }).join('');
  const solo = r.deathMin.filter(t =>
    !fights.some(f => t * 60 >= f.start - 15 && t * 60 <= f.end + 15)).length;
  const note = fights.length && solo >= 3
    ? `<p class="note">${solo} of ${r.deathMin.length} deaths happened <b>outside teamfights</b> —
       deaths that bought your team nothing. That is the first number to shrink.</p>` : '';
  return `<ul class="deaths">${items}</ul>${note}`;
}

function playerSummary(r, insights){
  const parts = [];
  parts.push(`<b>${esc(r.hero.name)}</b> played as ${esc(r.laneName.toLowerCase())} ` +
    `${r.support ? 'support' : 'core'} and finished ` +
    `<b>${r.p.kills}/${r.p.deaths}/${r.p.assists}</b>.`);
  if (r.laneVerdict)
    parts.push(`The lane was <b>${r.laneVerdict === 'even' ? 'even' : r.laneVerdict}</b> at 10:00.`);
  const crit = insights.filter(i => i.sev === 'critical' || i.sev === 'warn');
  const good = insights.filter(i => i.sev === 'good');
  if (crit.length)
    parts.push(`Biggest area to work on: <b>${crit[0].title.toLowerCase()}</b>.`);
  else
    parts.push(`No major red flags in this game.`);
  if (good.length)
    parts.push(`Clear strength: <b>${good[0].title.toLowerCase()}</b>.`);
  return parts.join(' ');
}

function kpisHTML(r){
  const p = r.p;
  const gpmPct = p.benchmarks && p.benchmarks.gold_per_min && p.benchmarks.gold_per_min.pct;
  const tf = p.teamfight_participation;
  const kpis = [
    {l: 'K / D / A', v: `${p.kills}/${p.deaths}/${p.assists}`},
    {l: 'GPM', v: fmt(p.gold_per_min),
     d: gpmPct != null ? `top ${Math.max(1, Math.round((1 - gpmPct) * 100))}% on hero` : null,
     cls: gpmPct != null ? (gpmPct >= 0.5 ? 'up' : 'down') : ''},
    {l: 'XPM', v: fmt(p.xp_per_min)},
    {l: 'CS at 10:00', v: r.cs10 != null ? r.cs10 : '—'},
    {l: 'Kill participation', v: r.kp != null ? pct(r.kp) : '—'},
    {l: 'Fight presence', v: tf != null ? pct(tf) : '—'},
    {l: 'Net worth', v: kfmt(p.net_worth || 0)},
  ];
  return `<div class="kpis">` + kpis.map(k =>
    `<div class="kpi"><div class="l">${k.l}</div><div class="v">${k.v}</div>` +
    (k.d ? `<div class="d ${k.cls || ''}">${k.d}</div>` : '') + `</div>`).join('') + `</div>`;
}

function insightsHTML(insights){
  if (!insights.length)
    return '<p class="mini">Nothing stood out — a solid, standard game.</p>';
  const TAG = {critical: 'FIX FIRST', warn: 'WORK ON', info: 'NOTE', good: 'STRENGTH'};
  return `<div class="insights">` + insights.map(i => `
    <div class="insight ${i.sev}">
      <div class="t"><span class="tag">${TAG[i.sev]}</span>${esc(i.title)}</div>
      <p class="ev">${i.ev}</p>
      <p class="why"><b>Why it matters:</b> ${i.why}</p>
      <p class="fix"><b>How to improve:</b> ${i.fix}</p>
    </div>`).join('') + `</div>`;
}

function renderDeepDive(state){
  const {m, c, recs, fights, sel} = state;
  const host = $('#deepdive');
  const r = recs.find(q => q.p.player_slot === sel);
  if (!r){
    host.innerHTML = `<div class="card callout">Select a player above to get a personal coaching report.</div>`;
    return;
  }
  const durationMin = (m.duration || 0) / 60;
  const parsed = m.version != null;
  const ctx = {m, c, recs, durationMin, parsed, fights};
  const insights = buildInsights(r, ctx);
  const verdictPill = r.laneVerdict
    ? `<span class="pill ${r.laneVerdict}">${r.laneVerdict === 'won' ? 'WON LANE'
        : r.laneVerdict === 'lost' ? 'LOST LANE' : 'EVEN LANE'}</span>` : '';
  const won = r.isRadiant === !!m.radiant_win;

  host.innerHTML = `
    <div class="card">
      <div class="dd-head">
        ${r.hero.img ? `<img class="portrait" src="${CDN}${esc(r.hero.img)}" alt="" onerror="this.remove()">` : ''}
        <div>
          <div class="name">${esc(r.hero.name)}
            <span class="pill role">${esc(r.laneName)} · ${r.support ? 'Support' : 'Core'}</span>
            ${verdictPill}
            <span class="pill ${won ? 'won' : 'lost'}">${won ? 'VICTORY' : 'DEFEAT'}</span></div>
          <div class="sub2">${esc(r.p.personaname || 'Anonymous')} · level ${r.p.level ?? '—'}
            · impact ${r.impact.score}/100 (#${[...recs].sort((a, b) => b.impact.score - a.impact.score)
              .findIndex(x => x === r) + 1} of ${recs.length})</div>
        </div>
      </div>
      <p class="dd-summary">${playerSummary(r, insights)}</p>
      ${kpisHTML(r)}
    </div>

    <div class="grid2" style="margin-bottom:16px">
      <div class="card">
        <h2>How you compare on ${esc(r.hero.name)}</h2>
        <p class="h2sub">Same hero, thousands of recent matches — an honest baseline.</p>
        ${benchmarksHTML(r, m)}
      </div>
      <div class="card">
        <h2>The lane, head to head</h2>
        <p class="h2sub">You vs your direct lane opponent at the 10-minute mark.</p>
        ${laneCompareHTML(r)}
      </div>
    </div>

    <div class="card">
      <h2>Coaching report</h2>
      <p class="h2sub">What to fix first, why it costs you games, and how to practice it.</p>
      ${insightsHTML(insights)}
    </div>

    <div class="card">
      <h2>Who you fed <span class="mini">deaths handed to each enemy hero</span></h2>
      <p class="h2sub">The enemy who last-hit each of your deaths — feeding one hero snowballs it.</p>
      ${feedingHTML(r)}
    </div>

    <div class="card">
      <h2>Net worth race</h2>
      <p class="h2sub">Your farm curve vs your lane opponent — flat stretches are the minutes to win back.</p>
      <div class="legend"><span><span class="chip accent"></span>You</span>
        <span><span class="chip opp"></span>Lane opponent</span>
        <span><span class="chip gray"></span>Everyone else</span></div>
      <div class="chart" id="nwChart"></div>
      <details id="nwTable"><summary>Data table</summary></details>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Teamfight ledger</h2>
        <p class="h2sub">Each bar = one fight's gold swing for your team.
          Filled dot = you were there; hollow = you missed it. Hover for detail.</p>
        <div class="chart" id="tfChart"></div>
        <details id="tfTable"><summary>Data table</summary></details>
      </div>
      <div class="card">
        <h2>Item timings</h2>
        <p class="h2sub">When your major items (≥2,000 gold) came online.</p>
        <div id="itemTl"></div>
        <h2 style="margin-top:18px">Death log</h2>
        <div id="deathLog">${deathsHTML(r, m, fights)}</div>
      </div>
    </div>
    <p class="note">Verdicts are scoreboard heuristics to guide a replay review — not a tribunal.</p>
  `;

  renderNetWorthChart($('#nwChart'), m, recs, sel);
  renderItemTimeline($('#itemTl'), r, c, m.duration || 1);
  renderFightsChart($('#tfChart'), m, recs, sel, fights);

  // table twins for the two SVG charts
  if (Array.isArray(r.p.gold_t)){
    const opp = r.laneOpp.find(o => Array.isArray(o.p.gold_t));
    let t = '<table><thead><tr><th>Minute</th><th>You</th>' +
      (opp ? '<th>Lane opp</th>' : '') + '</tr></thead><tbody>';
    for (let i = 0; i < r.p.gold_t.length; i += 5)
      t += `<tr><td>${i}</td><td>${fmt(r.p.gold_t[i])}</td>` +
           (opp ? `<td>${fmt(opp.p.gold_t[i])}</td>` : '') + '</tr>';
    $('#nwTable').insertAdjacentHTML('beforeend', t + '</tbody></table>');
  }
  if (fights.length){
    let t = '<table><thead><tr><th>Fight</th><th>Team gold Δ</th><th>You</th></tr></thead><tbody>';
    for (const f of fights){
      const v = r.isRadiant ? f.radDelta : f.direDelta;
      t += `<tr><td>${clock(f.start)}</td><td>${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}</td>
        <td>${f.joined[r.idx] ? 'joined' : 'missed'}</td></tr>`;
    }
    $('#tfTable').insertAdjacentHTML('beforeend', t + '</tbody></table>');
  }
}

// ---------- page assembly ----------

const state = {m: null, c: null, recs: [], fights: [], sel: null, advMode: 'gold'};

function render(){
  const {m, c, recs, fights} = state;
  const app = $('#app');
  const parsed = m.version != null;
  const when = m.start_time ? new Date(m.start_time * 1000).toLocaleString() : '—';
  const story = buildStory(m, c, recs, fights);
  const hasAdv = m.radiant_gold_adv && m.radiant_gold_adv.length;
  const hasXp = m.radiant_xp_adv && m.radiant_xp_adv.length;

  app.innerHTML = `
    <div class="card">
      <div class="matchhead">
        <span class="big">Match ${m.match_id}</span>
        <span class="meta">${esc(GAME_MODES[m.game_mode] || 'Mode ' + m.game_mode)}
          · ${clock(m.duration || 0)} · ${esc(when)}</span>
        <span class="winner" style="color:var(--${m.radiant_win ? 'radiant' : 'dire'})">
          ${m.radiant_win ? 'Radiant' : 'Dire'} victory ${m.radiant_score}–${m.dire_score}</span>
        <a href="https://www.opendota.com/matches/${m.match_id}" target="_blank" rel="noopener">OpenDota ↗</a>
      </div>
      <p class="story">${story.join(' ')}</p>
    </div>

    ${parsed ? '' : `<div class="card"><b>Unparsed match.</b> Lane data, farm curves, fight
      participation and timelines are unavailable — scoreboard + benchmark analysis only.
      <button id="parseBtn" style="margin-left:10px;padding:4px 12px;border:1px solid var(--baseline);
        border-radius:6px;background:transparent;color:var(--ink);cursor:pointer">Request parse</button>
      <span id="parseMsg" class="mini"></span></div>`}

    ${hasAdv ? `
      <div class="card">
        <h2>Match momentum
          <span class="seg" id="advSeg">
            <button data-mode="gold" class="${state.advMode === 'gold' ? 'on' : ''}">Gold</button>
            <button data-mode="xp" class="${state.advMode === 'xp' ? 'on' : ''}" ${hasXp ? '' : 'disabled'}>XP</button>
          </span>
        </h2>
        <p class="h2sub">Team advantage per minute. Top strip: ▪ tower/barracks (color = team that
          scored) · ◆ Roshan · ● first blood — hover any marker.</p>
        <div class="chart" id="advChart"></div>
        <details><summary>Data table</summary><table><thead>
          <tr><th>Minute</th><th>Gold lead</th>${hasXp ? '<th>XP lead</th>' : ''}</tr></thead><tbody>
          ${m.radiant_gold_adv.map((v, i) => `<tr><td>${i}</td>
            <td>${v >= 0 ? 'Radiant' : 'Dire'} +${fmt(Math.abs(v))}</td>
            ${hasXp ? `<td>${(m.radiant_xp_adv[i] ?? 0) >= 0 ? 'Radiant' : 'Dire'}
              +${fmt(Math.abs(m.radiant_xp_adv[i] ?? 0))}</td>` : ''}</tr>`).join('')}
        </tbody></table></details>
      </div>` : ''}

    ${impactRankingHTML(recs, state.sel)}

    ${teamTable(recs, 'radiant', m, c, state.sel)}
    ${teamTable(recs, 'dire', m, c, state.sel)}

    <div id="deepdive"></div>
  `;

  if (hasAdv) renderAdvChart($('#advChart'), m, recs, state.advMode);
  renderDeepDive(state);

  // events — both scoreboard rows and impact-ranking rows carry .player + data-slot
  app.querySelectorAll('.player').forEach(row => row.addEventListener('click', () => {
    state.sel = Number(row.dataset.slot);
    app.querySelectorAll('.player').forEach(q =>
      q.classList.toggle('sel', Number(q.dataset.slot) === state.sel));
    renderDeepDive(state);
    $('#deepdive').scrollIntoView({behavior: 'smooth', block: 'start'});
  }));
  const seg = $('#advSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    state.advMode = b.dataset.mode;
    seg.querySelectorAll('button').forEach(q => q.classList.toggle('on', q === b));
    renderAdvChart($('#advChart'), m, recs, state.advMode);
  }));
  const pb = $('#parseBtn');
  if (pb) pb.addEventListener('click', async () => {
    pb.disabled = true;
    try {
      await fetch(`${API}/request/${m.match_id}`, {method: 'POST'});
      $('#parseMsg').textContent = ' Parse requested — re-analyze in a few minutes.';
    } catch (e) {
      $('#parseMsg').textContent = ' Request failed — try on the OpenDota match page.';
    }
  });
}

function setStatus(msg, isError){
  const s = $('#status');
  s.textContent = msg;
  s.className = isError ? 'error' : '';
}

async function analyze(){
  const raw = $('#matchInput').value.trim();
  const idMatch = raw.match(/(\d{6,})/);
  if (!idMatch){ setStatus('Enter a match ID or an OpenDota/Dotabuff match URL.', true); return; }
  const id = idMatch[1];
  setStatus('Fetching match ' + id + '…');
  try {
    const [c, {m, fromCache}] = await Promise.all([getConstants(), loadMatch(id)]);
    if (!m.players || !m.players.length) throw new Error('no player data in response');
    state.m = m; state.c = c;
    state.recs = buildRecords(m, c);
    state.fights = fightSummaries(m);
    // default selection: the match's standout player (most kills+assists on the winning team)
    const winners = state.recs.filter(r => r.isRadiant === !!m.radiant_win);
    const star = (winners.length ? winners : state.recs)
      .reduce((w, r) => (r.p.kills * 2 + r.p.assists) > (w.p.kills * 2 + w.p.assists) ? r : w,
              winners[0] || state.recs[0]);
    state.sel = star ? star.p.player_slot : null;
    render();
    setStatus(fromCache ? 'Loaded from local cache.' : '');
  } catch (e) {
    setStatus('Failed: ' + e.message, true);
  }
}

$('#goBtn').addEventListener('click', analyze);
$('#matchInput').addEventListener('keydown', e => { if (e.key === 'Enter') analyze(); });
analyze(); // auto-run the prefilled match so the page never starts empty
