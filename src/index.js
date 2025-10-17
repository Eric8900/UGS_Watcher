
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, GatewayIntentBits } from 'discord.js';

// ====== CONFIG VIA ENV VARS ======
const BASE_URL = process.env.BASE_URL || 'https://utexas.instructure.com';
const COURSE_ID = process.env.COURSE_ID || '1431941';
const ENDPOINT = `${BASE_URL}/api/v1/courses/${COURSE_ID}/quizzes/assignment_overrides`;
const PER_PAGE = parseInt(process.env.PER_PAGE || '100', 10);

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; // required
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID
  ? BigInt(process.env.DISCORD_CHANNEL_ID)
  : 0n; // required

// Auth: prefer token; else raw cookie string pasted from browser
const CANVAS_TOKEN = (process.env.CANVAS_TOKEN || '').trim();
const CANVAS_COOKIE_RAW = (process.env.COOKIES_JSON || '').trim();

const POLL_INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || '30', 10);

const STATE_DIR = path.resolve(process.env.STATE_DIR || '.canvas_state');
await fs.mkdir(STATE_DIR, { recursive: true });
const SNAPSHOT_FILE = path.join(STATE_DIR, `quiz_assignment_overrides_${COURSE_ID}.json`);
const ETAG_FILE = path.join(STATE_DIR, `quiz_assignment_overrides_${COURSE_ID}.etag`);

// ====== Helpers ======
function parseCookieString(raw) {
  // Convert 'k=v; a=b; ...' into 'Cookie' header string (already is)
  // We still validate it's semi-well-formed
  if (!raw) return '';
  const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
  const filtered = parts.filter(p => p.includes('='));
  return filtered.join('; ');
}

function makeHeaders() {
  const headers = {
    'User-Agent': 'CanvasQuizOverridesDiffBot/1.0',
    'Accept': 'application/json'
  };
  if (CANVAS_TOKEN) {
    headers['Authorization'] = `Bearer ${CANVAS_TOKEN}`;
  } else if (CANVAS_COOKIE_RAW) {
    headers['Cookie'] = parseCookieString(CANVAS_COOKIE_RAW);
  } else {
    throw new Error('Set CANVAS_TOKEN or COOKIES_JSON in your environment.');
  }
  return headers;
}

async function readETag() {
  try {
    const et = await fs.readFile(ETAG_FILE, 'utf8');
    return et.trim();
  } catch {
    return '';
  }
}

async function writeETag(etag) {
  if (!etag) return;
  await fs.writeFile(ETAG_FILE, etag, 'utf8');
}

function parseLinkHeader(linkHeader) {
  // Example: <https://...page=2>; rel="next", <https://...page=5>; rel="last"
  if (!linkHeader) return {};
  const links = {};
  const parts = linkHeader.split(',');
  for (const p of parts) {
    const seg = p.split(';').map(s => s.trim());
    const urlPart = seg[0];
    const relPart = seg.find(s => s.startsWith('rel='));
    if (!urlPart || !relPart) continue;
    const url = urlPart.slice(1, -1); // remove < >
    const rel = relPart.split('=')[1]?.replaceAll('"', '');
    if (rel) links[rel] = url;
  }
  return links;
}

// ====== HTTP fetch for all overrides with ETag and pagination ======
async function fetchAllOverrides() {
  const headers = makeHeaders();
  const et = await readETag();
  if (et) headers['If-None-Match'] = et;

  const url = new URL(ENDPOINT);
  url.searchParams.set('per_page', String(PER_PAGE));

  const r = await fetch(url, { headers });
  if (r.status === 304) {
    return { data: {}, etag: '', notModified: true };
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Canvas fetch failed: ${r.status} ${r.statusText} - ${body.slice(0, 400)}`);
  }
  const etag = r.headers.get('etag') || '';
  let data = await r.json();

  if (Array.isArray(data)) data = { quiz_assignment_overrides: data };

  // Pagination
  const items = data.quiz_assignment_overrides ?? [];
  let nextUrl = parseLinkHeader(r.headers.get('link') || r.headers.get('Link'))?.next;
  while (nextUrl) {
    const rr = await fetch(nextUrl, { headers: makeHeaders() });
    if (!rr.ok) throw new Error(`Canvas pagination failed: ${rr.status} ${rr.statusText}`);
    const more = await rr.json();
    if (Array.isArray(more)) items.push(...more);
    else if (more?.quiz_assignment_overrides) items.push(...more.quiz_assignment_overrides);
    const links = parseLinkHeader(rr.headers.get('link') || rr.headers.get('Link'));
    nextUrl = links?.next;
  }

  return { data: { quiz_assignment_overrides: items }, etag, notModified: false };
}

// ---- Normalization for diffing ----
const DUE_KEYS = ['due_at', 'unlock_at', 'lock_at', 'title', 'base'];

function normalizeDueEntry(entry) {
  const out = {};
  for (const k of DUE_KEYS) out[k] = entry?.[k] ?? null;
  return out;
}

function sortKeyDue(entry) {
  return [
    String(entry?.title ?? ''),
    entry?.base ? 1 : 0,
    String(entry?.due_at ?? ''),
    String(entry?.unlock_at ?? ''),
    String(entry?.lock_at ?? '')
  ].join('|');
}

function normalizePayloadToIndex(data) {
  const out = {};
  const arr = data?.quiz_assignment_overrides ?? [];
  for (const item of arr) {
    const qid = item?.quiz_id;
    if (qid == null) continue;
    const dueDates = item?.due_dates ?? [];
    const normList = dueDates.map(normalizeDueEntry).sort((a, b) =>
      sortKeyDue(a).localeCompare(sortKeyDue(b))
    );
    out[String(qid)] = normList;
  }
  return out;
}

// ---- Snapshot I/O ----
async function loadSnapshot() {
  try {
    const txt = await fs.readFile(SNAPSHOT_FILE, 'utf8');
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function saveSnapshot(idx) {
  const pretty = JSON.stringify(idx, Object.keys(idx).sort(), 2);
  await fs.writeFile(SNAPSHOT_FILE, pretty, 'utf8');
}

// ---- Diff logic ----
function listDiff(a, b) {
  const diffs = [];
  const maxlen = Math.max(a.length, b.length);
  for (let i = 0; i < maxlen; i++) {
    const left = i < a.length ? a[i] : null;
    const right = i < b.length ? b[i] : null;
    if (JSON.stringify(left) === JSON.stringify(right)) continue;

    const fieldDiffs = {};
    if (left == null || right == null) {
      fieldDiffs['<entry>'] = [left, right];
    } else {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const k of keys) {
        if (JSON.stringify(left[k]) !== JSON.stringify(right[k])) {
          fieldDiffs[k] = [left[k], right[k]];
        }
      }
    }
    if (Object.keys(fieldDiffs).length) diffs.push([i, fieldDiffs]);
  }
  return diffs;
}

function computeChangesQuiz(oldIdx, newIdx) {
  const added = [];
  const removed = [];
  const changed = [];

  const oldIds = new Set(Object.keys(oldIdx));
  const newIds = new Set(Object.keys(newIdx));

  for (const qid of [...newIds].filter(q => !oldIds.has(q)).sort((a, b) => Number(a) - Number(b))) {
    added.push(qid);
  }
  for (const qid of [...oldIds].filter(q => !newIds.has(q)).sort((a, b) => Number(a) - Number(b))) {
    removed.push(qid);
  }
  for (const qid of [...oldIds].filter(q => newIds.has(q)).sort((a, b) => Number(a) - Number(b))) {
    const diffs = listDiff(oldIdx[qid], newIdx[qid]);
    if (diffs.length) changed.push([qid, diffs]);
  }
  return { added, removed, changed };
}

function fmtDt(x) {
  return x ?? 'null';
}

function renderChangeMessageQuiz(addedQids, removedQids, changedQids, courseId) {
  const lines = [];
  if (addedQids.length) {
    lines.push('**➕ NEW ATTENDANCE QUIZ ADDED**');
  }
  if (removedQids.length) {
    lines.push('**➖ QUIZZES REMOVED**');
  }
  if (changedQids.length) {
    lines.push('**✏️ QUIZ UPDATED**');
    for (const [qid, diffs] of changedQids) {
      lines.push(`- quiz \`${qid}\``);
      for (const [idx, fields] of diffs) {
        const pretty = [];
        if (fields['<entry>']) {
          const [ov, nv] = fields['<entry>'];
          pretty.push(`entry #${idx}: ${JSON.stringify(ov)} → ${JSON.stringify(nv)}`);
        } else {
          for (const [k, [ov, nv]] of Object.entries(fields)) {
            if (k === 'due_at' || k === 'unlock_at' || k === 'lock_at') {
              pretty.push(`${k}: \`${fmtDt(ov)}\` → \`${fmtDt(nv)}\``);
            } else {
              pretty.push(`${k}: \`${ov}\` → \`${nv}\``);
            }
          }
        }
        lines.push('   • ' + pretty.join('; '));
      }
    }
  }
  if (!lines.length) return '';
  const header = `@everyone 📣 CANVAS CHANGES DETECTED`;
  let content = `${header}\n${lines.join('\n')}`;
  if (content.length > 1990) {
    content = content.slice(0, 1987) + '...';
  }
  return content;
}

// ====== DISCORD BOT ======
if (!DISCORD_BOT_TOKEN) {
  console.error('Set DISCORD_BOT_TOKEN env var.');
  process.exit(1);
}
if (DISCORD_CHANNEL_ID === 0n) {
  console.error('Set DISCORD_CHANNEL_ID env var to a numeric channel ID.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds] // sufficient to fetch a channel & send a message
});

async function postMessage(channelId, content) {
  const channel = await client.channels.fetch(channelId.toString());
  if (!channel?.isTextBased()) {
    throw new Error('Provided DISCORD_CHANNEL_ID is not a text channel.');
  }
  await channel.send({ content: content.slice(0, 1990) });
}

async function watcher() {
  if (!DISCORD_CHANNEL_ID) return;
  while (true) {
    try {
      const { data, etag, notModified } = await fetchAllOverrides();
      if (notModified) {
        await postMessage(DISCORD_CHANNEL_ID, 'Nothing Changed.');
      } else {
        const newIdx = normalizePayloadToIndex(data);
        const oldIdx = await loadSnapshot();
        const { added, removed, changed } = computeChangesQuiz(oldIdx, newIdx);
        if (added.length || removed.length || changed.length) {
          const msg = renderChangeMessageQuiz(added, removed, changed, COURSE_ID);
          if (msg) await postMessage(DISCORD_CHANNEL_ID, msg);
          await saveSnapshot(newIdx);
        }
        await writeETag(etag);
      }
    } catch (e) {
      console.error('[watcher] Error:', e?.message || e);
    }
    await delay(POLL_INTERVAL_SEC * 1000);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag} (id=${client.user.id})`);
  watcher(); // fire and forget loop
});

client.login(DISCORD_BOT_TOKEN);