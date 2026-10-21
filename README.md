# localspace-downloads

The download counter behind the Download buttons on the localSpace site.

- `GET /download/windows` and `GET /download/portable` add 1 to a counter for
  that day (UTC) and that file, then redirect to the file on GitHub
  (`LinusIp/localSpace-releases`).
- **That count is all it stores.** No IP address, no browser name, no cookie,
  no request log ([`schema.sql`](schema.sql) is the whole database).
- Link-preview bots (Telegram, WhatsApp, Slack and others), crawlers and
  browser prefetches get a small page with the link instead of the file, and
  are not counted. A `HEAD` request is redirected but not counted.
- `GET /stats` shows downloads per day. It opens with the browser's sign-in
  box: any user name, the key as the password.

## Run the tests

```
npm install
npm test
```

## Deploy (by the founder, from their own PC)

Once:

```
npx wrangler login
npx wrangler d1 create localspace-downloads
```

Put the printed `database_id` into `wrangler.toml`, then:

```
npx wrangler d1 execute localspace-downloads --remote --file schema.sql
npx wrangler secret put STATS_KEY
```

When a release is published, set `WINDOWS_URL` and `PORTABLE_URL` in
`wrangler.toml` to its two files, and deploy:

```
npx wrangler deploy
```

Until those two values are set, both links answer "not published yet" and
count nothing.
