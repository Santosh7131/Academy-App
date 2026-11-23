// Checks Google sign-in's token check (lib/google.ts) and a join link's code, address and page (lib/join-links.ts), with no
// database and no network: tokens are signed here with a key made for the run, which the check is told to trust in place of
// Google's. The whole sign-in and joining flow, against a database, is tools/join-links-test.ts.
// Usage: node tools/google-test.ts
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

// The modules make a database pool when loaded; nothing here sends it a query.
process.env.DATABASE_URL ||= 'postgres://nobody@127.0.0.1:9/none';
delete process.env.JOIN_LINK_BASE;
delete process.env.APP_DOWNLOAD_URL;
const { useGoogleTestKeys, verifyGoogleToken } = await import('../api/src/lib/google.ts');
const { joinPage, linkCodeIn, linkUrl, newLinkCode, readJoin, showLinkCode, targetLabel } = await import('../api/src/lib/join-links.ts');
const { APP_ID } = await import('../api/src/lib/brand.ts');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// ------------------------------------------------------------------------------------------------ Google's ID tokens
const mine = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
useGoogleTestKeys([{ ...mine.publicKey.export({ format: 'jwk' }), kid: 'run-key', alg: 'RS256', use: 'sig' } as any]);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'run-key', typ: 'JWT' }, key: KeyObject = mine.privateKey) {
  const h = b64(header);
  const p = b64(claims);
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
const AUD = 'run-client.apps.googleusercontent.com';
const now = Math.floor(Date.now() / 1000);
const claims = { iss: 'https://accounts.google.com', aud: AUD, sub: '110248495921238986420', exp: now + 600, iat: now, name: 'Asha Raman', email: 'asha@example.com', email_verified: true };

async function outcome(t: string, audiences = [AUD]) {
  try {
    return { ok: true as const, who: await verifyGoogleToken(t, audiences) };
  } catch (e: any) {
    return { ok: false as const, status: e.status, code: e.code };
  }
}
const refused = (r: Awaited<ReturnType<typeof outcome>>) => !r.ok && r.status === 401 && r.code === 'google_failed';

const good = await outcome(token(claims));
check('a good token says whose it is', good.ok && good.who.sub === claims.sub && good.who.name === 'Asha Raman', good);
check('and nothing else: no email address is passed on', good.ok && Object.keys(good.who).sort().join() === 'name,sub', good);
check('the issuer may be written without https', (await outcome(token({ ...claims, iss: 'accounts.google.com' }))).ok);
check('a token for several clients, this one among them, is taken', (await outcome(token({ ...claims, aud: ['other', AUD] }))).ok);
check('a second client id in the list is taken too', (await outcome(token({ ...claims, aud: 'android-client' }), [AUD, 'android-client'])).ok);
const given = await outcome(token({ ...claims, name: undefined, given_name: 'Asha' }));
check('with no full name, the first name is used', given.ok && given.who.name === 'Asha', given);
const nameless = await outcome(token({ ...claims, name: '  ', given_name: undefined }));
check('with no name at all, the name is empty', nameless.ok && nameless.who.name === null, nameless);
const longName = await outcome(token({ ...claims, name: 'A'.repeat(200) }));
check('a long name is cut to 60 characters', longName.ok && longName.who.name?.length === 60, longName);
check('a token that ran out 30 seconds ago is still taken (clocks drift)', (await outcome(token({ ...claims, exp: now - 30 }))).ok);

check('a token for another app is refused', refused(await outcome(token({ ...claims, aud: 'someone-else' }))));
check('a token from another issuer is refused', refused(await outcome(token({ ...claims, iss: 'https://evil.example.com' }))));
check('a token that ran out two minutes ago is refused', refused(await outcome(token({ ...claims, exp: now - 120 }))));
check('a token with no end time is refused', refused(await outcome(token({ ...claims, exp: undefined }))));
check('a token whose account number has odd characters is refused', refused(await outcome(token({ ...claims, sub: '../../admin' }))));
check('a token with no account number is refused', refused(await outcome(token({ ...claims, sub: undefined }))));
check('a token signed with another key is refused', refused(await outcome(token(claims, undefined, stranger.privateKey))));
check('a token naming a key nobody knows is refused', refused(await outcome(token(claims, { alg: 'RS256', kid: 'unknown-key' }))));
check('a token with no key named is refused', refused(await outcome(token(claims, { alg: 'RS256' }))));
check('an unsigned token ("alg": "none") is refused', refused(await outcome(`${b64({ alg: 'none', kid: 'run-key' })}.${b64(claims)}.`)));
check('a token claiming another kind of signature is refused', refused(await outcome(token(claims, { alg: 'HS256', kid: 'run-key' }))));
const [h, , s] = token(claims).split('.');
check('a token changed after it was signed is refused', refused(await outcome(`${h}.${b64({ ...claims, sub: '999' })}.${s}`)));
check('junk is refused', refused(await outcome('not-a-token')));
check('three parts of junk are refused', refused(await outcome('a.b.c')));
check('a huge token is refused before any work', refused(await outcome('a'.repeat(9000))));
check('with no client ids, every token is refused', refused(await outcome(token(claims), [])));

// ------------------------------------------------------------------------------------------------ join codes
const joined = (raw: unknown) => {
  try {
    return readJoin(raw);
  } catch (e: any) {
    return { error: e.code as string };
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check('a tuition code, typed with its dash', same(joined('KR7-4MQ'), { kind: 'tuition', code: 'KR74MQ' }), joined('KR7-4MQ'));
check('a tuition code in lower case with spaces', same(joined(' kr7 4mq '), { kind: 'tuition', code: 'KR74MQ' }), joined(' kr7 4mq '));
check('a link code, as shown', same(joined('KR7Q4-MPAXZ'), { kind: 'link', code: 'KR7Q4MPAXZ' }), joined('KR7Q4-MPAXZ'));
check('a whole link', same(joined('https://join.example.com/j/KR7Q4MPAXZ'), { kind: 'link', code: 'KR7Q4MPAXZ' }));
check('the app\'s own link', same(joined(`${APP_ID}://app/join/kr7q4mpaxz`), { kind: 'link', code: 'KR7Q4MPAXZ' }));
check('a message with a link in it', same(joined('Join Class 10 Maths: https://join.example.com/j/KR7Q4MPAXZ see you'), { kind: 'link', code: 'KR7Q4MPAXZ' }));
check('a message that ends with a tuition code', same(joined('Our code is KR7-4MQ'), { kind: 'tuition', code: 'KR74MQ' }));
check('letters that are never in a code (0, O, 1, I) are refused', same(joined('KR0-4MQ'), { error: 'invalid_code' }));
check('a code of the wrong length is refused', same(joined('KR7Q4MPAX'), { error: 'invalid_code' }));
check('nothing is refused', same(joined(''), { error: 'invalid_code' }));
check('a number is refused', same(joined(123456), { error: 'invalid_code' }));
check('a link code is read from a path, in any case', linkCodeIn('kr7q4-mpaxz') === 'KR7Q4MPAXZ');
check('a path that is no link code gives nothing', linkCodeIn('1001') === null && linkCodeIn('KR7Q4MPAX0') === null && linkCodeIn('') === null);
check('a link code is shown in two halves', showLinkCode('KR7Q4MPAXZ') === 'KR7Q4-MPAXZ');
const drawn = Array.from({ length: 2000 }, () => newLinkCode());
check('new link codes use only the code letters, ten of them', drawn.every((c) => /^[A-HJ-NP-Z2-9]{10}$/.test(c)), drawn.find((c) => !/^[A-HJ-NP-Z2-9]{10}$/.test(c)));
check('and 2000 of them are all different', new Set(drawn).size === drawn.length);

// ------------------------------------------------------------------------------------------------ the link and its page
check('a link is on the API\'s own address when nothing else is set', linkUrl('KR7Q4MPAXZ', 'http://127.0.0.1:18787/teacher/groups/9/x/link') === 'http://127.0.0.1:18787/j/KR7Q4MPAXZ');
process.env.JOIN_LINK_BASE = 'https://join.example.com/';
check('JOIN_LINK_BASE gives links an address of the product\'s own', linkUrl('KR7Q4MPAXZ', 'https://api.example.com/x') === 'https://join.example.com/j/KR7Q4MPAXZ');
delete process.env.JOIN_LINK_BASE;

const link = {
  id: 'x', code: 'KR7Q4MPAXZ', tuition_id: 't', tuition_name: 'Sri <Vidya> & "Sons"', join_open: true,
  group_id: 'g', class_level: 10, class_label: 'Class 10', subject_id: 's', subject_name: 'Maths', course_id: null, course_name: null,
};
check('a group link is for its class and subject', targetLabel(link) === 'Class 10 Maths');
check('a course link is for the course', targetLabel({ ...link, class_label: null, subject_name: null, course_name: 'NEET Crash' }) === 'NEET Crash');
const page = joinPage(link, link.code);
check('the page names the tuition, with its name made safe', page.includes('Sri &lt;Vidya&gt; &amp; &quot;Sons&quot;') && !page.includes('<Vidya>'));
check('the page says what the link is for, and shows the code to type', page.includes('Class 10 Maths') && page.includes('KR7Q4-MPAXZ'));
check('the page opens the app by its id, at the link', page.includes(`intent://app/join/KR7Q4MPAXZ#Intent;scheme=${APP_ID};package=${APP_ID};end`), page.match(/intent:[^"]*/)?.[0]);
check('the page runs no script', !/<script/i.test(page) && !/\son\w+=/i.test(page));
check('with no download page set, no Get the app button', !page.includes('Get the app'));
process.env.APP_DOWNLOAD_URL = 'https://example.com/get?app=1';
const withDownload = joinPage(link, link.code);
check('with a download page, the app link falls back to it, and a button offers it',
  withDownload.includes(`S.browser_fallback_url=${encodeURIComponent('https://example.com/get?app=1')};`) && withDownload.includes('Get the app'));
process.env.APP_DOWNLOAD_URL = 'javascript:alert(1)';
check('a download address that is not https is never used', !joinPage(link, link.code).includes('javascript:'));
delete process.env.APP_DOWNLOAD_URL;
const gonePage = joinPage(undefined, '');
check('a link that stopped working opens a page that says so', gonePage.includes('This link has stopped working') && !gonePage.includes('intent://'));
check('the page follows the phone\'s light or dark setting', page.includes('prefers-color-scheme:dark'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
