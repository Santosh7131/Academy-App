import { randomInt } from 'node:crypto';
import { APP_ID, APP_NAME } from './brand.ts';
import { pool, q1, type Db } from './db.ts';
import { bad } from './http.ts';
import { groupClassSql } from './levels.ts';

// A group's or a course's join link. Its code is ten characters from the join-code alphabet (no 0, O, 1 or I), random
// enough (about 50 bits) that nobody can guess another group's, so showing what a link is for, to anyone who has it,
// gives nothing away. A student who opens it asks to join; a tutor lets them in (routes/links.ts).

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_CODE = /^[A-HJ-NP-Z2-9]{10}$/;

export const newLinkCode = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('');

/** "KR7Q4-MPAXZ": how a link's code is shown, to type or read out. */
export const showLinkCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

/** A link code from a path: the ten characters, in any case, or nothing. */
export const linkCodeIn = (raw: string) => {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return LINK_CODE.test(s) ? s : null;
};

/**
 * What a student typed or pasted to join: a tuition's six-character code, a link's ten-character code, or a whole link or
 * message with one in it. Any case, spaces and dashes are fine.
 */
export function readJoin(raw: unknown): { kind: 'tuition' | 'link'; code: string } {
  const text = typeof raw === 'string' ? raw.slice(0, 500) : '';
  const fromLink = /\/(?:j|join)\/([A-Za-z0-9-]{6,20})/.exec(text)?.[1];
  const tries = [fromLink, text, text.trim().split(/\s+/).pop()].filter((x): x is string => !!x);
  for (const t of tries) {
    const s = t.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[A-HJ-NP-Z2-9]{6}$/.test(s)) return { kind: 'tuition', code: s };
    if (LINK_CODE.test(s)) return { kind: 'link', code: s };
  }
  throw bad('That code is not right. Check it with your tutor, or open the link they sent.', 'invalid_code');
}

export type LinkInfo = {
  id: string;
  code: string;
  tuition_id: string;
  tuition_name: string;
  join_open: boolean;
  group_id: string | null;
  class_level: number | null;
  class_label: string | null;
  subject_id: string | null;
  subject_name: string | null;
  course_id: string | null;
  course_name: string | null;
};

/** What a link lets a student ask to join: its tuition, and its group (class and subject) or course. */
export const linkByCode = (code: string, db: Db = pool) =>
  q1<LinkInfo>(
    `select l.id, l.code, l.tuition_id, t.name as tuition_name, t.join_open,
            l.group_id, g.class_level, g.subject_id, s.name as subject_name, l.course_id, co.name as course_name,
            case when g.class_level is not null then ${groupClassSql('g.class_level', 'l.tuition_id')} end as class_label
       from join_links l join tuitions t on t.id = l.tuition_id
       left join groups g on g.id = l.group_id
       left join subjects s on s.id = g.subject_id
       left join courses co on co.id = l.course_id
      where l.code = $1`,
    [code],
    db,
  );

/** "10th Maths", or the course's name. */
export const targetLabel = (l: { class_label: string | null; subject_name: string | null; course_name: string | null }) =>
  l.course_name ?? `${l.class_label ?? ''} ${l.subject_name ?? ''}`.trim();

type Target = { group_id: string } | { course_id: string };
const column = (t: Target) => ('group_id' in t ? { col: 'group_id', id: t.group_id } : { col: 'course_id', id: t.course_id });

/** A group's or course's link, made the first time a tutor asks for it. */
export async function linkFor(tuition: string, target: Target, by: string, db: Db = pool): Promise<{ code: string; created_at: Date }> {
  const { col, id } = column(target);
  for (let i = 0; i < 10; i++) {
    const have = await q1<{ code: string; created_at: Date }>(`select code, created_at from join_links where ${col} = $1`, [id], db);
    if (have) return have;
    // Nothing is made when another tutor made it at the same moment, or the code was already taken: then look again.
    const made = await q1<{ code: string; created_at: Date }>(
      `insert into join_links (tuition_id, code, ${col}, created_by) values ($1, $2, $3, $4) on conflict do nothing returning code, created_at`,
      [tuition, newLinkCode(), id, by],
      db,
    );
    if (made) return made;
  }
  throw new Error('no free link code after ten tries');
}

/** A new code for a group's or course's link: the old link and its QR code stop working at once. */
export async function newLinkFor(tuition: string, target: Target, by: string, db: Db = pool): Promise<{ code: string; created_at: Date }> {
  const { col, id } = column(target);
  await linkFor(tuition, target, by, db);
  for (let i = 0; i < 10; i++) {
    try {
      const row = await q1<{ code: string; created_at: Date }>(
        `update join_links set code = $2, created_at = now(), created_by = $3 where ${col} = $1 returning code, created_at`,
        [id, newLinkCode(), by],
        db,
      );
      if (row) return row;
    } catch (e: any) {
      if (e.code !== '23505') throw e; // the new code was already taken: draw another
    }
  }
  throw new Error('no free link code after ten tries');
}

/**
 * The address a link opens: JOIN_LINK_BASE when set (an address of the product's own that serves this API's /j/ pages),
 * else this API's own address, as the request reached it.
 */
export function linkUrl(code: string, requestUrl: string): string {
  const base = (process.env.JOIN_LINK_BASE ?? '').trim().replace(/\/+$/, '') || new URL(requestUrl).origin;
  return `${base}/j/${code}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/**
 * The page a link opens in a phone's browser (a QR code scanned with the camera opens it too). It names the tuition and
 * the group or course, opens the app at its join screen (Android's intent link, which falls back to the download page
 * when the app is not on the phone), and says how to type the code instead. No scripts, no cookies, nothing that moves.
 */
export function joinPage(link: LinkInfo | undefined, code: string): string {
  const download = (process.env.APP_DOWNLOAD_URL ?? '').trim();
  const fallback = /^https:\/\//.test(download) ? `S.browser_fallback_url=${encodeURIComponent(download)};` : '';
  const open = `intent://app/join/${code}#Intent;scheme=${APP_ID};package=${APP_ID};${fallback}end`;
  const body = link
    ? `<p class="kicker">${esc(APP_NAME)}</p>
       <h1>${esc(link.tuition_name)}</h1>
       <p class="target">${esc(targetLabel(link))}</p>
       <p>You have been invited to join. Open the app to ask; your tutor lets you in.</p>
       <a class="button" href="${esc(open)}">Open in ${esc(APP_NAME)}</a>
       ${/^https:\/\//.test(download) ? `<a class="button plain" href="${esc(download)}">Get the app</a>` : `<p class="small">No app yet? Ask your tutor for the download link.</p>`}
       <p class="small">Or open the app, choose Join a tuition, and type <b>${esc(showLinkCode(code))}</b>.</p>`
    : `<p class="kicker">${esc(APP_NAME)}</p>
       <h1>This link has stopped working</h1>
       <p>Your tutor may have made a new one. Ask them for the new link or QR code.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(link ? `Join ${link.tuition_name}` : APP_NAME)}</title>
<style>
:root{--ink:#0E0E11;--paper:#FAFAFB;--muted:#5B5B66;--line:#E4E4E9;--card:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--ink:#F3F3F6;--paper:#0C0C0F;--muted:#A0A0AB;--line:#2A2A31;--card:#16161B}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:48px 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 22px}
.kicker{margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
h1{margin:0;font-size:28px;line-height:1.15;letter-spacing:-.02em}.target{margin:6px 0 18px;font-size:18px;font-weight:600}
p{margin:0 0 16px;color:var(--muted)}.small{font-size:14px;margin-top:16px}b{color:var(--ink);letter-spacing:.06em}
.button{display:block;text-align:center;text-decoration:none;font-weight:600;border-radius:14px;padding:14px 16px;margin-top:10px;background:var(--ink);color:var(--paper)}
.button.plain{background:transparent;color:var(--ink);border:1px solid var(--line)}
</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}
