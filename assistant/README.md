# Assistant server

A small Cloudflare Worker that sits between the assistant page
(`web/assistant.html`) and the Claude API. It:

- keeps the Anthropic API key secret (it never reaches anyone's browser),
- only answers people with an access code, and only pages from the site,
- limits each address to 30 requests a minute, so codes can't be guessed,
- streams Claude's answer back as it's written.

Claude Opus 5.5 at low effort answers, with web search for current
information. Questions can include photos (HEIC works) and PDFs.

## Set up (once)

1. Make a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. Make an API key at https://platform.claude.com/settings/keys. Under
   Settings → Limits, set a monthly spend limit you're comfortable with.
3. Pick an access code for each person. Long is good: they only type it once
   per device ("Remember me"). One way to make one:

   ```bash
   openssl rand -hex 6
   ```

4. In this folder:

   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ACCESS_CODES
   npx wrangler deploy
   ```

   `ACCESS_CODES` is a list of `name:code` pairs, e.g.
   `Zarif:3f9a1c…,Mom:8b2e70…,Dad:c41d9e…`. The name is how the assistant greets
   them. Codes must be at least 8 characters.

5. `deploy` prints the Worker's address
   (`https://pdf-tools-assistant.<you>.workers.dev`). Put it in `API_URL` at the
   top of `web/assistant.js` and in `connect-src` in `web/assistant.html`,
   then push.

## Change things later

- Add or remove a person: run `npx wrangler secret put ACCESS_CODES` again with
  the new list. Removing someone's code signs them out everywhere.
- Different model: change `MODEL` in `wrangler.toml` and run `npx wrangler deploy`.
- Logs: `npx wrangler tail`.

## Cost

Cloudflare's free plan covers 100,000 requests a day. Claude is billed by
Anthropic per use: a typical question and answer is a few cents or less, a
photo or a long PDF a little more, and each web search adds about a cent.

## Try it locally without an API key

`test/mock-claude.py` stands in for the Claude API and streams a fixed answer.

```bash
python3 test/mock-claude.py 8799
```

Create `.dev.vars` (never committed) with:

```
ANTHROPIC_API_KEY="anything"
ACCESS_CODES="Tester:local-test-code-123"
ANTHROPIC_BASE_URL="http://127.0.0.1:8799"
```

Then run `npx wrangler dev --port 8787` and open the site from
`python3 scripts/serve.py 8766`: on localhost the page talks to port 8787.
