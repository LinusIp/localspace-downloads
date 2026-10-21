import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";

// A stand-in for D1 that records every statement, so a test can see that
// nothing but (day, file) is ever written.
function fakeDb() {
  const rows = new Map();
  const writes = [];
  return {
    rows,
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              writes.push({ sql, args });
              const key = `${args[0]}|${args[1]}`;
              rows.set(key, (rows.get(key) || 0) + 1);
            },
          };
        },
        async all() {
          const results = [...rows].map(([k, count]) => {
            const [day, file] = k.split("|");
            return { day, file, count };
          });
          results.sort((a, b) => b.day.localeCompare(a.day));
          return { results };
        },
      };
    },
  };
}

const URLS = {
  WINDOWS_URL: "https://github.com/LinusIp/localSpace-releases/releases/download/vX/setup.exe",
  PORTABLE_URL: "https://github.com/LinusIp/localSpace-releases/releases/download/vX/portable.zip",
};
const NOW = new Date("2026-11-02T10:00:00Z");
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

function env(extra = {}) {
  return { DB: fakeDb(), STATS_KEY: "the-right-key", ...URLS, ...extra };
}

function get(path, headers = {}, method = "GET") {
  return new Request(`https://localspace.locallabs-io.workers.dev${path}`, {
    method,
    headers: { "User-Agent": CHROME, ...headers },
  });
}

function basic(password, user = "me") {
  return { Authorization: `Basic ${btoa(`${user}:${password}`)}` };
}

test("the installer link counts once and redirects to the GitHub file", async () => {
  const e = env();
  const res = await handle(get("/download/windows"), e, NOW);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), URLS.WINDOWS_URL);
  assert.equal(e.DB.rows.get("2026-11-02|windows"), 1);
});

test("the portable link counts on its own", async () => {
  const e = env();
  await handle(get("/download/portable"), e, NOW);
  await handle(get("/download/portable"), e, NOW);
  assert.equal(e.DB.rows.get("2026-11-02|portable"), 2);
  assert.equal(e.DB.rows.has("2026-11-02|windows"), false);
});

test("only the day and the file are written, nothing about the visitor", async () => {
  const e = env();
  await handle(get("/download/windows", { "CF-Connecting-IP": "203.0.113.7" }), e, NOW);
  assert.equal(e.DB.writes.length, 1);
  assert.deepEqual(e.DB.writes[0].args, ["2026-11-02", "windows"]);
});

test("no cookie is set", async () => {
  const res = await handle(get("/download/windows"), env(), NOW);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

for (const agent of [
  "TelegramBot (like TwitterBot)",
  "WhatsApp/2.23.20.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "facebookexternalhit/1.1",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; YandexBot/3.0)",
]) {
  test(`a link preview or crawler is not counted and not sent the file: ${agent}`, async () => {
    const e = env();
    const res = await handle(get("/download/windows", { "User-Agent": agent }), e, NOW);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Location"), null);
    assert.equal(e.DB.writes.length, 0);
  });
}

test("a browser prefetch is not counted", async () => {
  const e = env();
  const res = await handle(get("/download/windows", { "Sec-Purpose": "prefetch" }), e, NOW);
  assert.equal(res.status, 200);
  assert.equal(e.DB.writes.length, 0);
});

test("a HEAD request is redirected but not counted", async () => {
  const e = env();
  const res = await handle(get("/download/windows", {}, "HEAD"), e, NOW);
  assert.equal(res.status, 302);
  assert.equal(e.DB.writes.length, 0);
});

test("other methods are refused", async () => {
  const e = env();
  const res = await handle(get("/download/windows", {}, "POST"), e, NOW);
  assert.equal(res.status, 405);
  assert.equal(e.DB.writes.length, 0);
});

test("before the file is published, nothing is counted and nothing redirects", async () => {
  const e = env({ WINDOWS_URL: "" });
  const res = await handle(get("/download/windows"), e, NOW);
  assert.equal(res.status, 503);
  assert.equal(e.DB.writes.length, 0);
});

test("an unknown file is not found and not counted", async () => {
  const e = env();
  const res = await handle(get("/download/linux"), e, NOW);
  assert.equal(res.status, 404);
  assert.equal(e.DB.writes.length, 0);
});

test("stats with the right key shows the counts", async () => {
  const e = env();
  await handle(get("/download/windows"), e, NOW);
  await handle(get("/download/portable"), e, NOW);
  const res = await handle(get("/stats", basic("the-right-key")), e, NOW);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<td>2026-11-02<\/td><td>1<\/td><td>1<\/td><td>2<\/td>/);
});

test("stats without a key asks for one and shows nothing", async () => {
  const e = env();
  await handle(get("/download/windows"), e, NOW);
  const res = await handle(get("/stats"), e, NOW);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate"), /^Basic /);
  assert.doesNotMatch(await res.text(), /2026-11-02/);
});

test("stats with a wrong key is refused", async () => {
  const res = await handle(get("/stats", basic("not-the-key")), env(), NOW);
  assert.equal(res.status, 401);
});

test("stats with the key as the user name instead of the password is refused", async () => {
  const res = await handle(get("/stats", basic("", "the-right-key")), env(), NOW);
  assert.equal(res.status, 401);
});

test("stats is refused for everyone while no key has been set", async () => {
  const res = await handle(get("/stats", basic("")), env({ STATS_KEY: undefined }), NOW);
  assert.equal(res.status, 401);
});

test("stats with a broken sign-in header is refused", async () => {
  const res = await handle(get("/stats", { Authorization: "Basic %%%" }), env(), NOW);
  assert.equal(res.status, 401);
});

test("search engines are asked to stay out", async () => {
  const res = await handle(get("/robots.txt"), env(), NOW);
  assert.equal(await res.text(), "User-agent: *\nDisallow: /\n");
});
