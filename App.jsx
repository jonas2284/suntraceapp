import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Sun, History as HistoryIcon, Settings, MapPin, ChevronRight, Sunrise, Plus,
  Bluetooth, X, Check, Loader2, Shield, Glasses, HardHat, Shirt,
  Moon, Utensils, Clock, Coffee, Snowflake, LocateFixed,
  Mountain, Footprints, Activity, Bike, Waves, Umbrella, Sprout, MoreHorizontal, Target,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');`;

const palette = {
  obsidian: "#15140F",
  card: "#1D1B14",
  cardEdge: "#2A2820",
  amber: "#E3A73A",
  amberDim: "#7A5A28",
  ocean: "#3E6E73",
  bone: "#F3EEE4",
  muted: "#8B8677",
};

const PROFILE_KEY = "profile";
const SESSIONS_KEY = "sun-sessions";
const NIGHT_KEY = "night-routine";
const LAST_LOCATION_KEY = "last-location";
const LOCATION_CACHE_MS = 4 * 60 * 60 * 1000; // reuse a GPS fix for 4 hours

const NIGHT_HABITS = [
  { id: "blackoutRoom", label: "Blackout room", icon: Moon, desc: "Slept in a fully dark room" },
  { id: "blockedBlueLight", label: "Blocked blue light", icon: Glasses, desc: "Screens off or blue light blocked before bed" },
  { id: "dinnerBeforeBed", label: "Dinner 3+ hrs before bed", icon: Utensils, desc: "Finished eating well before sleep" },
  { id: "consistentBedtime", label: "Consistent bedtime", icon: Clock, desc: "Went to bed around your usual time" },
  { id: "noLateCaffeine", label: "No late caffeine", icon: Coffee, desc: "No caffeine in the afternoon or evening" },
  { id: "coolRoom", label: "Cool room", icon: Snowflake, desc: "Slept somewhere cool" },
];

function emptyNightEntry() {
  return Object.fromEntries(NIGHT_HABITS.map((h) => [h.id, false]));
}
function nightHabitCount(entry) {
  if (!entry) return 0;
  return NIGHT_HABITS.reduce((sum, h) => sum + (entry[h.id] ? 1 : 0), 0);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function lastNDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function dayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short" });
}
function minutesFor(sessions, dateStr) {
  return sessions.filter((s) => s.date === dateStr).reduce((sum, s) => sum + s.duration, 0);
}
// 13 hourly buckets, 5am(5)-6pm(17), each holding fraction-of-hour covered by sessions
function hourlyBuckets(sessions, dateStr) {
  const buckets = new Array(13).fill(0);
  sessions.filter((s) => s.date === dateStr).forEach((s) => {
    let remaining = s.duration;
    let hour = s.startHour;
    while (remaining > 0 && hour < 18) {
      const idx = hour - 5;
      if (idx >= 0 && idx < 13) {
        const used = Math.min(remaining, 60);
        buckets[idx] = Math.min(1, buckets[idx] + used / 60);
      }
      remaining -= 60;
      hour += 1;
    }
  });
  return buckets;
}

// ---- estimated light type & protection (educational/estimated tier, not measured) ----

function lightTierForHour(hour) {
  if (hour < 6) return { tier: "Daybreak", desc: "Before sunrise — dim, cool-toned light with no direct sun yet. The earliest, most reliable time to anchor your body clock for the day." };
  if (hour >= 10 && hour < 14) return { tier: "Peak UV", desc: "Sun near its highest point — highest UVB, most sunburn-relevant" };
  if ((hour >= 8 && hour < 10) || (hour >= 14 && hour < 16)) return { tier: "Moderate UV", desc: "Mixed UVA/UVB, still meaningful blue light" };
  return { tier: "Low-angle light", desc: "Mostly visible/red light, minimal UVB, strong circadian blue-light cue" };
}
const UV_WEIGHT = { "Daybreak": 0, "Peak UV": 1, "Moderate UV": 0.6, "Low-angle light": 0.2 };

// ---- precise location: GPS + real solar position ----

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Geolocation not supported")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  });
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`);
    const data = await res.json();
    const a = data.address || {};
    return a.city || a.town || a.village || a.county || (data.display_name ? data.display_name.split(",")[0] : null) || `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
  } catch {
    return `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
  }
}

// Real solar elevation angle (NOAA simplified solar position equations).
// Longitude alone (not a timezone database) converts UTC to true solar time,
// so this needs an actual UTC instant — we approximate that from the picked
// local hour using longitude/15 as a rough timezone-offset estimate, which is
// an honest simplification (can be off near DST/timezone-boundary edge cases)
// but keeps this working with no external timezone service.
function estimateUTCHour(localHour, lng) {
  const tzOffset = Math.round(lng / 15);
  return ((localHour - tzOffset) % 24 + 24) % 24;
}

function solarElevation(dateUTC, lat, lng) {
  const rad = Math.PI / 180;
  const utcHours = dateUTC.getUTCHours() + dateUTC.getUTCMinutes() / 60;
  const start = Date.UTC(dateUTC.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((dateUTC.getTime() - start) / 86400000);
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const timeOffset = eqtime + 4 * lng;
  let tst = (utcHours * 60 + timeOffset) % 1440;
  if (tst < 0) tst += 1440;
  const hourAngle = (tst / 4) - 180;
  const haRad = hourAngle * rad;
  const latRad = lat * rad;
  const cosZenith = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(haRad);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  return 90 - zenith / rad;
}

function solarElevationForEntry(entry) {
  const utcHour = estimateUTCHour(entry.startHour, entry.lng);
  const [y, m, d] = entry.date.split("-").map(Number);
  const dateUTC = new Date(Date.UTC(y, m - 1, d, Math.floor(utcHour), Math.round((utcHour % 1) * 60)));
  return solarElevation(dateUTC, entry.lat, entry.lng);
}

function elevationTier(elevation) {
  if (elevation <= 0) return { tier: "Daybreak", desc: `Sun is below the horizon here right now — no direct UV yet, but a real, useful circadian cue.` };
  if (elevation <= 15) return { tier: "Low-angle light", desc: `Sun sits low at this location (~${Math.round(elevation)}° elevation) — mostly visible/red light, minimal UVB.` };
  if (elevation <= 40) return { tier: "Moderate UV", desc: `Sun at a moderate angle here (~${Math.round(elevation)}° elevation) — mixed UVA/UVB.` };
  return { tier: "Peak UV", desc: `Sun high overhead at this location (~${Math.round(elevation)}° elevation) — highest UVB, most sunburn-relevant.` };
}

function seasonForDate(dateStr) {
  const month = new Date(dateStr + "T00:00:00").getMonth(); // 0=Jan
  if ([4, 5, 6, 7].includes(month)) return { label: "Summer season", mult: 1.2 };
  if ([10, 11, 0, 1].includes(month)) return { label: "Winter season", mult: 0.7 };
  return { label: "Transitional season", mult: 1 };
}

function protectionFactors(entry) {
  let skin = 1;
  if (entry.sunscreen) skin *= 0.3;
  if (entry.hat) skin *= 0.85;
  // Each garment shields the body part it covers; long sleeve implies more
  // coverage than a short-sleeve shirt, so it isn't stacked on top of it.
  const upperReduction = entry.longSleeve ? 0.3 : entry.shirt ? 0.15 : 0;
  const lowerReduction = entry.shorts ? 0.1 : 0;
  const feetReduction = entry.shoes ? 0.05 : 0;
  skin *= Math.max(0.05, 1 - upperReduction - lowerReduction - feetReduction);
  const eyes = entry.sunglasses ? 0.2 : 1;
  return { skin, eyes };
}

function skinBand(v) {
  if (v <= 0.15) return "Minimal";
  if (v <= 0.4) return "Low";
  if (v <= 0.8) return "Moderate";
  return "High";
}
function skinDotCount(v) {
  if (v <= 0.15) return 0;
  if (v <= 0.4) return 1;
  if (v <= 0.8) return 2;
  return 3;
}
// Circadian value tracks the sun's angle, not UV: high at low sun angles
// (sunrise/morning), low near solar noon, partial recovery in the afternoon.
function circadianBaseDots(hour) {
  if (hour < 10) return 3;
  if (hour < 14) return 1;
  if (hour < 16) return 2;
  return 1;
}
function tierColor(tier) {
  if (tier === "Daybreak") return "#4A7A99";
  if (tier === "Peak UV") return "#F2D48A";
  if (tier === "Moderate UV") return "#D98A34";
  return "#C2542A";
}
const DOT_LABELS = ["Blocked", "Low", "Moderate", "High"];

// Relative photosensitivity by Fitzpatrick type, illustrative and approximate
// (real minimal-erythema-dose ratios vary by study) — Type III treated as the
// neutral baseline the rest of the model was already calibrated against.
const SKIN_TYPE_MULTIPLIER = { I: 1.5, II: 1.2, III: 1.0, IV: 0.7, V: 0.5, VI: 0.3 };

// Vitamin D synthesis efficiency declines with age (less 7-dehydrocholesterol
// in older skin) — this affects vitamin D opportunity only, not burn risk.
function ageVitDFactor(age) {
  if (!age) return 1;
  if (age >= 70) return 0.6;
  if (age >= 50) return 0.8;
  return 1;
}

function estimateSession(entry, profile) {
  const hasGPS = entry.lat != null && entry.lng != null;
  let tier, desc, seasonLabel, seasonMult, elevation = null;

  if (hasGPS) {
    elevation = solarElevationForEntry(entry);
    const t = elevationTier(elevation);
    tier = t.tier; desc = t.desc;
    seasonLabel = null; // real elevation already encodes season + latitude + time
    seasonMult = 1;
  } else {
    const t = lightTierForHour(entry.startHour);
    tier = t.tier; desc = t.desc;
    const season = seasonForDate(entry.date);
    seasonLabel = season.label; seasonMult = season.mult;
  }

  const { skin, eyes } = protectionFactors(entry);
  const skinTypeMult = profile?.skinType ? SKIN_TYPE_MULTIPLIER[profile.skinType] ?? 1 : 1;
  const skyFactor = entry.uvFactor ?? 1; // cloud cover attenuation from a sky-read photo, if taken

  const burnScore = UV_WEIGHT[tier] * seasonMult * skin * skinTypeMult * skyFactor;
  const vitDScore = burnScore * ageVitDFactor(profile?.age);

  const sunburnDots = skinDotCount(burnScore);
  const sunburnLabel = skinBand(burnScore);
  const vitDDots = skinDotCount(vitDScore);
  const vitDLabel = skinBand(vitDScore);

  let circadianDots = circadianBaseDots(entry.startHour);
  let circadianLabel = DOT_LABELS[circadianDots];
  if (entry.sunglasses) { circadianDots = 0; circadianLabel = "Blocked"; }

  return {
    tier, desc, season: seasonLabel, elevation, precise: hasGPS,
    skyCondition: entry.skyCondition || null,
    skinExposure: sunburnLabel,
    eyeExposure: eyes <= 0.3 ? "Blocked (sunglasses)" : "Received",
    circadianDots, circadianLabel,
    vitDDots, vitDLabel,
    sunburnDots, sunburnLabel,
  };
}

function formatHour(h) {
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
}

const FITZPATRICK_TYPES = [
  { id: "I", label: "Type I", desc: "Very fair — always burns, never tans" },
  { id: "II", label: "Type II", desc: "Fair — usually burns, tans minimally" },
  { id: "III", label: "Type III", desc: "Medium — sometimes burns, tans gradually" },
  { id: "IV", label: "Type IV", desc: "Olive — rarely burns, tans easily" },
  { id: "V", label: "Type V", desc: "Brown — very rarely burns, tans darkly" },
  { id: "VI", label: "Type VI", desc: "Deep brown/black — almost never burns" },
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

async function analyzeImageWithClaude(file, prompt) {
  const base64 = await fileToBase64(file);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: base64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  const data = await response.json();
  const textBlock = (data.content || []).find((c) => c.type === "text");
  const cleaned = (textBlock?.text || "").replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function analyzeSkinPhoto(file) {
  const parsed = await analyzeImageWithClaude(
    file,
    "This photo shows a person's inner forearm, photographed outside in daylight — skin that gets little regular sun exposure, photographed in natural light for accurate color. It's for a sun-safety app estimating baseline, unexposed skin tone. Classify the visible skin tone on the Fitzpatrick scale (I through VI). Respond with ONLY JSON and nothing else, in exactly this format: {\"fitzpatrick\":\"III\",\"confidence\":\"low\"}"
  );
  if (!FITZPATRICK_TYPES.some((t) => t.id === parsed.fitzpatrick)) throw new Error("Unrecognized result");
  return parsed;
}

const SKY_CONDITIONS = {
  "Clear": 1.0,
  "Partly cloudy": 0.8,
  "Overcast": 0.5,
  "Hazy or smoky": 0.35,
};

async function analyzeSkyPhoto(file) {
  const parsed = await analyzeImageWithClaude(
    file,
    "This photo shows the sky where someone is about to spend time outdoors, for a sun-safety app. Assess the current cloud/sky conditions and classify as exactly one of: \"Clear\", \"Partly cloudy\", \"Overcast\", or \"Hazy or smoky\". Respond with ONLY JSON and nothing else, in exactly this format: {\"condition\":\"Partly cloudy\",\"confidence\":\"low\"}"
  );
  if (!(parsed.condition in SKY_CONDITIONS)) throw new Error("Unrecognized result");
  return { ...parsed, uvFactor: SKY_CONDITIONS[parsed.condition] };
}

// ---- storage portability shim -------------------------------------------
//
// Inside Claude's artifact preview, `window.storage` is provided natively.
// Outside it (a PWA, a Capacitor app, any real deployment) that API doesn't
// exist. Rather than rewriting every call site later, this installs an
// IndexedDB-backed implementation with the exact same shape (get/set/delete/
// list, same (key, shared) signatures, same throw-on-missing-key behavior)
// the moment this file runs anywhere `window.storage` isn't already present.
// Every other line in this app that talks to `window.storage` works
// unchanged in both environments.
(function installStoragePolyfillIfNeeded() {
  if (typeof window === "undefined" || window.storage) return; // real one wins
  if (typeof indexedDB === "undefined") {
    // No IndexedDB either (very old/unusual environment) — fail soft with an
    // in-memory store so the app still runs for the current tab session.
    const mem = new Map();
    window.storage = {
      async get(key) {
        if (!mem.has(key)) throw new Error(`Key not found: ${key}`);
        return { key, value: mem.get(key), shared: false };
      },
      async set(key, value) { mem.set(key, value); return { key, value, shared: false }; },
      async delete(key) { const existed = mem.delete(key); return { key, deleted: existed, shared: false }; },
      async list(prefix) {
        const keys = [...mem.keys()].filter((k) => !prefix || k.startsWith(prefix));
        return { keys, prefix, shared: false };
      },
    };
    return;
  }

  const DB_NAME = "sun-app-storage";
  const STORE = "kv";
  let dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function withStore(mode, run) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  window.storage = {
    async get(key, _shared) {
      const value = await withStore("readonly", (store) => store.get(key));
      if (value === undefined) throw new Error(`Key not found: ${key}`);
      return { key, value, shared: false };
    },
    async set(key, value, _shared) {
      await withStore("readwrite", (store) => store.put(value, key));
      return { key, value, shared: false };
    },
    async delete(key, _shared) {
      await withStore("readwrite", (store) => store.delete(key));
      return { key, deleted: true, shared: false };
    },
    async list(prefix, _shared) {
      const allKeys = await withStore("readonly", (store) => store.getAllKeys());
      const keys = allKeys.map(String).filter((k) => !prefix || k.startsWith(prefix));
      return { keys, prefix, shared: false };
    },
  };
})();

async function loadJSON(key, fallback) {
  try {
    const res = await window.storage.get(key, false);
    return res ? JSON.parse(res.value) : fallback;
  } catch {
    return fallback;
  }
}
async function saveJSON(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), false);
  } catch (e) {
    console.error("storage set failed", e);
  }
}

function LightArcGraphic({ startHour, tier, idSuffix, compact }) {
  const width = 300, height = compact ? 62 : 92;
  const cx = width / 2, cy = height - 18, r = width / 2 - 30;
  const f = Math.max(0, Math.min(1, (startHour - 5) / 13));
  const angle = Math.PI - f * Math.PI;
  const mx = cx + r * Math.cos(angle);
  const my = cy - r * Math.sin(angle);
  const color = tierColor(tier);
  const gradId = `lightgrad-${idSuffix}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4A7A99" />
          <stop offset="8%" stopColor="#C2542A" />
          <stop offset="31%" stopColor="#D98A34" />
          <stop offset="50%" stopColor="#F2D48A" />
          <stop offset="69%" stopColor="#D98A34" />
          <stop offset="92%" stopColor="#C2542A" />
          <stop offset="100%" stopColor="#C2542A" />
        </linearGradient>
      </defs>
      <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={palette.cardEdge} strokeWidth="1" />
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={`url(#${gradId})`} strokeWidth={compact ? 5 : 7} strokeLinecap="round" />
      <circle cx={mx} cy={my} r={compact ? 5 : 6} fill={color} stroke={palette.bone} strokeWidth="2" />
    </svg>
  );
}

function MetricDots({ label, count, color, valueLabel }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-[11px]" style={{ color: palette.muted, fontFamily: "Inter" }}>{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: palette.bone, fontFamily: "IBM Plex Mono" }}>{valueLabel}</span>
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 12, height: 4, borderRadius: 2, background: i < count ? color : palette.cardEdge }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function LightProfileCard({ entry, profile, idSuffix, compact }) {
  const est = useMemo(() => estimateSession(entry, profile), [entry, profile]);
  return (
    <div className={compact ? "" : "rounded-xl px-3 py-3"} style={compact ? {} : { background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
      {!compact && (
        <div className="text-[10px] uppercase tracking-wide mb-2" style={{ color: palette.muted, fontFamily: "Inter" }}>
          {est.tier} — {formatHour(entry.startHour)}
        </div>
      )}
      <LightArcGraphic startHour={entry.startHour} tier={est.tier} idSuffix={idSuffix} compact={compact} />
      <div className="mt-2">
        <MetricDots label="Circadian signal" count={est.circadianDots} color={palette.ocean} valueLabel={est.circadianLabel} />
        <MetricDots label="Vitamin D opportunity" count={est.vitDDots} color={palette.amber} valueLabel={est.vitDLabel} />
        <MetricDots label="Sunburn risk" count={est.sunburnDots} color="#B8503A" valueLabel={est.sunburnLabel} />
      </div>
    </div>
  );
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function blendColor(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// A big sun made of distinct segments — one per circadian action (real
// daylight, outdoor exercise, each night habit). Each segment lights up amber
// the moment that specific thing is done; the core brightens as more light up.
function arcPath(cx, cy, r, startDeg, endDeg) {
  const s = ((startDeg - 90) * Math.PI) / 180, e = ((endDeg - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(s), y1 = cy + r * Math.sin(s);
  const x2 = cx + r * Math.cos(e), y2 = cy + r * Math.sin(e);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function CircadianSunGoal({ items, size = 180 }) {
  const cx = 140, cy = 140, r = 110, stroke = 20, coreR = 62, gap = 6;
  const n = items.length;
  const segAngle = 360 / n;
  const doneCount = items.filter((i) => i.done).length;
  const frac = n > 0 ? doneCount / n : 0;
  const coreColor = blendColor("#1D1B14", "#E3A73A", frac);
  const textColor = frac > 0.55 ? palette.obsidian : palette.bone;
  const rayColor = frac > 0.1 ? palette.amber : "#3A3628";

  return (
    <svg viewBox="0 0 280 280" style={{ width: size, height: size, display: "block", margin: "0 auto" }}>
      {items.map((item, i) => {
        const start = i * segAngle + gap / 2;
        const end = (i + 1) * segAngle - gap / 2;
        return (
          <path
            key={i} d={arcPath(cx, cy, r, start, end)} fill="none"
            stroke={item.done ? palette.amber : palette.cardEdge} strokeWidth={stroke} strokeLinecap="round"
            style={{ transition: "stroke 0.3s ease" }}
          />
        );
      })}
      <g stroke={rayColor} strokeWidth="3" strokeLinecap="round" style={{ transition: "stroke 0.3s ease" }}>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
          const rad = (a * Math.PI) / 180;
          const x1 = cx + 40 * Math.cos(rad), y1 = cy + 40 * Math.sin(rad);
          const x2 = cx + 50 * Math.cos(rad), y2 = cy + 50 * Math.sin(rad);
          return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      </g>
      <circle cx={cx} cy={cy} r={coreR} fill={coreColor} style={{ transition: "fill 0.3s ease" }} />
      <text x={cx} y={cy + 3} textAnchor="middle" dominantBaseline="middle" fill={textColor} fontFamily="IBM Plex Mono" fontSize="30" fontWeight="600">
        {doneCount}/{n}
      </text>
    </svg>
  );
}

// ---------------- small pieces ----------------

// Lucide doesn't ship literal "shorts" / "long sleeve" / "shoe" icons, so these
// are hand-drawn to match lucide's own conventions (24x24, 2px stroke, round caps).
function ShortsIcon({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4 L19 4 L18 20 L14 20 L13 11 L11 11 L10 20 L6 20 Z" />
    </svg>
  );
}

function LongSleeveIcon({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3 L12 6 L15 3" />
      <path d="M9 3 L9 21 L15 21 L15 3" />
      <path d="M9 4 L4 8 L4 15 L7 14" />
      <path d="M15 4 L20 8 L20 15 L17 14" />
    </svg>
  );
}

function ShoeIcon({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17 L3 13 Q3 11 5 11 L8 11 L11 8 L16 8 Q18 8 19 10 L21 13 Q22 14 21 16 L21 17 Z" />
    </svg>
  );
}

function SurfboardIcon({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 C16 2 18.5 8 18.5 12.5 C18.5 17 16 22 12 22 C8 22 5.5 17 5.5 12.5 C5.5 8 8 2 12 2 Z" />
      <path d="M12 3 L12 21" strokeWidth="1.2" />
    </svg>
  );
}

const ACTIVITIES = [
  { id: "surf", label: "Surf", icon: SurfboardIcon },
  { id: "hike", label: "Hike", icon: Mountain },
  { id: "walk", label: "Walk", icon: Footprints },
  { id: "run", label: "Run", icon: Activity },
  { id: "bike", label: "Bike", icon: Bike },
  { id: "swim", label: "Swim", icon: Waves },
  { id: "beach", label: "Beach", icon: Umbrella },
  { id: "garden", label: "Garden", icon: Sprout },
  { id: "other", label: "Other", icon: MoreHorizontal },
];
function activityMeta(id) {
  return ACTIVITIES.find((a) => a.id === id) || null;
}
// Physical, outdoor activities that count toward circadian credit — "Beach"
// is typically passive lounging, and "Other" is too ambiguous to auto-credit.
const EXERCISE_ACTIVITY_IDS = ["surf", "hike", "walk", "run", "bike", "swim", "garden"];
const EXERCISE_MIN_MINUTES = 10;
function hadOutdoorExerciseToday(sessions, dateStr) {
  return sessions.some((s) => s.date === dateStr && EXERCISE_ACTIVITY_IDS.includes(s.activity) && s.duration >= EXERCISE_MIN_MINUTES);
}


function StatCard({ label, value, unit, accent }) {
  return (
    <div className="rounded-2xl px-4 py-3 flex-1" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
      <div className="text-[11px] tracking-wide uppercase" style={{ color: palette.muted, fontFamily: "Inter" }}>{label}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <span className="text-2xl" style={{ color: accent || palette.bone, fontFamily: "IBM Plex Mono", fontWeight: 500 }}>{value}</span>
        <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{unit}</span>
      </div>
    </div>
  );
}

function SunArc({ buckets, totalMin }) {
  const cx = 130, cy = 130, r = 100;
  const arcSpan = Math.PI, gap = 0.045;
  const segs = buckets.map((intensity, i) => {
    const segAngle = arcSpan / buckets.length;
    const start = Math.PI - i * segAngle + gap / 2;
    const end = Math.PI - (i + 1) * segAngle - gap / 2;
    const x1 = cx + r * Math.cos(start), y1 = cy - r * Math.sin(start);
    const x2 = cx + r * Math.cos(end), y2 = cy - r * Math.sin(end);
    const color = intensity === 0 ? palette.cardEdge : palette.amber;
    const opacity = intensity === 0 ? 1 : 0.35 + intensity * 0.65;
    return <path key={i} d={`M ${x1} ${y1} A ${r} ${r} 0 0 0 ${x2} ${y2}`} stroke={color} strokeOpacity={opacity} strokeWidth={10} strokeLinecap="round" fill="none" />;
  });
  return (
    <svg width="260" height="150" viewBox="0 0 260 150">
      {segs}
      <text x="130" y="95" textAnchor="middle" fill={palette.bone} fontFamily="Fraunces" fontSize="34" fontWeight="500">{(totalMin / 60).toFixed(1)}h</text>
      <text x="130" y="118" textAnchor="middle" fill={palette.muted} fontFamily="Inter" fontSize="11" letterSpacing="0.5">OUTDOORS TODAY</text>
    </svg>
  );
}

// ---------------- onboarding ----------------

function FlamingSun({ size = 140 }) {
  const rayAngles = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <div style={{ width: size, height: size, position: "relative" }}>
      <style>{`
        @keyframes suntrace-flicker { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.85; transform: scale(1.035); } }
        .suntrace-flame-core { animation: suntrace-flicker 2.4s ease-in-out infinite; transform-origin: center; }
      `}</style>
      <svg viewBox="0 0 220 220" width={size} height={size}>
        <defs>
          <radialGradient id="suntrace-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FFF3D6" />
            <stop offset="35%" stopColor="#F2C464" />
            <stop offset="70%" stopColor="#E3A73A" />
            <stop offset="100%" stopColor="#C2542A" />
          </radialGradient>
          <radialGradient id="suntrace-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#E3A73A" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#E3A73A" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="110" cy="110" r="105" fill="url(#suntrace-glow)" />
        <g className="suntrace-flame-core">
          <g strokeLinecap="round">
            {rayAngles.map((a, i) => {
              const rad = (a * Math.PI) / 180;
              const x1 = 110 + 76 * Math.cos(rad), y1 = 110 + 76 * Math.sin(rad);
              const x2 = 110 + 102 * Math.cos(rad), y2 = 110 + 102 * Math.sin(rad);
              return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke={i % 2 === 0 ? "#E3A73A" : "#D98A34"} strokeWidth="5" />;
            })}
          </g>
          <circle cx="110" cy="110" r="52" fill="url(#suntrace-core)" />
        </g>
      </svg>
    </div>
  );
}

function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [location, setLocation] = useState(null); // { lat, lng, label }
  const [locatingHome, setLocatingHome] = useState(false);
  const [locationHomeError, setLocationHomeError] = useState(null);
  const [age, setAge] = useState("");
  const [sex, setSex] = useState("");
  const [familyMelanomaHistory, setFamilyMelanomaHistory] = useState("none");
  const [skinType, setSkinType] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeNote, setAnalyzeNote] = useState(null); // { ok, confidence } | null
  const [skyAnalyzing, setSkyAnalyzing] = useState(false);
  const [skyResult, setSkyResult] = useState(null); // { condition, confidence } | null
  const [skyError, setSkyError] = useState(null);
  const fileInputRef = React.useRef(null);
  const skyInputRef = React.useRef(null);

  const input = "w-full rounded-xl px-4 py-3 text-sm outline-none";
  const inputStyle = { background: palette.card, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" };
  const lastStep = 6;

  async function handlePhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setAnalyzing(true);
    setAnalyzeNote(null);
    try {
      const result = await analyzeSkinPhoto(file);
      setSkinType(result.fitzpatrick);
      setAnalyzeNote({ ok: true, confidence: result.confidence || "medium" });
    } catch (err) {
      setAnalyzeNote({ ok: false });
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleSkyPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSkyAnalyzing(true);
    setSkyError(null);
    try {
      const result = await analyzeSkyPhoto(file);
      setSkyResult(result);
    } catch (err) {
      setSkyError("Couldn't read that photo — you can always read the sky when you log a session instead.");
    } finally {
      setSkyAnalyzing(false);
    }
  }

  async function handleUseHomeLocation() {
    setLocatingHome(true);
    setLocationHomeError(null);
    try {
      const { lat, lng } = await getCurrentLocation();
      const label = await reverseGeocode(lat, lng);
      setLocation({ lat, lng, label });
    } catch (err) {
      setLocationHomeError(
        err && err.code === 1
          ? "Location permission denied — enable it in your browser/device settings."
          : "Couldn't get a location fix — try again."
      );
    } finally {
      setLocatingHome(false);
    }
  }

  const canContinue =
    (step === 0 && name.trim()) ||
    (step === 1 && location) ||
    (step === 2 && age.trim() && Number(age) > 0 && Number(age) < 120) ||
    (step === 3 && sex) ||
    step === 4 ||
    (step === 5 && skinType) ||
    step === 6; // sky reading is a demo, never blocks

  function handleNext() {
    if (step < lastStep) {
      setStep(step + 1);
    } else {
      onDone({
        name: name.trim() || "there",
        location: location?.label || "Not set",
        age: Number(age),
        sex,
        familyMelanomaHistory,
        skinType,
      });
    }
  }

  return (
    <div className="flex-1 flex flex-col justify-between px-6 py-10 overflow-y-auto">
      <div>
        {step === 0 ? (
          <div className="flex justify-center mb-6"><FlamingSun size={150} /></div>
        ) : (
          <div className="w-14 h-14 rounded-full flex items-center justify-center mb-6" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
            <Sun size={24} color={palette.amber} />
          </div>
        )}

        {step === 0 && (
          <>
            <div className="text-2xl mb-2 text-center" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Know your sun.</div>
            <p className="text-sm leading-relaxed mb-8 text-center" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Our aim is simple: help you get sunlight's benefits — morning light, vitamin D — before the burn.
              No account, no cloud — everything stays on this device.
            </p>
            <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>What should we call you?</label>
            <input className={input} style={inputStyle} placeholder="First name" value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}

        {step === 1 && (
          <>
            <div className="text-2xl mb-2" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Where are you based?</div>
            <p className="text-sm leading-relaxed mb-6" style={{ color: palette.muted, fontFamily: "Inter" }}>
              We use your real GPS location, not a typed-in city — it's what lets your Sun Story compute the sun's
              actual position instead of guessing. You can refresh this any time you travel.
            </p>
            {!location ? (
              <button
                onClick={handleUseHomeLocation}
                disabled={locatingHome}
                className="w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2"
                style={{ background: palette.card, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" }}
              >
                {locatingHome ? <><Loader2 size={15} className="animate-spin" /> Getting your location…</> : <><LocateFixed size={15} color={palette.amber} /> Use current GPS location</>}
              </button>
            ) : (
              <button
                onClick={handleUseHomeLocation}
                disabled={locatingHome}
                className="w-full rounded-xl py-3 flex items-center justify-between px-3"
                style={{ background: palette.card, border: `1px solid ${palette.amberDim}` }}
              >
                <span className="flex items-center gap-2 text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>
                  {locatingHome ? <Loader2 size={15} className="animate-spin" color={palette.amber} /> : <LocateFixed size={15} color={palette.amber} />}
                  {location.label}
                </span>
                <span className="text-[10px]" style={{ color: palette.muted, fontFamily: "Inter" }}>Update</span>
              </button>
            )}
            {locationHomeError && (
              <p className="text-[11px] leading-snug mt-2" style={{ color: "#B8503A", fontFamily: "Inter" }}>{locationHomeError}</p>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="text-2xl mb-2" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>How old are you?</div>
            <p className="text-sm leading-relaxed mb-8" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Sun sensitivity changes with age — this helps put your Sun Story in context.
            </p>
            <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Age</label>
            <input
              className={input} style={inputStyle} type="number" inputMode="numeric" placeholder="e.g. 34"
              value={age} onChange={(e) => setAge(e.target.value)}
            />
          </>
        )}

        {step === 3 && (
          <>
            <div className="text-2xl mb-2" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Sex</div>
            <p className="text-sm leading-relaxed mb-6" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Used only to put your readings in context alongside age and skin type.
            </p>
            <div className="flex gap-2">
              {[{ id: "F", label: "Female" }, { id: "M", label: "Male" }].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setSex(opt.id)}
                  className="flex-1 rounded-xl py-3 text-sm"
                  style={{
                    background: sex === opt.id ? palette.amber : palette.card,
                    color: sex === opt.id ? palette.obsidian : palette.bone,
                    border: `1px solid ${sex === opt.id ? palette.amber : palette.cardEdge}`,
                    fontFamily: "Inter",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="text-2xl mb-2" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Any melanoma in the family?</div>
            <p className="text-sm leading-relaxed mb-6" style={{ color: palette.muted, fontFamily: "Inter" }}>
              A family history of melanoma is one of the stronger, well-established risk factors for skin cancer —
              independent of skin type. This just tunes how cautious your sunburn-risk readings are.
            </p>
            <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Family history of melanoma</label>
            <div className="flex gap-2">
              {[
                { id: "none", label: "No known history" },
                { id: "immediate", label: "Yes — parent/sibling" },
                { id: "extended", label: "Yes — extended family" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setFamilyMelanomaHistory(opt.id)}
                  className="flex-1 rounded-xl py-2.5 px-2 text-[11px] leading-tight"
                  style={{
                    background: familyMelanomaHistory === opt.id ? palette.amber : palette.card,
                    color: familyMelanomaHistory === opt.id ? palette.obsidian : palette.muted,
                    border: `1px solid ${familyMelanomaHistory === opt.id ? palette.amber : palette.cardEdge}`,
                    fontFamily: "Inter",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <div className="text-2xl mb-2" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>What's your skin type?</div>
            <p className="text-sm leading-relaxed mb-6" style={{ color: palette.muted, fontFamily: "Inter" }}>
              This is the Fitzpatrick scale dermatologists use for sun sensitivity — pick the closest match, or let a
              photo suggest one for you.
            </p>

            <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Skin type</label>
            <select
              className={input} style={{ ...inputStyle, marginBottom: 14, appearance: "auto" }}
              value={skinType} onChange={(e) => { setSkinType(e.target.value); setAnalyzeNote(null); }}
            >
              <option value="" disabled>Select a skin type…</option>
              {FITZPATRICK_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label} — {t.desc}</option>
              ))}
            </select>

            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: "none" }} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={analyzing}
              className="w-full rounded-xl py-2.5 text-xs flex items-center justify-center gap-2 mb-2"
              style={{ background: palette.card, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" }}
            >
              {analyzing ? (
                <><Loader2 size={13} className="animate-spin" /> Analyzing photo…</>
              ) : (
                "Not sure? Photograph your inner forearm outside in the sun"
              )}
            </button>

            {analyzeNote?.ok && (
              <p className="text-[11px]" style={{ color: palette.amber, fontFamily: "Inter" }}>
                Estimated Type {skinType} from your photo ({analyzeNote.confidence} confidence) — adjust above if it doesn't look right.
              </p>
            )}
            {analyzeNote && !analyzeNote.ok && (
              <p className="text-[11px]" style={{ color: palette.muted, fontFamily: "Inter" }}>
                Couldn't read that photo clearly — please pick your skin type from the list instead.
              </p>
            )}
            <p className="text-[10px] leading-snug mt-3" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Natural daylight gives the most accurate color reading — indoor lighting can throw it off. The photo is
              sent once for analysis and never saved; only the skin type you confirm above is stored, on this device.
            </p>
          </>
        )}

        {step === 6 && (
          <>
            <div className="text-2xl mb-2" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Read today's sky</div>
            <p className="text-sm leading-relaxed mb-6" style={{ color: palette.muted, fontFamily: "Inter" }}>
              One more trick: a quick photo of the sky lets us read cloud cover, which meaningfully changes real UV —
              combined with your GPS position, that's real weather, not just a guess from the clock. You'll do this
              each time you log a session; here's a first look.
            </p>

            <input ref={skyInputRef} type="file" accept="image/*" capture="environment" onChange={handleSkyPhoto} style={{ display: "none" }} />
            <button
              onClick={() => skyInputRef.current?.click()}
              disabled={skyAnalyzing}
              className="w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2"
              style={{ background: palette.card, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" }}
            >
              {skyAnalyzing ? <><Loader2 size={15} className="animate-spin" /> Reading the sky…</> : "📷 Photograph the sky"}
            </button>

            {skyResult && (
              <div className="rounded-xl px-3 py-2.5 mt-3" style={{ background: palette.card, border: `1px solid ${palette.amberDim}` }}>
                <div className="text-sm" style={{ color: palette.amber, fontFamily: "Inter" }}>{skyResult.condition}</div>
                <div className="text-[11px] mt-0.5" style={{ color: palette.muted, fontFamily: "Inter" }}>
                  Roughly {Math.round(skyResult.uvFactor * 100)}% of clear-sky UV right now ({skyResult.confidence} confidence)
                </div>
              </div>
            )}
            {skyError && <p className="text-[11px] leading-snug mt-3" style={{ color: "#B8503A", fontFamily: "Inter" }}>{skyError}</p>}
            <p className="text-[10px] leading-snug mt-3" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Optional — you can skip this and just read the sky when you actually log a session.
            </p>
          </>
        )}
      </div>

      <div>
        <div className="flex gap-1 mb-4">
          {Array.from({ length: lastStep + 1 }, (_, i) => (
            <div key={i} className="flex-1 h-1 rounded-full" style={{ background: i <= step ? palette.amber : palette.cardEdge }} />
          ))}
        </div>
        <div className="flex gap-2">
          {step > 0 && (
            <button onClick={() => setStep(step - 1)} className="flex-1 rounded-full py-3 text-sm font-medium" style={{ background: palette.card, color: palette.muted, fontFamily: "Inter", border: `1px solid ${palette.cardEdge}` }}>
              Back
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={!canContinue}
            className="flex-[2] rounded-full py-3 text-sm font-medium"
            style={{ background: palette.amber, color: palette.obsidian, fontFamily: "Inter", opacity: canContinue ? 1 : 0.5 }}
          >
            {step === lastStep ? "Start tracking" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- log session sheet ----------------

function ToggleChip({ active, icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-xl"
      style={{
        background: active ? palette.amber : palette.card,
        border: `1px solid ${active ? palette.amber : palette.cardEdge}`,
      }}
    >
      <Icon size={16} color={active ? palette.obsidian : palette.muted} />
      <span className="text-[10px]" style={{ color: active ? palette.obsidian : palette.muted, fontFamily: "Inter" }}>{label}</span>
    </button>
  );
}

function LogSheet({ onClose, onSave, profile }) {
  const [startHour, setStartHour] = useState(new Date().getHours());
  const [duration, setDuration] = useState(30);
  const [activity, setActivity] = useState(null);
  const [sunscreen, setSunscreen] = useState(false);
  const [hat, setHat] = useState(false);
  const [sunglasses, setSunglasses] = useState(false);
  const [shorts, setShorts] = useState(false);
  const [shirt, setShirt] = useState(false);
  const [longSleeve, setLongSleeve] = useState(false);
  const [shoes, setShoes] = useState(false);
  const [location, setLocation] = useState(null); // { lat, lng, label, capturedAt }
  const [locationIsCached, setLocationIsCached] = useState(false);
  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState(null);
  const [sky, setSky] = useState(null); // { condition, confidence, uvFactor }
  const [skyAnalyzing, setSkyAnalyzing] = useState(false);
  const [skyError, setSkyError] = useState(null);
  const skyInputRef = React.useRef(null);
  const hours = Array.from({ length: 14 }, (_, i) => i + 5); // 5..18

  // On open, reuse a recent GPS fix instead of forcing a fresh tap every time —
  // still GPS-sourced, just not re-requested more often than needed.
  useEffect(() => {
    (async () => {
      const cached = await loadJSON(LAST_LOCATION_KEY, null);
      if (cached && Date.now() - cached.capturedAt < LOCATION_CACHE_MS) {
        setLocation(cached);
        setLocationIsCached(true);
        setLocating(false);
      } else {
        handleUseLocation();
      }
    })();
  }, []);

  async function handleUseLocation() {
    setLocating(true);
    setLocationError(null);
    try {
      const { lat, lng } = await getCurrentLocation();
      const label = await reverseGeocode(lat, lng);
      const fresh = { lat, lng, label, capturedAt: Date.now() };
      setLocation(fresh);
      setLocationIsCached(false);
      await saveJSON(LAST_LOCATION_KEY, fresh);
    } catch (err) {
      setLocationError(
        err && err.code === 1
          ? "Location permission denied — enable it in your browser/device settings to log a session."
          : "Couldn't get a location fix. Try again, ideally outdoors with a clear sky view."
      );
    } finally {
      setLocating(false);
    }
  }

  async function handleSkyPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSkyAnalyzing(true);
    setSkyError(null);
    try {
      const result = await analyzeSkyPhoto(file);
      setSky(result);
    } catch (err) {
      setSkyError("Couldn't read that photo — you can skip this and it'll just use the season/time estimate instead.");
    } finally {
      setSkyAnalyzing(false);
    }
  }

  const previewEntry = useMemo(
    () => ({
      startHour, date: todayStr(), sunscreen, hat, sunglasses, shorts, shirt, longSleeve, shoes,
      lat: location?.lat, lng: location?.lng,
      uvFactor: sky?.uvFactor, skyCondition: sky?.condition,
    }),
    [startHour, sunscreen, hat, sunglasses, shorts, shirt, longSleeve, shoes, location, sky]
  );

  return (
    <div className="absolute inset-0 flex items-end z-20" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-5 pb-8 max-h-[92%] overflow-y-auto"
        style={{ background: palette.obsidian, borderTop: `1px solid ${palette.cardEdge}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="text-base" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Log time outside</div>
          <button onClick={onClose}><X size={18} color={palette.muted} /></button>
        </div>

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Activity <span style={{ opacity: 0.7, textTransform: "none" }}>(optional)</span></label>
        <div className="grid grid-cols-3 gap-2 mb-5">
          {ACTIVITIES.map((a) => {
            const active = activity === a.id;
            return (
              <button
                key={a.id}
                onClick={() => setActivity(active ? null : a.id)}
                className="flex flex-col items-center gap-1.5 rounded-xl py-2.5"
                style={{ background: active ? palette.amber : palette.card, border: `1px solid ${active ? palette.amber : palette.cardEdge}` }}
              >
                <a.icon size={16} color={active ? palette.obsidian : palette.ocean} />
                <span className="text-[10px]" style={{ color: active ? palette.obsidian : palette.bone, fontFamily: "Inter" }}>{a.label}</span>
              </button>
            );
          })}
        </div>

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Location</label>
        {!location ? (
          <button
            onClick={handleUseLocation}
            disabled={locating}
            className="w-full rounded-xl py-3 mb-2 text-sm flex items-center justify-center gap-2"
            style={{ background: palette.card, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" }}
          >
            {locating ? <><Loader2 size={15} className="animate-spin" /> Getting your location…</> : <><LocateFixed size={15} color={palette.amber} /> Use current GPS location</>}
          </button>
        ) : (
          <button
            onClick={handleUseLocation}
            disabled={locating}
            className="w-full rounded-xl py-3 mb-2 flex items-center justify-between px-3"
            style={{ background: palette.card, border: `1px solid ${palette.amberDim}` }}
          >
            <span className="flex items-center gap-2 text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>
              {locating ? <Loader2 size={15} className="animate-spin" color={palette.amber} /> : <LocateFixed size={15} color={palette.amber} />}
              {location.label}
            </span>
            <span className="text-[10px]" style={{ color: palette.muted, fontFamily: "Inter" }}>
              {locating ? "Updating…" : locationIsCached ? "From earlier · Refresh" : "Update"}
            </span>
          </button>
        )}
        {locationError && (
          <p className="text-[11px] leading-snug mb-3" style={{ color: "#B8503A", fontFamily: "Inter" }}>{locationError}</p>
        )}
        {!location && !locationError && (
          <p className="text-[10px] leading-snug mb-4" style={{ color: palette.muted, fontFamily: "Inter" }}>
            Required — precise location lets us compute the sun's real position instead of guessing from the clock alone.
          </p>
        )}
        {location && <div className="mb-4" />}

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Read the sky <span style={{ opacity: 0.7, textTransform: "none" }}>(optional)</span></label>
        <input ref={skyInputRef} type="file" accept="image/*" capture="environment" onChange={handleSkyPhoto} style={{ display: "none" }} />
        {!sky ? (
          <button
            onClick={() => skyInputRef.current?.click()}
            disabled={skyAnalyzing}
            className="w-full rounded-xl py-3 mb-2 text-sm flex items-center justify-center gap-2"
            style={{ background: palette.card, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" }}
          >
            {skyAnalyzing ? <><Loader2 size={15} className="animate-spin" /> Reading the sky…</> : "📷 Photograph the sky"}
          </button>
        ) : (
          <button
            onClick={() => skyInputRef.current?.click()}
            disabled={skyAnalyzing}
            className="w-full rounded-xl py-3 mb-2 flex items-center justify-between px-3"
            style={{ background: palette.card, border: `1px solid ${palette.amberDim}` }}
          >
            <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>{sky.condition}</span>
            <span className="text-[10px]" style={{ color: palette.muted, fontFamily: "Inter" }}>{skyAnalyzing ? "Updating…" : "Retake"}</span>
          </button>
        )}
        {skyError && <p className="text-[11px] leading-snug mb-3" style={{ color: "#B8503A", fontFamily: "Inter" }}>{skyError}</p>}
        {!sky && !skyError && (
          <p className="text-[10px] leading-snug mb-5" style={{ color: palette.muted, fontFamily: "Inter" }}>
            Cloud cover meaningfully changes real UV — skip this and the estimate falls back to season/time alone.
          </p>
        )}
        {sky && <div className="mb-5" />}

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Started around</label>
        <div className="flex gap-2 overflow-x-auto pb-3 mb-4" style={{ scrollbarWidth: "none" }}>
          {hours.map((h) => (
            <button
              key={h}
              onClick={() => setStartHour(h)}
              className="px-3 py-2 rounded-xl text-xs shrink-0"
              style={{
                background: startHour === h ? palette.amber : palette.card,
                color: startHour === h ? palette.obsidian : palette.muted,
                border: `1px solid ${startHour === h ? palette.amber : palette.cardEdge}`,
                fontFamily: "IBM Plex Mono",
              }}
            >
              {formatHour(h)}
            </button>
          ))}
        </div>

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>
          Duration — {duration} min
        </label>
        <input
          type="range" min="5" max="240" step="5" value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="w-full mb-5" style={{ accentColor: palette.amber }}
        />

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Protection worn</label>
        <div className="flex gap-2 mb-4">
          <ToggleChip active={hat} icon={HardHat} label="Hat" onClick={() => setHat((v) => !v)} />
          <ToggleChip active={sunglasses} icon={Glasses} label="Sunglasses" onClick={() => setSunglasses((v) => !v)} />
          <ToggleChip active={sunscreen} icon={Shield} label="Sunscreen" onClick={() => setSunscreen((v) => !v)} />
        </div>

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>What were you wearing?</label>
        <div className="grid grid-cols-2 gap-2 mb-5">
          <ToggleChip active={shorts} icon={ShortsIcon} label="Shorts" onClick={() => setShorts((v) => !v)} />
          <ToggleChip active={shirt} icon={Shirt} label="Shirt" onClick={() => setShirt((v) => !v)} />
          <ToggleChip active={longSleeve} icon={LongSleeveIcon} label="Long sleeve" onClick={() => setLongSleeve((v) => !v)} />
          <ToggleChip active={shoes} icon={ShoeIcon} label="Shoes" onClick={() => setShoes((v) => !v)} />
        </div>

        <label className="text-xs uppercase tracking-wide mb-2 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Estimated light & exposure</label>
        <div className="mb-2">
          <LightProfileCard entry={previewEntry} profile={profile} idSuffix="preview" />
        </div>
        {location ? (
          <p className="text-[10px] leading-snug mb-5" style={{ color: palette.muted, fontFamily: "Inter" }}>
            Based on the sun's real position at {location.label}{sky ? `, ${sky.condition.toLowerCase()} skies` : ""}{profile?.skinType ? ", adjusted for your skin type" : ""}{profile?.age ? " and age" : ""}.
          </p>
        ) : (
          <div className="mb-5" />
        )}

        <button
          onClick={() => onSave({ startHour, duration, activity, sunscreen, hat, sunglasses, shorts, shirt, longSleeve, shoes, lat: location.lat, lng: location.lng, locationLabel: location.label, uvFactor: sky?.uvFactor, skyCondition: sky?.condition })}
          disabled={!location}
          className="w-full rounded-full py-3 text-sm font-medium flex items-center justify-center gap-2"
          style={{ background: palette.amber, color: palette.obsidian, fontFamily: "Inter", opacity: location ? 1 : 0.5 }}
        >
          <Check size={16} /> Save session
        </button>
      </div>
    </div>
  );
}

// ---------------- screens ----------------

function SunStoryScreen({ sessions, profile, nightLogs, onNavigate }) {
  const today = todayStr();
  const buckets = useMemo(() => hourlyBuckets(sessions, today), [sessions, today]);
  const totalMin = minutesFor(sessions, today);
  const morningMin = useMemo(() => {
    return sessions.filter((s) => s.date === today && s.startHour < 10).reduce((sum, s) => sum + s.duration, 0);
  }, [sessions, today]);

  // Circadian daily goal now lives on its own tab — this is just a compact
  // pointer to it, not the full graphic.
  const todaySunCircadian = useMemo(() => {
    const todaySessions = sessions.filter((s) => s.date === today);
    if (todaySessions.length === 0) return null;
    return Math.max(...todaySessions.map((s) => estimateSession(s, null).circadianDots));
  }, [sessions, today]);
  const dayAchieved = (todaySunCircadian ?? 0) >= 2;
  const exerciseAchieved = hadOutdoorExerciseToday(sessions, today);
  const nightCount = nightHabitCount(nightLogs?.[today]);
  const totalGoal = NIGHT_HABITS.length + 2;
  const completedGoal = nightCount + (dayAchieved ? 1 : 0) + (exerciseAchieved ? 1 : 0);

  const week = useMemo(() => lastNDays(7), []);
  const weekMinutesLast = week.length ? minutesFor(sessions, week[week.length - 1]) : 0;
  const priorWeekTotal = useMemo(() => {
    const prior = [];
    for (let i = 13; i >= 7; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      prior.push(d.toISOString().slice(0, 10));
    }
    return prior.reduce((sum, d) => sum + minutesFor(sessions, d), 0);
  }, [sessions]);
  const thisWeekTotal = useMemo(() => week.reduce((sum, d) => sum + minutesFor(sessions, d), 0), [sessions, week]);
  const pctChange = priorWeekTotal > 0 ? Math.round(((thisWeekTotal - priorWeekTotal) / priorWeekTotal) * 100) : null;

  const chartData = week.map((d) => ({ day: dayLabel(d), minutes: minutesFor(sessions, d) }));

  return (
    <div className="px-5 pt-6 pb-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </div>
          <div className="text-lg" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>
            {profile.name}'s Sun Story
          </div>
        </div>
        <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
          <Sun size={16} color={palette.amber} />
        </div>
      </div>

      <button
        onClick={() => onNavigate && onNavigate("goal")}
        className="w-full rounded-2xl px-4 py-3 my-3 flex items-center gap-3"
        style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}
      >
        <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: blendColor("#1D1B14", "#E3A73A", completedGoal / totalGoal) }}>
          <Target size={16} color={completedGoal / totalGoal > 0.55 ? palette.obsidian : palette.bone} />
        </div>
        <div className="flex-1 text-left">
          <div className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Circadian daily goal</div>
          <div className="text-[11px]" style={{ color: palette.muted, fontFamily: "Inter" }}>{completedGoal}/{totalGoal} today</div>
        </div>
        <ChevronRight size={16} color={palette.muted} />
      </button>

      <div className="flex justify-center my-3"><SunArc buckets={buckets} totalMin={totalMin} /></div>

      <div className="flex gap-3 mb-3">
        <StatCard label="Morning light" value={morningMin} unit="min" accent={palette.amber} />
        <StatCard label="This week" value={(thisWeekTotal / 60).toFixed(1)} unit="hrs" accent={palette.ocean} />
      </div>

      <div className="rounded-2xl px-4 py-3 mb-3" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
        <div className="flex items-center gap-2 mb-1">
          <Sunrise size={13} color={palette.amber} />
          <span className="text-xs uppercase tracking-wide" style={{ color: palette.muted, fontFamily: "Inter" }}>This week</span>
        </div>
        <p className="text-sm leading-snug" style={{ color: palette.bone, fontFamily: "Inter" }}>
          {totalMin === 0 && thisWeekTotal === 0
            ? "No sessions logged yet — tap the + button to log your first time outside."
            : pctChange === null
            ? `You've logged ${(thisWeekTotal / 60).toFixed(1)} hours outdoors this week.`
            : pctChange >= 0
            ? <>Outdoor time is up <span style={{ color: palette.amber }}>{pctChange}%</span> compared with last week.</>
            : <>Outdoor time is down <span style={{ color: palette.amber }}>{Math.abs(pctChange)}%</span> compared with last week.</>}
        </p>
      </div>

      {(() => {
        const todaySessions = sessions.filter((s) => s.date === today);
        if (todaySessions.length === 0) return null;
        return (
          <div className="rounded-2xl px-4 py-3 mb-3" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
            <div className="text-xs uppercase tracking-wide mb-2" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Today's light & protection <span style={{ opacity: 0.7 }}>(estimated)</span>
            </div>
            <div className="flex flex-col gap-2.5">
              {todaySessions.map((s) => {
                const est = estimateSession(s, profile);
                return (
                  <div key={s.id} className="pb-3" style={{ borderBottom: `1px solid ${palette.cardEdge}` }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs flex items-center gap-1.5" style={{ color: palette.bone, fontFamily: "IBM Plex Mono" }}>
                        {activityMeta(s.activity) && (() => { const Icon = activityMeta(s.activity).icon; return <Icon size={12} color={palette.amber} />; })()}
                        {activityMeta(s.activity) ? `${activityMeta(s.activity).label} · ` : ""}{formatHour(s.startHour)} · {s.duration}m
                      </span>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full"
                        style={{
                          background: est.tier === "Peak UV" ? palette.amber : "transparent",
                          color: est.tier === "Peak UV" ? palette.obsidian : tierColor(est.tier),
                          border: est.tier === "Peak UV" ? "none" : `1px solid ${tierColor(est.tier)}`,
                          fontFamily: "Inter",
                        }}
                      >
                        {est.tier}
                      </span>
                    </div>
                    {s.locationLabel && (
                      <div className="flex items-center gap-1 mb-1.5">
                        <LocateFixed size={10} color={palette.amber} />
                        <span className="text-[10px]" style={{ color: palette.muted, fontFamily: "Inter" }}>
                          {s.locationLabel} · precise{s.skyCondition ? ` · ${s.skyCondition.toLowerCase()}` : ""}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mb-2">
                      {s.hat && <HardHat size={11} color={palette.ocean} />}
                      {s.sunglasses && <Glasses size={11} color={palette.ocean} />}
                      {s.sunscreen && <Shield size={11} color={palette.ocean} />}
                      {s.shorts && <ShortsIcon size={11} color={palette.ocean} />}
                      {s.shirt && <Shirt size={11} color={palette.ocean} />}
                      {s.longSleeve && <LongSleeveIcon size={11} color={palette.ocean} />}
                      {s.shoes && <ShoeIcon size={11} color={palette.ocean} />}
                    </div>
                    <LightProfileCard entry={s} profile={profile} idSuffix={s.id} compact />
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] leading-snug mt-2" style={{ color: palette.muted, fontFamily: "Inter" }}>
              Estimated from time of day and season, adjusted for what you wore — not a direct UV measurement. Full spectral data arrives with SunTrace hardware.
            </p>
          </div>
        );
      })()}

      <div className="rounded-2xl px-4 py-3" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
        <div className="text-xs uppercase tracking-wide mb-2" style={{ color: palette.muted, fontFamily: "Inter" }}>7-day outdoor time</div>
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
            <XAxis dataKey="day" tick={{ fill: palette.muted, fontSize: 10, fontFamily: "Inter" }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip contentStyle={{ background: palette.obsidian, border: `1px solid ${palette.cardEdge}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: palette.bone }} itemStyle={{ color: palette.amber }} />
            <Line type="monotone" dataKey="minutes" stroke={palette.amber} strokeWidth={2} dot={{ r: 2, fill: palette.amber }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function HistoryScreen({ sessions }) {
  const days = useMemo(() => lastNDays(14).reverse(), []);
  const totals = days.map((d) => ({ date: d, minutes: minutesFor(sessions, d) }));
  const max = Math.max(1, ...totals.map((t) => t.minutes));

  return (
    <div className="px-5 pt-6 pb-4">
      <div className="text-lg mb-4" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>History</div>
      <div className="flex flex-col gap-2.5">
        {totals.map(({ date, minutes }) => (
          <div key={date} className="flex items-center gap-3">
            <span className="w-14 text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{dayLabel(date)}</span>
            <div className="flex-1 h-6 rounded-full overflow-hidden" style={{ background: palette.card }}>
              {minutes > 0 && (
                <div
                  className="h-full rounded-full flex items-center justify-end pr-2"
                  style={{ width: `${Math.max(8, (minutes / max) * 100)}%`, background: `linear-gradient(90deg, ${palette.amberDim}, ${palette.amber})` }}
                >
                  <span className="text-[10px]" style={{ color: palette.obsidian, fontFamily: "IBM Plex Mono", fontWeight: 500 }}>{minutes}m</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 text-xs leading-relaxed" style={{ color: palette.muted, fontFamily: "Inter" }}>
        Once SunTrace hardware is available, this fills in automatically instead of needing manual logs.
      </div>
    </div>
  );
}

function GoalScreen({ sessions, nightLogs, onToggleHabit }) {
  const today = todayStr();
  const todayEntry = nightLogs[today] || emptyNightEntry();
  const nightCount = nightHabitCount(todayEntry);

  // Best circadian signal reached today from logged sun sessions, to pair
  // morning-light effort with tonight's routine into one circadian picture.
  const todaySunCircadian = useMemo(() => {
    const todaySessions = sessions.filter((s) => s.date === today);
    if (todaySessions.length === 0) return null;
    return Math.max(...todaySessions.map((s) => estimateSession(s, null).circadianDots));
  }, [sessions, today]);

  const dayAchieved = (todaySunCircadian ?? 0) >= 2; // Moderate or High counts
  const exerciseAchieved = hadOutdoorExerciseToday(sessions, today);

  const goalItems = useMemo(() => ([
    { label: "Daylight", done: dayAchieved },
    { label: "Outdoor exercise", done: exerciseAchieved },
    ...NIGHT_HABITS.map((h) => ({ label: h.label, done: !!todayEntry[h.id] })),
  ]), [dayAchieved, exerciseAchieved, todayEntry]);
  const completedGoal = goalItems.filter((i) => i.done).length;
  const totalGoal = goalItems.length;

  const days = useMemo(() => lastNDays(7), []);

  let insight;
  if (completedGoal === 0) {
    insight = "Nothing logged yet today — real daylight, a bit of movement outside, and one or two wind-down habits all go a long way.";
  } else if (completedGoal >= 7) {
    insight = "Strong circadian day — light early, moved outside, wind down well tonight.";
  } else if (completedGoal >= 5) {
    insight = "Good progress. One more of daylight, a workout, or a night habit would round it out.";
  } else if (!dayAchieved) {
    insight = "Missing daylight today is the bigger gap — even a short morning session moves this more than the other two combined.";
  } else if (!exerciseAchieved) {
    insight = "Daylight's covered — a short walk, ride, or swim outside would add real circadian credit tonight.";
  } else {
    insight = "Daylight and movement are covered — the wind-down habits are what's left tonight.";
  }

  return (
    <div className="px-5 pt-6 pb-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>Today</div>
          <div className="text-lg" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Circadian daily goal</div>
        </div>
        <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
          <Target size={16} color={palette.amber} />
        </div>
      </div>

      <div className="rounded-2xl px-4 py-6 my-3" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
        <CircadianSunGoal items={goalItems} size={220} />
        <p className="text-xs leading-snug text-center mt-4" style={{ color: palette.bone, fontFamily: "Inter" }}>{insight}</p>
      </div>

      <div className="rounded-2xl overflow-hidden mb-4" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
        {goalItems.map((item, i) => (
          <div
            key={i}
            className="flex items-center justify-between px-4 py-2.5"
            style={{ borderBottom: i < goalItems.length - 1 ? `1px solid ${palette.cardEdge}` : "none" }}
          >
            <span className="text-xs" style={{ color: palette.bone, fontFamily: "Inter" }}>{item.label}</span>
            {item.done ? <Check size={14} color={palette.amber} /> : <div className="w-3.5 h-3.5 rounded-full" style={{ border: `1.5px solid ${palette.cardEdge}` }} />}
          </div>
        ))}
      </div>

      <div className="text-xs uppercase tracking-wide mb-2" style={{ color: palette.muted, fontFamily: "Inter" }}>Tap to log tonight's habits</div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {NIGHT_HABITS.map((h) => {
          const active = !!todayEntry[h.id];
          return (
            <button
              key={h.id}
              onClick={() => onToggleHabit(today, h.id)}
              className="flex flex-col items-start gap-1.5 rounded-xl px-3 py-2.5 text-left"
              style={{ background: active ? palette.amber : palette.card, border: `1px solid ${active ? palette.amber : palette.cardEdge}` }}
            >
              <h.icon size={15} color={active ? palette.obsidian : palette.ocean} />
              <span className="text-[11px] leading-snug" style={{ color: active ? palette.obsidian : palette.bone, fontFamily: "Inter" }}>{h.label}</span>
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl px-4 py-3" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
        <div className="text-xs uppercase tracking-wide mb-2" style={{ color: palette.muted, fontFamily: "Inter" }}>Past 7 nights</div>
        <div className="flex flex-col gap-2">
          {days.map((d) => {
            const c = nightHabitCount(nightLogs[d]);
            return (
              <div key={d} className="flex items-center gap-3">
                <span className="w-9 text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{dayLabel(d)}</span>
                <div className="flex-1 h-4 rounded-full overflow-hidden" style={{ background: palette.obsidian }}>
                  {c > 0 && (
                    <div className="h-full rounded-full" style={{ width: `${(c / NIGHT_HABITS.length) * 100}%`, background: `linear-gradient(90deg, ${palette.ocean}, #6FA3AB)` }} />
                  )}
                </div>
                <span className="w-8 text-right text-[10px]" style={{ color: palette.muted, fontFamily: "IBM Plex Mono" }}>{c}/{NIGHT_HABITS.length}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const MELANOMA_HISTORY_OPTIONS = [
  { id: "none", label: "No known history" },
  { id: "immediate", label: "Yes — parent/sibling" },
  { id: "extended", label: "Yes — extended family" },
];

function SettingsScreen({ profile, onUpdateProfile, onReset }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [locationLabel, setLocationLabel] = useState(profile.location);
  const [locatingHome, setLocatingHome] = useState(false);
  const [locationHomeError, setLocationHomeError] = useState(null);
  const [age, setAge] = useState(profile.age ?? "");
  const [sex, setSex] = useState(profile.sex || "");
  const [familyMelanomaHistory, setFamilyMelanomaHistory] = useState(profile.familyMelanomaHistory || "none");
  const [skinType, setSkinType] = useState(profile.skinType || "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeNote, setAnalyzeNote] = useState(null);
  const fileInputRef = React.useRef(null);

  const save = () => {
    onUpdateProfile({
      ...profile,
      name: name.trim() || profile.name,
      location: locationLabel || profile.location,
      age: age ? Number(age) : profile.age,
      sex: sex || profile.sex,
      familyMelanomaHistory,
      skinType: skinType || profile.skinType,
    });
    setEditing(false);
  };

  async function handleUseHomeLocation() {
    setLocatingHome(true);
    setLocationHomeError(null);
    try {
      const { lat, lng } = await getCurrentLocation();
      const label = await reverseGeocode(lat, lng);
      setLocationLabel(label);
    } catch (err) {
      setLocationHomeError(
        err && err.code === 1
          ? "Location permission denied — enable it in your browser/device settings."
          : "Couldn't get a location fix — try again."
      );
    } finally {
      setLocatingHome(false);
    }
  }

  async function handlePhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAnalyzing(true);
    setAnalyzeNote(null);
    try {
      const result = await analyzeSkinPhoto(file);
      setSkinType(result.fitzpatrick);
      setAnalyzeNote({ ok: true, confidence: result.confidence || "medium" });
    } catch (err) {
      setAnalyzeNote({ ok: false });
    } finally {
      setAnalyzing(false);
    }
  }

  const skinTypeLabel = FITZPATRICK_TYPES.find((t) => t.id === profile.skinType)?.label || "Not set";
  const melanomaLabel = MELANOMA_HISTORY_OPTIONS.find((o) => o.id === profile.familyMelanomaHistory)?.label || "Not set";
  const fieldStyle = "rounded-xl px-3 py-2 text-sm outline-none";
  const fieldBase = { background: palette.obsidian, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" };

  return (
    <div className="px-5 pt-6 pb-4">
      <div className="text-lg mb-4" style={{ color: palette.bone, fontFamily: "Fraunces", fontWeight: 500 }}>Settings</div>

      <div className="rounded-2xl overflow-hidden mb-4" style={{ background: palette.card, border: `1px solid ${palette.cardEdge}` }}>
        {!editing ? (
          <>
            <button onClick={() => setEditing(true)} className="w-full flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${palette.cardEdge}` }}>
              <div className="flex items-center gap-3">
                <MapPin size={15} color={palette.amber} />
                <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Location</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{profile.location}</span>
                <ChevronRight size={14} color={palette.muted} />
              </div>
            </button>
            <button onClick={() => setEditing(true)} className="w-full flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${palette.cardEdge}` }}>
              <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Age</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{profile.age ?? "Not set"}</span>
                <ChevronRight size={14} color={palette.muted} />
              </div>
            </button>
            <button onClick={() => setEditing(true)} className="w-full flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${palette.cardEdge}` }}>
              <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Sex</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{profile.sex === "F" ? "Female" : profile.sex === "M" ? "Male" : "Not set"}</span>
                <ChevronRight size={14} color={palette.muted} />
              </div>
            </button>
            <button onClick={() => setEditing(true)} className="w-full flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${palette.cardEdge}` }}>
              <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Family melanoma history</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{melanomaLabel}</span>
                <ChevronRight size={14} color={palette.muted} />
              </div>
            </button>
            <button onClick={() => setEditing(true)} className="w-full flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${palette.cardEdge}` }}>
              <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Skin type</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>{skinTypeLabel}</span>
                <ChevronRight size={14} color={palette.muted} />
              </div>
            </button>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <Bluetooth size={15} color={palette.amber} />
                <span className="text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>Device</span>
              </div>
              <span className="text-xs" style={{ color: palette.muted, fontFamily: "Inter" }}>Not connected — manual mode</span>
            </div>
          </>
        ) : (
          <div className="p-4 flex flex-col gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={fieldStyle} style={fieldBase} />

            <div>
              <label className="text-[10px] uppercase tracking-wide mb-1.5 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Location</label>
              <button
                onClick={handleUseHomeLocation}
                disabled={locatingHome}
                className="w-full rounded-xl py-2.5 px-3 flex items-center justify-between"
                style={{ background: palette.obsidian, border: `1px solid ${palette.cardEdge}` }}
              >
                <span className="flex items-center gap-2 text-sm" style={{ color: palette.bone, fontFamily: "Inter" }}>
                  {locatingHome ? <Loader2 size={14} className="animate-spin" color={palette.amber} /> : <LocateFixed size={14} color={palette.amber} />}
                  {locationLabel}
                </span>
                <span className="text-[10px]" style={{ color: palette.muted, fontFamily: "Inter" }}>{locatingHome ? "Locating…" : "Refresh via GPS"}</span>
              </button>
              {locationHomeError && (
                <p className="text-[11px] leading-snug mt-1.5" style={{ color: "#B8503A", fontFamily: "Inter" }}>{locationHomeError}</p>
              )}
            </div>

            <input value={age} onChange={(e) => setAge(e.target.value)} placeholder="Age" type="number" inputMode="numeric" className={fieldStyle} style={fieldBase} />

            <div className="flex gap-1.5">
              {[{ id: "F", label: "Female" }, { id: "M", label: "Male" }].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setSex(opt.id)}
                  className="flex-1 rounded-xl py-2 text-xs"
                  style={{
                    background: sex === opt.id ? palette.amber : palette.obsidian,
                    color: sex === opt.id ? palette.obsidian : palette.muted,
                    border: `1px solid ${sex === opt.id ? palette.amber : palette.cardEdge}`,
                    fontFamily: "Inter",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div>
              <label className="text-[10px] uppercase tracking-wide mb-1.5 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Family melanoma history</label>
              <div className="flex gap-1.5">
                {MELANOMA_HISTORY_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setFamilyMelanomaHistory(opt.id)}
                    className="flex-1 rounded-lg py-2 px-1 text-[10px] leading-tight"
                    style={{
                      background: familyMelanomaHistory === opt.id ? palette.amber : palette.obsidian,
                      color: familyMelanomaHistory === opt.id ? palette.obsidian : palette.muted,
                      border: `1px solid ${familyMelanomaHistory === opt.id ? palette.amber : palette.cardEdge}`,
                      fontFamily: "Inter",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] uppercase tracking-wide mb-1.5 block" style={{ color: palette.muted, fontFamily: "Inter" }}>Skin type</label>
              <select value={skinType} onChange={(e) => { setSkinType(e.target.value); setAnalyzeNote(null); }} className={fieldStyle} style={{ ...fieldBase, appearance: "auto", width: "100%" }}>
                <option value="" disabled>Select a skin type…</option>
                {FITZPATRICK_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} — {t.desc}</option>
                ))}
              </select>

              <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: "none" }} />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={analyzing}
                className="w-full rounded-xl py-2.5 text-xs flex items-center justify-center gap-2 mt-2"
                style={{ background: palette.obsidian, border: `1px solid ${palette.cardEdge}`, color: palette.bone, fontFamily: "Inter" }}
              >
                {analyzing ? (
                  <><Loader2 size={13} className="animate-spin" /> Analyzing photo…</>
                ) : (
                  "Not sure? Estimate from a photo of your inner forearm"
                )}
              </button>
              {analyzeNote?.ok && (
                <p className="text-[11px] mt-1.5" style={{ color: palette.amber, fontFamily: "Inter" }}>
                  Estimated Type {skinType} from your photo ({analyzeNote.confidence} confidence) — adjust above if needed.
                </p>
              )}
              {analyzeNote && !analyzeNote.ok && (
                <p className="text-[11px] mt-1.5" style={{ color: palette.muted, fontFamily: "Inter" }}>
                  Couldn't read that photo clearly — pick your skin type from the list instead.
                </p>
              )}
              <p className="text-[10px] leading-snug mt-1.5" style={{ color: palette.muted, fontFamily: "Inter" }}>
                The photo is sent once for analysis and never saved.
              </p>
            </div>

            <button onClick={save} className="rounded-xl py-2 text-sm font-medium" style={{ background: palette.amber, color: palette.obsidian, fontFamily: "Inter" }}>Save</button>
          </div>
        )}
      </div>

      <p className="text-xs leading-relaxed mb-4" style={{ color: palette.muted, fontFamily: "Inter" }}>
        No cloud account required. Your data stays on this device. Future hardware will sync over an encrypted,
        on-demand Bluetooth connection — never a continuous background link.
      </p>

      <button onClick={onReset} className="text-xs" style={{ color: palette.muted, fontFamily: "Inter", textDecoration: "underline" }}>
        Reset all data
      </button>
    </div>
  );
}

// ---------------- shell ----------------

const TABS = [
  { id: "story", label: "Sun Story", icon: Sun, screen: SunStoryScreen },
  { id: "goal", label: "Goal", icon: Target, screen: GoalScreen },
  { id: "history", label: "History", icon: HistoryIcon, screen: HistoryScreen },
  { id: "settings", label: "Settings", icon: Settings, screen: SettingsScreen },
];

export default function SunApp() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [nightLogs, setNightLogs] = useState({});
  const [tab, setTab] = useState("story");
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    (async () => {
      const p = await loadJSON(PROFILE_KEY, null);
      const s = await loadJSON(SESSIONS_KEY, []);
      const n = await loadJSON(NIGHT_KEY, {});
      setProfile(p);
      setSessions(s);
      setNightLogs(n);
      setLoading(false);
    })();
  }, []);

  const finishOnboarding = useCallback(async (p) => {
    const full = { ...p, onboarded: true };
    setProfile(full);
    await saveJSON(PROFILE_KEY, full);
  }, []);

  const updateProfile = useCallback(async (p) => {
    setProfile(p);
    await saveJSON(PROFILE_KEY, p);
  }, []);

  const addSession = useCallback(async ({ startHour, duration, activity, sunscreen, hat, sunglasses, shorts, shirt, longSleeve, shoes, lat, lng, locationLabel, uvFactor, skyCondition }) => {
    const entry = { id: `${Date.now()}`, date: todayStr(), startHour, duration, activity, sunscreen, hat, sunglasses, shorts, shirt, longSleeve, shoes, lat, lng, locationLabel, uvFactor, skyCondition };
    const next = [...sessions, entry];
    setSessions(next);
    await saveJSON(SESSIONS_KEY, next);
    setShowLog(false);
  }, [sessions]);

  const toggleNightHabit = useCallback(async (date, habitId) => {
    setNightLogs((prev) => {
      const current = prev[date] || emptyNightEntry();
      const next = { ...prev, [date]: { ...current, [habitId]: !current[habitId] } };
      saveJSON(NIGHT_KEY, next);
      return next;
    });
  }, []);

  const resetAll = useCallback(async () => {
    setSessions([]);
    setProfile(null);
    setNightLogs({});
    await saveJSON(SESSIONS_KEY, []);
    await saveJSON(NIGHT_KEY, {});
    try { await window.storage.delete(PROFILE_KEY, false); } catch {}
  }, []);

  const Active = useMemo(() => TABS.find((t) => t.id === tab).screen, [tab]);

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6" style={{ background: "#0B0A08" }}>
      <style>{FONT_IMPORT}</style>
      <div
        className="w-[340px] h-[700px] rounded-[2.5rem] overflow-hidden flex flex-col relative"
        style={{ background: palette.obsidian, border: `1px solid ${palette.cardEdge}`, boxShadow: "0 30px 60px rgba(0,0,0,0.5)" }}
      >
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="animate-spin" size={22} color={palette.amber} />
          </div>
        ) : !profile || !profile.onboarded ? (
          <Onboarding onDone={finishOnboarding} />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto relative">
              <Active sessions={sessions} profile={profile} nightLogs={nightLogs} onToggleHabit={toggleNightHabit} onUpdateProfile={updateProfile} onReset={resetAll} onNavigate={setTab} />
              {tab === "story" && (
                <button
                  onClick={() => setShowLog(true)}
                  className="absolute bottom-4 right-4 w-12 h-12 rounded-full flex items-center justify-center shadow-lg"
                  style={{ background: palette.amber }}
                >
                  <Plus size={22} color={palette.obsidian} />
                </button>
              )}
              {showLog && <LogSheet onClose={() => setShowLog(false)} onSave={addSession} profile={profile} />}
            </div>
            <div className="flex items-stretch border-t" style={{ borderColor: palette.cardEdge }}>
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)} className="flex-1 flex flex-col items-center gap-1 py-3" style={{ background: palette.obsidian }}>
                  <t.icon size={17} color={tab === t.id ? palette.amber : palette.muted} />
                  <span className="text-[10px]" style={{ color: tab === t.id ? palette.amber : palette.muted, fontFamily: "Inter" }}>{t.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
