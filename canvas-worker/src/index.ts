// src/index.ts
import HTML from './index.html';
export interface Env {
	STATE: KVNamespace;                // for etag + snapshot
	POLLER: DurableObjectNamespace;    // bound to this class via wrangler.jsonc
	BASE_URL: string;
	COURSE_ID: string;
	PER_PAGE: number;
	INTERVAL_SEC: number;
	DISCORD_BOT_TOKEN: string;
	DISCORD_CHANNEL_ID: string;
	// COOKIES_JSON is NOT required here; we store it per-DO from the UI
}

const DUE_KEYS = ['due_at', 'unlock_at', 'lock_at', 'title', 'base'] as const;
const COOKIE_KEY = 'canvas_cookies';
const NOCHANGE_KEY = 'last_nochange_post_ms';

function normalizeDueEntry(entry: any) {
	const out: Record<string, unknown> = {};
	for (const k of DUE_KEYS) out[k] = entry?.[k] ?? null;
	return out;
}
function sortKeyDue(entry: any) {
	return [
		String(entry?.title ?? ''),
		entry?.base ? 1 : 0,
		String(entry?.due_at ?? ''),
		String(entry?.unlock_at ?? ''),
		String(entry?.lock_at ?? ''),
	].join('|');
}
function normalizePayloadToIndex(data: any) {
	const out: Record<string, any[]> = {};
	const arr = data?.quiz_assignment_overrides ?? [];
	for (const item of arr) {
		const qid = item?.quiz_id;
		if (qid == null) continue;
		const dueDates = item?.due_dates ?? [];
		const normList = dueDates
			.map(normalizeDueEntry)
			.sort((a: any, b: any) => sortKeyDue(a).localeCompare(sortKeyDue(b)));
		out[String(qid)] = normList;
	}
	return out;
}
function listDiff(a: any[], b: any[]) {
	const diffs: Array<[number, Record<string, [unknown, unknown]>]> = [];
	const maxlen = Math.max(a.length, b.length);
	for (let i = 0; i < maxlen; i++) {
		const left = i < a.length ? a[i] : null;
		const right = i < b.length ? b[i] : null;
		if (JSON.stringify(left) === JSON.stringify(right)) continue;
		const fieldDiffs: Record<string, [unknown, unknown]> = {};
		if (left == null || right == null) {
			fieldDiffs['<entry>'] = [left, right];
		} else {
			const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
			for (const k of keys) {
				if (JSON.stringify((left as any)[k]) !== JSON.stringify((right as any)[k])) {
					fieldDiffs[k] = [(left as any)[k], (right as any)[k]];
				}
			}
		}
		if (Object.keys(fieldDiffs).length) diffs.push([i, fieldDiffs]);
	}
	return diffs;
}
function computeChangesQuiz(oldIdx: Record<string, any[]>, newIdx: Record<string, any[]>) {
	const added: string[] = [];
	const removed: string[] = [];
	const changed: Array<[string, Array<[number, Record<string, [unknown, unknown]>]>]> = [];

	const oldIds = new Set(Object.keys(oldIdx));
	const newIds = new Set(Object.keys(newIdx));

	[...newIds].filter(q => !oldIds.has(q)).sort((a, b) => +a - +b).forEach(q => added.push(q));
	[...oldIds].filter(q => !newIds.has(q)).sort((a, b) => +a - +b).forEach(q => removed.push(q));
	[...oldIds].filter(q => newIds.has(q)).sort((a, b) => +a - +b).forEach(q => {
		const diffs = listDiff(oldIdx[q], newIdx[q]);
		if (diffs.length) changed.push([q, diffs]);
	});

	return { added, removed, changed };
}
function fmtDt(x: unknown) { return x ?? 'null'; }
function renderChangeMessageQuiz(added: string[], removed: string[], changed: Array<[string, any]>) {
	const lines: string[] = [];
	if (added.length) lines.push('**➕ NEW ATTENDANCE QUIZ ADDED**');
	if (removed.length) lines.push('**➖ QUIZZES REMOVED**');
	if (changed.length) {
		lines.push('**✏️ QUIZ UPDATED**');
		for (const [qid, diffs] of changed) {
			lines.push(`- quiz \`${qid}\``);
			for (const [idx, fields] of diffs) {
				const pretty: string[] = [];
				if ('<entry>' in fields) {
					const [ov, nv] = (fields as any)['<entry>'];
					pretty.push(`entry #${idx}: ${JSON.stringify(ov)} → ${JSON.stringify(nv)}`);
				} else {
					for (const [k, value] of Object.entries(fields)) {
						const [ov, nv] = value as [unknown, unknown];
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
	return `@everyone 📣 CANVAS CHANGES DETECTED\n${lines.join('\n')}`.slice(0, 1990);
}
async function postToDiscord(env: Env, content: string) {
	const url = `https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`;
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ content }),
	});
	if (!r.ok) {
		const body = await r.text().catch(() => '');
		throw new Error(`Discord post failed: ${r.status} ${r.statusText} - ${body.slice(0, 300)}`);
	}
}
function makeHeadersFromCookies(cookiesRaw: string) {
	const cookie = cookiesRaw
		.split(';').map(p => p.trim()).filter(Boolean).filter(p => p.includes('=')).join('; ');
	if (!cookie) throw new Error('Invalid cookies string.');
	return {
		'User-Agent': 'CanvasQuizOverridesDiffBot/1.0',
		'Accept': 'application/json',
		'Cookie': cookie,
	} as Record<string, string>;
}
async function fetchAllOverridesWithCookies(env: Env, cookiesRaw: string, etag?: string) {
	const headers = makeHeadersFromCookies(cookiesRaw);
	if (etag) headers['If-None-Match'] = etag;

	const url = new URL(`${env.BASE_URL}/api/v1/courses/${env.COURSE_ID}/quizzes/assignment_overrides`);
	url.searchParams.set('per_page', String(Number(env.PER_PAGE || 100)));

	const r = await fetch(url.toString(), { headers });
	if (r.status === 304) return { notModified: true as const };

	if (!r.ok) {
		const body = await r.text().catch(() => '');
		throw new Error(`Canvas fetch failed: ${r.status} ${r.statusText} - ${body.slice(0, 300)}`);
	}
	const newEtag = r.headers.get('etag') || '';
	let data: any = await r.json();
	if (Array.isArray(data)) data = { quiz_assignment_overrides: data };
	return { notModified: false as const, data, etag: newEtag };
}

const html = ``;

export class Poller {
	constructor(private state: DurableObjectState, private env: Env) { }

	private async getCookies(): Promise<string> {
		return (await this.state.storage.get<string>(COOKIE_KEY))?.trim() || '';
	}

	async fetch(req: Request) {
		const url = new URL(req.url);

		// 1) UI page
		if (url.pathname.endsWith('/')) {
			return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}


		// 2) START: accepts POST form (recommended), JSON, or ?cookies=
		if (url.pathname.endsWith('/start')) {
			let cookies = '';
			if (req.method === 'POST') {
				const ctype = req.headers.get('content-type') || '';
				if (ctype.includes('application/x-www-form-urlencoded')) {
					const form = await req.formData();
					cookies = String(form.get('cookies') || '');
				} else if (ctype.includes('application/json')) {
					const body = await req.json().catch(() => ({})) as { cookies?: string };
					cookies = String(body?.cookies || '');
				} else {
					const text = await req.text();
					try { cookies = String((JSON.parse(text) || {}).cookies || ''); }
					catch { cookies = text; }
				}
			} else {
				cookies = url.searchParams.get('cookies') || '';
			}
			cookies = cookies.trim();
			if (!cookies) return new Response('Missing cookies', { status: 400 });

			await this.state.storage.put(COOKIE_KEY, cookies);
			await this.state.storage.setAlarm(Date.now() + 1000); // fire soon
			return new Response('Started.');
		}

		// 3) STOP: de-arm the alarm
		if (url.pathname.endsWith('/stop')) {
			if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
			await this.state.storage.deleteAlarm();
			return new Response('Stopped.');
		}

		// 4) STATUS: show next alarm + cookie presence
		if (url.pathname.endsWith('/status')) {
			const next = await this.state.storage.getAlarm();
			const cookies = await this.state.storage.get(COOKIE_KEY) as string | undefined;

			const masked = cookies
				? cookies.length > 50
					? cookies.slice(0, 25) + ' … ' + cookies.slice(-15)
					: cookies
				: '';

			return new Response(
				JSON.stringify({
					hasCookies: !!cookies,
					cookiesMasked: masked,
					cookiesFull: cookies || '',
					nextAlarmISO: next ? new Date(next).toISOString() : null,
				}, null, 2),
				{ headers: { 'content-type': 'application/json' } }
			);
		}


		return new Response('Not found', { status: 404 });
	}

	// Poller: 30s cadence, America/Chicago timestamp, "no changes" only every 2 minutes
	async alarm() {
		try {
			const { STATE, COURSE_ID } = this.env;
			const etagKey = `etag_${COURSE_ID}`;
			const snapKey = `snapshot_${COURSE_ID}`;

			const [etag, snapshotStr, cookiesRaw] = await Promise.all([
				STATE.get(etagKey),
				STATE.get(snapKey),
				this.getCookies(),
			]);
			if (!cookiesRaw) {
				console.warn('[alarm] No cookies configured; skipping run.');
				return;
			}

			const oldIdx = snapshotStr ? JSON.parse(snapshotStr) : {};
			const res = await fetchAllOverridesWithCookies(this.env, cookiesRaw, etag || undefined);

			const maybePostNoChange = async () => {
				const nowMs = Date.now();
				const lastMs = (await this.state.storage.get<number>(NOCHANGE_KEY)) || 0;
				if (nowMs - lastMs < 120_000) return;
				const nowLocal = new Date(nowMs).toLocaleString('en-US', {
					timeZone: 'America/Chicago',
					hour: 'numeric',
					minute: '2-digit',
					hour12: true,
				});
				await postToDiscord(this.env, `Nothing as of ${nowLocal}`);
				await this.state.storage.put(NOCHANGE_KEY, nowMs);
			};

			if ('notModified' in res && res.notModified) {
				await maybePostNoChange();
			} else if (res.data && res.etag != null) {
				const newIdx = normalizePayloadToIndex(res.data);
				const { added, removed, changed } = computeChangesQuiz(oldIdx, newIdx);

				if (added.length || removed.length || changed.length) {
					const msg = renderChangeMessageQuiz(added, removed, changed);
					if (msg) await postToDiscord(this.env, msg);
					await Promise.all([
						STATE.put(snapKey, JSON.stringify(newIdx)),
						STATE.put(etagKey, res.etag),
					]);
					await this.state.storage.put(NOCHANGE_KEY, Date.now());
				} else {
					await STATE.put(etagKey, res.etag);
					await maybePostNoChange();
				}
			}
		} catch (err: any) {
			console.error('[alarm] Error:', err?.message || err);
		} finally {
			const intervalMs = Math.max(5, Number(this.env.INTERVAL_SEC || 30)) * 1000;
			await this.state.storage.setAlarm(Date.now() + intervalMs);
		}
	}
}

// Worker entrypoint — proxies the four routes to the singleton DO
export default {
	async fetch(req: Request, env: Env) {
		const url = new URL(req.url);
		const id = env.POLLER.idFromName(`course-${env.COURSE_ID}`);
		const stub = env.POLLER.get(id);

		if (url.pathname === '/') return stub.fetch('https://poller.internal/');
		if (url.pathname === '/start') return stub.fetch('https://poller.internal/start', req);
		if (url.pathname === '/stop') return stub.fetch('https://poller.internal/stop', req);
		if (url.pathname === '/status') return stub.fetch('https://poller.internal/status');

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
