# Causality Engine — website

The public site for CE, including a browser demo that runs **the real engine**.

Nothing in the demo is scripted. When it shows grain at `13.13` and a state hash
starting `5404d32e`, CE computed both in the visitor's browser — the same values
the CI runners produce.

---

## Run locally

The site imports CE from the parent repository's build output, so build the
engine first:

```bash
# from the repo root
npm install
npm run build          # produces dist/api/product.js

cd web
npm install
npm run dev            # http://localhost:5173
```

## Build

```bash
cd web
npm run build          # type-check, then bundle to web/dist
npm run preview        # serve the built output
```

Output is roughly 26 KB HTML, 20 KB CSS, 12 KB site JS and 63 KB engine JS
(≈35 KB gzipped in total).

---

## How CE runs in a browser

CE's `stateHash`, `traceHash` and event-id functions are **synchronous** — they
run inside the tick loop and their output is part of world identity. The browser's
`crypto.subtle.digest()` is asynchronous and cannot be substituted.

So `vite.config.ts` aliases `node:crypto` to `src/node-crypto-shim.ts`, a
dependency-free synchronous SHA-256. CE's two importers (`core/hash.ts`,
`core/events.ts`) resolve to the shim at bundle time.

**No engine source is modified.** CE is research-frozen; this is a build concern.

### Why you can trust the numbers

Three checks, all in the parent repo:

```bash
node scripts/verify-shim.mjs           # shim vs node:crypto        30 assertions
node scripts/verify-browser-parity.mjs # real engine via the shim   30 assertions
node scripts/verify-web-demo.mjs       # bundled site in Chromium   37 assertions
```

The second proves the shim-backed engine reproduces the P-014 baseline hash
`5404d32e…` byte for byte. The third drives the actual built bundle through a real
browser — clicking the same buttons a visitor clicks — and asserts the displayed
values, keyboard reachability, live-region wiring, absence of console errors, and
no horizontal overflow at 360/768/1440 px.

`verify-web-demo.mjs` needs Puppeteer:

```bash
cd web
npm i -D puppeteer
npx puppeteer browsers install chrome
```

It skips cleanly if Puppeteer is absent.

---

## Layout

```
web/
├── index.html                    all content and copy
├── vite.config.ts                the node:crypto alias lives here
├── src/
│   ├── main.ts                   mounts the demo, scroll reveal
│   ├── ce-browser.ts             adapter over CE's product API
│   ├── node-crypto-shim.ts       synchronous SHA-256
│   └── components/demo.ts        the interactive demo
├── styles/
│   ├── tokens.css                colour, type, space, motion
│   ├── base.css                  reset and document rhythm
│   └── components.css            everything else
└── public/favicon.svg
```

`ce-browser.ts` is the only file that imports CE. It reshapes the product API for
a UI and adds nothing causal — no rule, no RNG, no derived world value. Same
boundary the Godot adapter respects.

---

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on every push
to `main` that touches `web/`, `src/`, or the workflow itself.

One-time setup: **Settings → Pages → Source → GitHub Actions**.

The site then serves from `https://<user>.github.io/causality-engine/`.

### Custom domain

1. Point a `CNAME` record at `<user>.github.io`.
2. Add the domain under Settings → Pages.
3. Add a `web/public/CNAME` file containing just the domain.
4. Set `CE_WEB_BASE=/` in the workflow's build step — a custom domain serves from
   the root, not a subpath.

### Elsewhere

Any static host works. Build with the right base path:

```bash
CE_WEB_BASE=/ npm run build     # root-served (Netlify, Vercel, S3, nginx)
```

No server, no backend, no database. The demo is entirely client-side.

---

## Editing content

All copy lives in `index.html`. Two rules, because the project is strict about
this:

- **Every number must be a real measurement.** The figures in the evidence table
  come from actual test runs. Do not add one you cannot reproduce.
- **The limitations section stays complete.** Including "nobody outside the
  project has used it". That is the honest state, and it is also the appeal — the
  site is asking for a tester, and overselling would undercut the ask.

---

## Accessibility

Semantic landmarks, one `h1`, skip link, visible focus rings, AA contrast, a
`polite` live region for the engine log, and `prefers-reduced-motion` honoured for
both scroll reveal and smooth scrolling.

Verified in the browser check: keyboard reachability, live-region attributes,
declared language, and no horizontal overflow at three widths. Not verified: a
screen-reader pass. If you have one, that feedback is welcome.
