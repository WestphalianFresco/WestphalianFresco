#!/usr/bin/env node
// Renders the profile README cards as light and dark SVGs.
// Only public data is queried, so the output never reveals private repositories.

import { mkdir, writeFile } from 'node:fs/promises';

const USER = process.env.PROFILE_USER ?? 'WestphalianFresco';
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const ASSETS = new URL('../assets/', import.meta.url);

// Notebooks store rendered output, which inflates their byte count.
const EXCLUDED_LANGUAGES = new Set(['Jupyter Notebook']);
const TOP_LANGUAGES = 5;
// Fixed language-to-slot map so a language keeps its color when ranks shift.
const LANGUAGE_SLOTS = ['TypeScript', 'Python', 'JavaScript', 'HTML', 'CSS', 'Dart', 'C++', 'Shell'];

const FEATURED = [
  { repo: 'bid-estimator', tags: ['Next.js', 'Claude API', 'Vitest'] },
  { repo: 'openclaw-guide', tags: ['AWS Lightsail', 'self-hosted AI agent'] },
];

// Neutrals follow GitHub's Primer scale, the accent uses GitHub's contribution greens,
// and language colors come from a CVD-validated categorical palette.
const THEMES = {
  light: {
    surface: '#ffffff', raised: '#f6f8fa', border: '#d1d9e0',
    ink: '#1f2328', ink2: '#59636e', muted: '#818b98',
    grid: '#eff2f5', baseline: '#d1d9e0',
    accent: '#1a7f37', accentSoft: '#6fdd8b', quiet: '#c8d1da',
    ramp: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    other: '#8c959f',
  },
  dark: {
    surface: '#0d1117', raised: '#151b23', border: '#3d444d',
    ink: '#f0f6fc', ink2: '#9198a1', muted: '#6e7681',
    grid: '#1b2129', baseline: '#3d444d',
    accent: '#3fb950', accentSoft: '#238636', quiet: '#3d444d',
    ramp: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    other: '#6e7681',
  },
};

const W = 840;
const PAD = 24;
const SANS = '-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,&quot;Noto Sans&quot;,Helvetica,Arial,sans-serif';
const SANS_ADVANCE = 0.56; // conservative average glyph width, in em

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- data ----------

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    createdAt
    contributionsCollection {
      contributionYears
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes {
        name
        stargazerCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

const YEAR_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

const REPO_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name description url isPrivate stargazerCount forkCount pushedAt
    primaryLanguage { name }
  }
}`;

async function collect() {
  const { user } = await graphql(PROFILE_QUERY, { login: USER });
  const cc = user.contributionsCollection;
  const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  const weeks = cc.contributionCalendar.weeks.map((w) => w.contributionDays);

  const allDays = new Map();
  for (const year of cc.contributionYears) {
    const data = await graphql(YEAR_QUERY, {
      login: USER,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of w.contributionDays) allDays.set(d.date, d.contributionCount);
    }
  }
  for (const d of days) allDays.set(d.date, d.contributionCount);
  const today = days[days.length - 1].date;
  const history = [...allDays.entries()]
    .filter(([date]) => date <= today)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const featured = [];
  for (const f of FEATURED) {
    const { repository } = await graphql(REPO_QUERY, { owner: USER, name: f.repo });
    if (repository && !repository.isPrivate) featured.push({ ...repository, tags: f.tags });
  }

  return {
    today,
    firstYear: Math.min(...cc.contributionYears),
    days,
    weeks,
    history,
    breakdown: {
      commits: cc.totalCommitContributions,
      pullRequests: cc.totalPullRequestContributions,
      issues: cc.totalIssueContributions,
      reviews: cc.totalPullRequestReviewContributions,
      repos: cc.totalRepositoryContributions,
      restricted: cc.restrictedContributionsCount,
    },
    yearTotal: cc.contributionCalendar.totalContributions,
    repos: user.repositories.nodes,
    featured,
  };
}

// ---------- metrics ----------

const dayMs = 86_400_000;
const toTime = (date) => Date.parse(`${date}T00:00:00Z`);

function currentStreak(days) {
  let i = days.length - 1;
  if (days[i].contributionCount === 0) i -= 1; // today is not over yet
  let length = 0;
  while (i >= 0 && days[i].contributionCount > 0) {
    length += 1;
    i -= 1;
  }
  return { length, start: length ? days[i + 1].date : null };
}

function longestStreak(history) {
  let best = { length: 0, start: null, end: null };
  let run = null;
  let prev = null;
  for (const { date, count } of history) {
    const contiguous = prev && toTime(date) - toTime(prev) === dayMs;
    if (count > 0) {
      run = run && contiguous ? { ...run, length: run.length + 1, end: date } : { length: 1, start: date, end: date };
      if (run.length > best.length) best = run;
    } else {
      run = null;
    }
    prev = date;
  }
  return best;
}

function monthlyTotals(days) {
  const totals = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    totals.set(key, (totals.get(key) ?? 0) + d.contributionCount);
  }
  return [...totals.entries()].slice(-12).map(([month, total]) => ({ month, total }));
}

function weekdayTotals(days) {
  const totals = Array(7).fill(0);
  for (const d of days) totals[d.weekday] += d.contributionCount;
  const sum = totals.reduce((a, b) => a + b, 0) || 1;
  // Monday-first order reads more naturally than GitHub's Sunday-first.
  return [1, 2, 3, 4, 5, 6, 0].map((i) => ({ day: WEEKDAYS[i], total: totals[i], share: totals[i] / sum }));
}

function languageShares(repos) {
  const sizes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      if (EXCLUDED_LANGUAGES.has(node.name)) continue;
      sizes.set(node.name, (sizes.get(node.name) ?? 0) + size);
    }
  }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, TOP_LANGUAGES).map(([name, size]) => ({ name, share: size / total }));
  const rest = ranked.slice(TOP_LANGUAGES).reduce((a, [, size]) => a + size, 0);
  if (rest > 0) top.push({ name: 'Other', share: rest / total });
  return top;
}

// ---------- svg helpers ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => n.toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(x >= 0.1 ? 0 : 1)}%`;
const textWidth = (text, size) => text.length * size * SANS_ADVANCE;

function shortDate(date, withYear = false) {
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

function relativeTime(iso, now) {
  const days = Math.max(0, Math.round((toTime(now) - Date.parse(iso)) / dayMs));
  if (days <= 0) return 'updated today';
  if (days === 1) return 'updated yesterday';
  if (days < 30) return `updated ${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `updated ${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `updated ${years} year${years === 1 ? '' : 's'} ago`;
}

function wrap(text, size, maxWidth, maxLines) {
  const limit = Math.floor(maxWidth / (size * SANS_ADVANCE));
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > limit && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, limit - 1).trimEnd()}…`;
  }
  return lines;
}

// Rounded top corners only: data-end rounded, square at the baseline.
function columnPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// Rounded right end only, for horizontal bars growing from the left.
function barPath(x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

function niceStep(max, targetTicks = 3) {
  const raw = Math.max(max, 1) / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return Math.max(1, step);
}

function svg({ width, height, title, desc, t, body, css = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>
.sans{font-family:${SANS}}
.ink{fill:${t.ink}}.ink2{fill:${t.ink2}}.muted{fill:${t.muted}}
.h{font-size:14px;font-weight:600}
.sub{font-size:12px}
${css}
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${t.surface}" stroke="${t.border}"/>
${body}
</svg>
`;
}

function header(title, subtitle) {
  return `<text x="${PAD}" y="${PAD + 14}" class="sans h ink">${esc(title)}</text>
<text x="${PAD}" y="${PAD + 33}" class="sans sub ink2">${esc(subtitle)}</text>`;
}

function chip(x, y, label, t, size = 12) {
  const w = Math.round(textWidth(label, size) + 20);
  const h = size + 12;
  return {
    width: w,
    markup: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${t.raised}" stroke="${t.border}"/>
<text x="${x + w / 2}" y="${y + h / 2 + size * 0.35}" text-anchor="middle" class="sans ink2" font-size="${size}">${esc(label)}</text>`,
  };
}

function level(count, max) {
  if (count <= 0) return 0;
  const r = count / Math.max(max, 1);
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}

// ---------- cards ----------

// Banner-only decoration: scatter tiles over empty days across the whole mosaic.
// The stat cards below never use it, so every number there stays real.
const MOSAIC_FILL_DENSITY = 0.25;

// Stable hash in [0, 1) so the scatter does not reshuffle on every daily refresh.
function hash01(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

function fillLevel(date) {
  if (hash01(date) >= MOSAIC_FILL_DENSITY) return 0;
  const shade = hash01(`${date}:shade`);
  return shade < 0.6 ? 1 : shade < 0.9 ? 2 : 3;
}

function heroCard(data, t) {
  const tile = 14;
  const gap = 4;
  const inset = 48;
  const count = Math.floor((W - inset * 2 + gap) / (tile + gap));
  const recent = data.weeks.slice(-count);
  const max = Math.max(...recent.flat().map((d) => d.contributionCount));
  const gridW = recent.length * (tile + gap) - gap;
  const gridH = 7 * (tile + gap) - gap;
  const gx = (W - gridW) / 2;
  const gy = 40;
  const H = gy + gridH + 48;
  // Tiles stay static because stalled animations can leave them invisible; only today pulses.
  const tiles = recent
    .flatMap((week, wi) =>
      week.map((d) => {
        const now = d.date === data.today ? ' class="now"' : '';
        const lvl = d.contributionCount > 0 ? level(d.contributionCount, max) : fillLevel(d.date);
        return `<rect${now} x="${gx + wi * (tile + gap)}" y="${gy + d.weekday * (tile + gap)}" width="${tile}" height="${tile}" rx="3" fill="${t.ramp[lvl]}"/>`;
      }),
    )
    .join('\n');

  // Month labels sit under the column where each month begins, like GitHub's own calendar.
  const starts = recent
    .map((week, wi) => ({ month: Number(week[0].date.slice(5, 7)), x: gx + wi * (tile + gap) }))
    .filter((s, i, all) => i === 0 || s.month !== all[i - 1].month);
  // A partial first month gives way to the next label instead of crowding it.
  if (starts.length > 1 && starts[1].x - starts[0].x < 3 * (tile + gap)) starts.shift();
  const months = starts
    .filter((s) => s.x < gx + gridW - 16)
    .map((s) => `<text x="${s.x}" y="${gy + gridH + 24}" class="sans muted" font-size="11">${MONTHS[s.month - 1]}</text>`);

  const css = `
.now{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.now{animation:none}}`;

  const body = `<defs>
<pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse">
<circle cx="1" cy="1" r="1" fill="${t.border}" opacity="0.55"/>
</pattern>
<clipPath id="clip"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="11"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#dots)" opacity="0.6" clip-path="url(#clip)"/>
${tiles}
${months.join('\n')}`;

  return svg({
    width: W,
    height: H,
    t,
    css,
    title: `${USER} contribution mosaic`,
    desc: `Decorative mosaic built from the last ${recent.length} weeks of contribution activity.`,
    body,
  });
}

function overviewCard(data, t) {
  const H = 214;
  const cur = currentStreak(data.days);
  const best = longestStreak(data.history);
  const allTime = data.history.reduce((a, d) => a + d.count, 0);
  const active = data.days.filter((d) => d.contributionCount > 0).length;
  const months = monthlyTotals(data.days);

  // The first tile is wider so its sparkline never runs into the next tile.
  const top = 88;
  const firstW = 264;
  const restW = (W - PAD * 2 - firstW) / 3;
  const tileX = (i) => PAD + (i ? firstW + (i - 1) * restW : 0);

  const value = (x, n, unit) =>
    `<text x="${x}" y="${top + 34}" class="sans ink"><tspan font-size="32" font-weight="600">${fmt(n)}</tspan>${
      unit ? `<tspan font-size="14" class="ink2" dx="6">${esc(unit)}</tspan>` : ''
    }</text>`;
  const label = (x, s) => `<text x="${x}" y="${top}" class="sans sub ink2">${esc(s)}</text>`;
  const note = (x, s) => `<text x="${x}" y="${top + 58}" class="sans muted" font-size="11">${esc(s)}</text>`;

  // Monthly sparkline columns: history in a quiet tone, the current month in the accent.
  const sparkMax = Math.max(...months.map((m) => m.total), 1);
  const bw = 6;
  const bg = 3;
  const sx = tileX(1) - 28 - months.length * (bw + bg) + bg;
  const sh = 26;
  const sparkBase = top + 34;
  const spark = months
    .map((m, i) => {
      const h = m.total ? Math.max(2, (m.total / sparkMax) * sh) : 0;
      const fill = i === months.length - 1 ? t.accent : t.quiet;
      return h ? `<path d="${columnPath(sx + i * (bw + bg), sparkBase - h, bw, h, 2)}" fill="${fill}"/>` : '';
    })
    .join('');
  const sparkBaseline = `<line x1="${sx}" x2="${sx + months.length * (bw + bg) - bg}" y1="${sparkBase + 0.5}" y2="${sparkBase + 0.5}" stroke="${t.baseline}"/>`;

  const dividers = [1, 2, 3]
    .map((i) => `<line x1="${tileX(i) - 12.5}" x2="${tileX(i) - 12.5}" y1="${top - 12}" y2="${top + 62}" stroke="${t.grid}"/>`)
    .join('');

  const b = data.breakdown;
  const parts = [
    [active, 'active days'],
    [b.commits, 'commits'],
    [b.pullRequests, 'pull requests'],
    [b.issues, 'issues'],
    [b.reviews, 'reviews'],
    [b.restricted, 'in private repos'],
  ];
  const breakdown = `<line x1="${PAD}" x2="${W - PAD}" y1="${top + 82.5}" y2="${top + 82.5}" stroke="${t.grid}"/>
<text x="${PAD}" y="${top + 108}" class="sans sub ink2">${parts
    .map(([n, s], i) => `${i ? '<tspan class="muted">   ·   </tspan>' : ''}<tspan class="ink" font-weight="600">${fmt(n)}</tspan><tspan> ${esc(s)}</tspan>`)
    .join('')}</text>`;

  const body = `${header('At a glance', `Public activity over the last 12 months · refreshed ${shortDate(data.today, true)}`)}
${dividers}
${label(tileX(0), 'Contributions')}${value(tileX(0), data.yearTotal)}${sparkBaseline}${spark}${note(tileX(0), 'last 12 months, by month')}
${label(tileX(1), 'Current streak')}${value(tileX(1), cur.length, cur.length === 1 ? 'day' : 'days')}${note(tileX(1), cur.start ? `since ${shortDate(cur.start)}` : 'start one today')}
${label(tileX(2), 'Longest streak')}${value(tileX(2), best.length, best.length === 1 ? 'day' : 'days')}${note(tileX(2), best.start ? `${shortDate(best.start)} – ${shortDate(best.end, true)}` : '—')}
${label(tileX(3), 'All-time')}${value(tileX(3), allTime)}${note(tileX(3), `contributions since ${data.firstYear}`)}
${breakdown}`;

  return svg({
    width: W,
    height: H,
    t,
    title: 'At a glance',
    desc: `${data.yearTotal} contributions in the last 12 months, current streak ${cur.length} days, longest streak ${best.length} days, ${allTime} contributions since ${data.firstYear}.`,
    body,
  });
}

function activityCard(data, t) {
  const H = 268;
  const weeks = data.weeks.slice(-52).map((w) => ({
    start: w[0].date,
    total: w.reduce((a, d) => a + d.contributionCount, 0),
  }));
  const max = Math.max(...weeks.map((w) => w.total), 0);
  const step = niceStep(max);
  const yMax = Math.max(step, Math.ceil(max / step) * step);

  const left = PAD + 28;
  const right = 556;
  const top = 92;
  const bottom = 222;
  const slot = (right - left) / weeks.length;
  const bw = Math.min(24, Math.max(4, slot - 3));
  const y = (v) => bottom - (v / yMax) * (bottom - top);

  const ticks = [];
  for (let v = step; v <= yMax; v += step) {
    ticks.push(`<line x1="${left}" x2="${right}" y1="${y(v) + 0.5}" y2="${y(v) + 0.5}" stroke="${t.grid}"/>
<text x="${left - 8}" y="${y(v) + 3.5}" text-anchor="end" class="sans muted" font-size="11">${fmt(v)}</text>`);
  }
  ticks.push(`<text x="${left - 8}" y="${bottom + 3.5}" text-anchor="end" class="sans muted" font-size="11">0</text>`);

  const peakIndex = weeks.reduce((best, w, i) => (w.total > weeks[best].total ? i : best), 0);
  const bars = weeks
    .map((w, i) => {
      if (!w.total) return '';
      const x = left + i * slot + (slot - bw) / 2;
      return `<path d="${columnPath(x, y(w.total), bw, bottom - y(w.total), 3)}" fill="${t.accent}"/>`;
    })
    .join('');

  let peakLabel = '';
  if (max > 0) {
    const px = left + peakIndex * slot + slot / 2;
    const anchor = px > right - 60 ? 'end' : px < left + 60 ? 'start' : 'middle';
    peakLabel = `<text x="${px}" y="${y(max) - 8}" text-anchor="${anchor}" class="sans ink2" font-size="11">peak ${fmt(max)} · wk of ${shortDate(weeks[peakIndex].start)}</text>`;
  }

  const monthLabels = [];
  let lastX = -Infinity;
  weeks.forEach((w, i) => {
    const month = Number(w.start.slice(5, 7));
    const prevMonth = i ? Number(weeks[i - 1].start.slice(5, 7)) : null;
    const x = left + i * slot;
    if (i && month !== prevMonth && x - lastX >= 30 && x < right - 16) {
      monthLabels.push(`<text x="${x}" y="${bottom + 18}" class="sans muted" font-size="11">${MONTHS[month - 1]}</text>`);
      lastX = x;
    }
  });

  // Weekday rhythm: the busiest day in the accent, the rest one step quieter.
  const wd = weekdayTotals(data.days);
  const wdMax = Math.max(...wd.map((d) => d.share), 0.0001);
  const peakDay = wd.reduce((a, d) => (d.share > a.share ? d : a), wd[0]);
  const wx = 612;
  const barX = wx + 36;
  const barMax = W - PAD - 44 - barX;
  const rowH = 18;
  const rhythm = wd
    .map((d, i) => {
      const ry = top + 4 + i * rowH;
      const w = d.total ? Math.max(3, (d.share / wdMax) * barMax) : 0;
      const fill = d.share === peakDay.share ? t.accent : t.accentSoft;
      return `<text x="${wx}" y="${ry + 9}" class="sans muted" font-size="11">${d.day}</text>
${w ? `<path d="${barPath(barX, ry, w, 10, 4)}" fill="${fill}"/>` : ''}
<text x="${barX + w + 6}" y="${ry + 9}" class="sans ink2" font-size="11">${pct(d.share)}</text>`;
    })
    .join('\n');

  const body = `${header('Contribution activity', `Weekly contributions over the last 52 weeks · busiest: ${wd.filter((d) => d.share === peakDay.share).map((d) => d.day).join(' & ')}`)}
${ticks.join('\n')}
<line x1="${left}" x2="${right}" y1="${bottom + 0.5}" y2="${bottom + 0.5}" stroke="${t.baseline}"/>
${bars}
${peakLabel}
${monthLabels.join('\n')}
<line x1="${wx - 24.5}" x2="${wx - 24.5}" y1="${top - 4}" y2="${bottom + 18}" stroke="${t.grid}"/>
<text x="${wx}" y="${top - 8}" class="sans sub ink2">By weekday</text>
${rhythm}`;

  return svg({
    width: W,
    height: H,
    t,
    title: 'Contribution activity',
    desc: `Weekly contributions for the last 52 weeks, peaking at ${max}. Busiest weekday: ${peakDay.day} with ${pct(peakDay.share)} of contributions.`,
    body,
  });
}

function languagesCard(langs, t) {
  const H = 152;
  const colorOf = (name) => {
    const slot = LANGUAGE_SLOTS.indexOf(name);
    return slot >= 0 ? t.series[slot] : t.other;
  };
  const x0 = PAD;
  const width = W - PAD * 2;
  const by = 84;
  const bh = 12;
  const gap = 2;
  let x = x0;
  const segments = langs
    .map((l, i) => {
      const w = Math.max(2, l.share * width - (i < langs.length - 1 ? gap : 0));
      const seg = `<rect x="${x}" y="${by}" width="${w}" height="${bh}" fill="${colorOf(l.name)}"/>`;
      x += w + gap;
      return seg;
    })
    .join('');

  const colW = width / 6;
  const legend = langs
    .map((l, i) => {
      const lx = x0 + i * colW;
      return `<circle cx="${lx + 5}" cy="${by + 42}" r="5" fill="${colorOf(l.name)}"/>
<text x="${lx + 16}" y="${by + 46}" class="sans" font-size="12"><tspan class="ink">${esc(l.name)}</tspan><tspan class="ink2" dx="6">${pct(l.share)}</tspan></text>`;
    })
    .join('\n');

  const body = `${header('Stack composition', 'Share of code across public repositories · notebooks excluded')}
<clipPath id="bar"><rect x="${x0}" y="${by}" width="${width}" height="${bh}" rx="6"/></clipPath>
<g clip-path="url(#bar)">${segments}</g>
${legend}`;

  return svg({
    width: W,
    height: H,
    t,
    title: 'Stack composition',
    desc: langs.map((l) => `${l.name} ${pct(l.share)}`).join(', '),
    body,
  });
}

function projectCard(repo, t, today) {
  const CW = 410;
  const H = 176;
  const lines = wrap(repo.description ?? 'No description yet.', 12, CW - 40, 2);
  const desc = lines
    .map((line, i) => `<text x="20" y="${70 + i * 18}" class="sans ink2" font-size="12">${esc(line)}</text>`)
    .join('\n');

  let cx = 20;
  const tags = repo.tags
    .map((label) => {
      const c = chip(cx, 106, label, t, 11);
      cx += c.width + 6;
      return c.markup;
    })
    .join('\n');

  const lang = repo.primaryLanguage?.name;
  const slot = lang ? LANGUAGE_SLOTS.indexOf(lang) : -1;
  const langColor = slot >= 0 ? t.series[slot] : t.other;
  let fx = 20;
  const footer = [];
  if (lang) {
    footer.push(`<circle cx="${fx + 5}" cy="152" r="5" fill="${langColor}"/><text x="${fx + 16}" y="156" class="sans ink2" font-size="12">${esc(lang)}</text>`);
    fx += 16 + lang.length * 12 * SANS_ADVANCE + 18;
  }
  footer.push(`<path transform="translate(${fx},144)" fill="${t.muted}" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/><text x="${fx + 21}" y="156" class="sans ink2" font-size="12">${fmt(repo.stargazerCount)}</text>`);
  footer.push(`<text x="${CW - 20}" y="156" text-anchor="end" class="sans muted" font-size="12">${relativeTime(repo.pushedAt, today)}</text>`);

  const body = `<path transform="translate(20,24)" fill="${t.muted}" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>
<text x="44" y="37" class="sans ink" font-size="14" font-weight="600">${esc(repo.name)}</text>
<text x="${CW - 20}" y="37" text-anchor="end" class="sans muted" font-size="14">↗</text>
${desc}
${tags}
<line x1="20" x2="${CW - 20}" y1="134.5" y2="134.5" stroke="${t.grid}"/>
${footer.join('\n')}`;

  return svg({
    width: CW,
    height: H,
    t,
    title: repo.name,
    desc: repo.description ?? repo.name,
    body,
  });
}

// ---------- main ----------

async function main() {
  if (!TOKEN) throw new Error('Set GH_TOKEN or GITHUB_TOKEN.');
  const data = await collect();
  const langs = languageShares(data.repos);
  await mkdir(ASSETS, { recursive: true });

  for (const [mode, t] of Object.entries(THEMES)) {
    const out = (name, content) => writeFile(new URL(`${name}-${mode}.svg`, ASSETS), content);
    await out('hero', heroCard(data, t));
    await out('overview', overviewCard(data, t));
    await out('activity', activityCard(data, t));
    await out('languages', languagesCard(langs, t));
    for (const repo of data.featured) await out(`project-${repo.name}`, projectCard(repo, t, data.today));
  }
  console.log(`Rendered cards for ${USER} (${data.yearTotal} contributions in the last year).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
