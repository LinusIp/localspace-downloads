// The localSpace download counter.
//
// GET /download/windows and /download/portable add 1 to (day, file) and then
// redirect to the file on GitHub. That count is the only thing stored: no
// address, no browser name, no cookie, no log line. Link-preview bots,
// crawlers and browser prefetches are sent a small page instead of the file
// and are not counted. GET /stats shows the counts to whoever knows the key.

export const FILES = {
  windows: "WINDOWS_URL",
  portable: "PORTABLE_URL",
};

// Matched against the User-Agent header, which is read here and never stored.
const BOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|skype|vkshare|viber|embedly|iframely|pinterest|mastodon|bitlybot|linkedin|yandex|baidu|duckduck|applebot|bingpreview|google-?inspection/i;

export function isBot(request) {
  const agent = request.headers.get("User-Agent") || "";
  return BOT.test(agent);
}

export function isPrefetch(request) {
  const purpose = `${request.headers.get("Sec-Purpose") || ""} ${request.headers.get("Purpose") || ""} ${request.headers.get("X-Moz") || ""}`;
  return /prefetch|prerender/i.test(purpose);
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export async function count(db, file, day) {
  await db
    .prepare(
      "INSERT INTO downloads (day, file, count) VALUES (?1, ?2, 1) ON CONFLICT (day, file) DO UPDATE SET count = count + 1",
    )
    .bind(day, file)
    .run();
}

const NO_STORE = { "Cache-Control": "no-store" };

function page(status, title, body, extra = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;color:#1c1e20;max-width:44rem;margin:48px auto;padding:0 16px}table{border-collapse:collapse;width:100%}th,td{text-align:right;padding:6px 10px;border-bottom:1px solid #e6e4e1}th:first-child,td:first-child{text-align:left}a{color:#1d7a55}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...extra },
  });
}

// Compares two strings in time that does not depend on where they differ.
async function sameKey(given, key) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(key)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// The browser's own sign-in box: any user name, the key as the password.
export async function authorised(request, key) {
  if (!key) return false;
  const header = request.headers.get("Authorization") || "";
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header);
  if (!match) return false;
  let decoded;
  try {
    decoded = atob(match[1]);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return sameKey(decoded.slice(colon + 1), key);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function stats(request, env) {
  if (!(await authorised(request, env.STATS_KEY))) {
    return page(401, "Sign in", "<p>This page needs the key.</p>", {
      "WWW-Authenticate": 'Basic realm="localSpace downloads", charset="UTF-8"',
    });
  }
  const { results } = await env.DB.prepare(
    "SELECT day, file, count FROM downloads ORDER BY day DESC",
  ).all();
  const days = new Map();
  const totals = { windows: 0, portable: 0 };
  for (const row of results) {
    if (!days.has(row.day)) days.set(row.day, { windows: 0, portable: 0 });
    if (row.file in totals) {
      days.get(row.day)[row.file] = row.count;
      totals[row.file] += row.count;
    }
  }
  const rows = [...days]
    .map(
      ([day, c]) =>
        `<tr><td>${escape(day)}</td><td>${c.windows}</td><td>${c.portable}</td><td>${c.windows + c.portable}</td></tr>`,
    )
    .join("");
  const body = `<h1>Downloads</h1><p>Clicks on Download per day (UTC), without bots and prefetches. GitHub's own count on the release page shows finished downloads.</p><table><thead><tr><th>Day</th><th>Installer</th><th>Portable zip</th><th>Both</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No downloads yet.</td></tr>'}</tbody><tfoot><tr><th>All days</th><th>${totals.windows}</th><th>${totals.portable}</th><th>${totals.windows + totals.portable}</th></tr></tfoot></table>`;
  return page(200, "Downloads", body);
}

async function download(request, env, file, now) {
  const target = env[FILES[file]];
  if (!target) {
    return page(503, "Not published yet", "<p>This file is not published yet.</p>");
  }
  if (isBot(request) || isPrefetch(request)) {
    return page(
      200,
      "localSpace for Windows",
      `<p><a href="${escape(target)}">localSpace for Windows</a></p>`,
    );
  }
  if (request.method === "GET") {
    await count(env.DB, file, today(now));
  }
  return new Response(null, { status: 302, headers: { Location: target, ...NO_STORE } });
}

export async function handle(request, env, now = new Date()) {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const file = /^\/download\/([a-z]+)\/?$/.exec(pathname)?.[1];
  if (file && Object.hasOwn(FILES, file)) return download(request, env, file, now);
  if (pathname === "/stats" || pathname === "/stats/") return stats(request, env);
  if (pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  }
  return page(404, "Not found", "<p>Not found.</p>");
}

export default {
  fetch: (request, env) => handle(request, env),
};
