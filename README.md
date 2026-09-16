# SunTrace — running this as a real app

This is a proper Vite project, not the CDN-script version — `react`, `react-dom`, `lucide-react`, and
`recharts` are real npm dependencies here, installed the normal way. That removes the reliability concerns
that came with loading those from a CDN as global scripts.

## 1. Run it locally first

You'll need [Node.js](https://nodejs.org) installed (any recent LTS version).

```
cd suntrace-app
npm install
npm run dev
```

This starts a local dev server (usually `http://localhost:5173`) — open that in a browser on your computer
to confirm it loads and looks right before going further.

## 2. One real gap to know about: the AI photo analysis

The skin-type and sky-reading photo steps call Claude's API. Inside Claude's own sandbox that works with no
key. Out here, it needs an actual Anthropic API key — and a key can never sit in this client-side code, or
anyone could read it out of the page source and use it on your bill.

You have two options:

- **Quickest for testing only:** open `src/App.jsx`, find `analyzeImageWithClaude`, and temporarily add your
  own key to the request headers (`"x-api-key": "sk-ant-..."`, plus `"anthropic-dangerous-direct-browser-access": "true"`).
  Fine for trying it out yourself, **not safe to ship** — remove it before giving this to anyone else.
- **The real fix:** add a tiny backend (a single serverless function on Vercel/Netlify/Cloudflare works well)
  that holds the key server-side and proxies just that one request. `analyzeImageWithClaude`'s fetch call
  points at `/api/analyze` instead of Anthropic directly, and the function forwards it with the key attached.
  Happy to build that function with you when you're ready for it.

Everything else — GPS, the solar math, storage, the UI — has no such dependency and works as-is.

## 3. Put it on your phone

**Fastest path — no server to manage:**

```
npm run build
```

This produces a `dist/` folder. Drag that folder onto **netlify.com/drop** — it gives you a live HTTPS URL
in seconds, no account needed. HTTPS matters here: iOS won't grant camera/location permissions to a page
that isn't served over it.

Open that URL on your iPhone:
- **In Safari** → share icon → "Add to Home Screen" gives you a real standalone app icon, no browser chrome.
- **In Brave** → works fine to test GPS/camera in-browser, but Brave on iOS can't install to the home screen
  as a standalone PWA yet — that's a Brave limitation, not this app (see earlier conversation for details).

**For something more permanent:** connect this folder to Netlify, Vercel, or GitHub Pages properly instead
of a one-off drop — any of them redeploy automatically on every push if you put this in a git repo.

## 4. When you're ready for the App Store

This same code is the right starting point for wrapping with **Capacitor** to get a real installable iOS/
Android app with Bluetooth support for when the SunTrace hardware exists — nothing here needs to be rewritten
for that, Capacitor wraps it as-is.

## Project structure

```
suntrace-app/
  src/App.jsx        — the actual app (everything lives in this one file)
  src/main.jsx        — mounts it, registers the service worker
  public/manifest.json — PWA install metadata
  public/service-worker.js
  index.html
```
