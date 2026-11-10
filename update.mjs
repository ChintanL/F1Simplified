// Fetches F1 data from OpenF1 and writes data.json for the page.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const UA = `f1-explained (https://github.com/${process.env.GITHUB_REPOSITORY || 'local'})`;
const GAP = Number(process.env.F1_DELAY ?? 2500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.json();
      if (r.status === 404) return []; // OpenF1 answers 404 when a query has no matching rows
      err = new Error(`${r.status} for ${url}`);
    } catch (e) { err = e; }
    await sleep(GAP * (i + 1));
  }
  throw err;
}

// ---------- OpenF1 (mapped into the shape the page reads) ----------
const iso = s => new Date(s).toISOString();
const dt = s => ({ date: iso(s).slice(0, 10), time: iso(s).slice(11, 19) + 'Z' });
const SESSION_KEYS = {
  'Practice 1': 'FirstPractice', 'Practice 2': 'SecondPractice', 'Practice 3': 'ThirdPractice',
  'Qualifying': 'Qualifying', 'Sprint Qualifying': 'SprintQualifying', 'Sprint Shootout': 'SprintShootout', 'Sprint': 'Sprint',
};
const fmtT = s => {
  if (typeof s !== 'number') return null;
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(3).padStart(6, '0'), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

async function openf1() {
  const B = 'https://api.openf1.org/v1';
  const g = async p => { const j = await getJSON(B + p); await sleep(GAP); return j; };
  const year = new Date().getUTCFullYear();
  const meetings = (await g(`/meetings?year=${year}`)).filter(m => !m.is_cancelled && !/testing/i.test(m.meeting_name || '')).sort((a, b) => a.date_start.localeCompare(b.date_start));
  const sessions = await g(`/sessions?year=${year}`);

  const races = [];
  meetings.forEach(m => {
    const ss = sessions.filter(s => s.meeting_key === m.meeting_key);
    const race = ss.find(s => s.session_name === 'Race' && !s.is_cancelled);
    if (!race) return;
    const o = {
      round: String(races.length + 1), raceName: m.meeting_name, ...dt(race.date_start),
      Circuit: { circuitName: m.circuit_short_name, Location: { locality: m.location, country: m.country_name } },
      _raceKey: race.session_key, _end: race.date_end,
      _qualiKey: ss.find(s => s.session_name === 'Qualifying')?.session_key,
    };
    ss.forEach(s => { const k = SESSION_KEYS[s.session_name]; if (k) o[k] = dt(s.date_start); });
    races.push(o);
  });
  if (!races.length) throw new Error('OpenF1 returned no races');

  const done = races.filter(r => new Date(r._end) < new Date());
  const lastRace = done[done.length - 1];
  const clean = r => { const { _raceKey, _end, _qualiKey, ...rest } = r; return rest; };
  const out = {
    races: { RaceTable: { Races: races.map(clean) } },
    ds: { StandingsTable: { StandingsLists: [] } },
    cs: { StandingsTable: { StandingsLists: [] } },
    last: { RaceTable: { Races: [] } },
  };
  if (!lastRace) return out;

  const k = lastRace._raceKey;
  const drivers = await g(`/drivers?session_key=${k}`);
  let cd = [], ct = [], stRound = lastRace.round;
  for (const r of done.slice(-2).reverse()) {
    cd = await g(`/championship_drivers?session_key=${r._raceKey}`);
    ct = await g(`/championship_teams?session_key=${r._raceKey}`);
    stRound = r.round;
    if (cd.length) break;
  }
  const res = await g(`/session_result?session_key=${k}`);
  let grid = await g(`/starting_grid?session_key=${k}`);
  if (!grid.length && lastRace._qualiKey) grid = await g(`/session_result?session_key=${lastRace._qualiKey}`); // qualifying order as a stand-in

  const dv = Object.fromEntries(drivers.map(d => [d.driver_number, d]));
  const nameOf = n => ({ givenName: dv[n]?.first_name || '', familyName: dv[n]?.last_name || `#${n}` });
  const teamOf = n => dv[n]?.team_name || '';

  out.ds.StandingsTable.StandingsLists = [{
    round: stRound,
    DriverStandings: cd.slice().sort((a, b) => a.position_current - b.position_current).map(r => ({
      position: String(r.position_current), points: String(r.points_current),
      Driver: nameOf(r.driver_number), Constructors: [{ name: teamOf(r.driver_number) }],
    })),
  }];
  out.cs.StandingsTable.StandingsLists = [{
    round: stRound,
    ConstructorStandings: ct.slice().sort((a, b) => a.position_current - b.position_current).map(r => ({
      position: String(r.position_current), points: String(r.points_current), Constructor: { name: r.team_name },
    })),
  }];

  const gridOf = Object.fromEntries(grid.map(x => [x.driver_number, x.position]));
  const sorted = res.slice().sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  out.last.RaceTable.Races = [{
    raceName: lastRace.raceName, round: lastRace.round,
    Results: sorted.map((r, i) => {
      const status = r.dsq ? 'Disqualified' : r.dns ? 'Did not start' : r.dnf ? 'Retired' : 'Finished';
      const dur = Array.isArray(r.duration) ? null : r.duration;
      const gap = r.gap_to_leader;
      const time = (r.position === 1 ? fmtT(dur) : typeof gap === 'number' ? `+${gap.toFixed(3)}s` : (gap || null));
      return {
        position: String(r.position ?? i + 1), grid: String(gridOf[r.driver_number] ?? r.position ?? i + 1), points: String(r.points ?? 0),
        Driver: nameOf(r.driver_number), Constructor: { name: teamOf(r.driver_number) },
        ...(time && !r.dnf && !r.dns && !r.dsq ? { Time: { time } } : {}), status,
      };
    }),
  }];
  return out;
}

// ---------- Main ----------
let data;
try { data = await openf1(); }
catch (e) { console.error('OpenF1 failed:', e.message); process.exit(1); }
data.source = 'openf1';
const next = JSON.stringify(data, null, 1);
if (existsSync('data.json') && readFileSync('data.json', 'utf8') === next) console.log('No change');
else { writeFileSync('data.json', next); console.log('Wrote data.json'); }
