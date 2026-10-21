# Leana Dardano — interactive CV

A static CV page with a chat module. The chat is answered by Google Gemini,
called from a small serverless function (`api/chat.js`) so visitors never
talk to Google directly — this works from anywhere, including places where
AI chat products are geo-blocked (e.g. Hong Kong, mainland China), with no
VPN and no account needed on the visitor's side.

This whole setup runs on free tiers: Gemini's API free tier (no credit
card) and Vercel's free hosting tier. There is no cost to run this, only
usage caps (see "Free-tier limits" below).

## How it's wired

- `index.html` — the whole page, plain HTML/CSS/JS, no build step.
- `api/chat.js` — a Vercel serverless function. It holds the persona/rules
  prompt (`lib/context.js`) and your Gemini API key, forwards the
  conversation to Gemini, and returns the answer.
- `lib/context.js` — the one file to edit when a fact about you changes.
  It's the single source of truth the chat agent is allowed to use.

Nothing about this needs a build step or a framework — it's deployed as-is.

## One-time setup

### 1. Get a free Gemini API key

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   and sign in with any Google account.
2. Click **Create API key**. No credit card, no billing setup — the free
   tier is genuinely free, just rate-limited (plenty for a CV chatbot; see
   "Free-tier limits" below).
3. Copy the key — you'll paste it into Vercel below, not into this repo.

### 2. Put the code on GitHub

```bash
git init
git add -A
git commit -m "Initial version"
```

Then create a new (private is fine) repository on GitHub and push:

```bash
git remote add origin <your-new-repo-url>
git branch -M main
git push -u origin main
```

### 3. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign up (GitHub login is
   easiest).
2. **Add New → Project**, import the GitHub repo you just pushed.
3. Framework preset: leave it as **Other** — no build command needed.
4. Before clicking Deploy, open **Environment Variables** and add:
   - `GEMINI_API_KEY` = the key from step 1.
5. Deploy. Vercel gives you a URL like `leana-cv-chatbot.vercel.app` —
   that's the link to put on your CV and in applications. It works from
   anywhere, no VPN.

You can also point a custom domain at it later from the Vercel project
settings if you want something like `leanadardano.com`.

## Updating content later

- **A fact about your background** (CV or the "shareable" context): edit
  `lib/context.js` for what the chat agent can say, and the matching
  section of `index.html` for what's visibly printed on the page.
- **Visible CV text/design**: edit `index.html` directly.
- After editing, `git commit` and `git push` — Vercel redeploys
  automatically on every push to `main`.

## Local preview (optional)

You don't need Node installed to just look at the static page:

```bash
python3 -m http.server 4173
```

then open `http://localhost:4173`. The chat module won't work this way
(no `/api/chat` without Vercel or Node) — that part only works once it's
deployed, or if you install the [Vercel CLI](https://vercel.com/docs/cli)
and run `vercel dev` locally with a `.env` file (copy `.env.example` to
`.env` and fill in your key — `.env` is git-ignored, never commit it).

## Free-tier limits

- **Gemini** (`gemini-2.0-flash`, free tier): a per-minute and per-day
  request cap that's generous for a personal CV chatbot (far more than a
  realistic number of recruiters chatting with it at once). If you ever
  hit the ceiling during a traffic spike, requests just get a normal
  "rate limited" error — nothing breaks, nothing bills you. Check current
  numbers any time at [ai.google.dev/pricing](https://ai.google.dev/pricing)
  under "Free tier".
- **Vercel** (Hobby plan): generous free bandwidth/invocations for this
  kind of low-traffic static site + one small function — no card needed
  either.

If this ever outgrows the free tiers (unlikely for a CV), the fix is to
enable billing on whichever side hit its cap — no code changes needed.

## Abuse protection

`api/chat.js` keeps a simple per-IP rate limit (20 messages / 10 minutes)
and caps each reply's length — enough to blunt casual abuse without adding
extra infrastructure. Since this runs on a free tier, the worst case from
abuse is hitting the free-tier ceiling (temporary 429s for everyone), not
an unexpected bill.
