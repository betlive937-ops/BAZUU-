const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.BAZUU_ADMIN_USER;
const ADMIN_PASSWORD = process.env.BAZUU_ADMIN_PASSWORD;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "bazuu.json");
const LANDMARKS_FILE = path.join(__dirname, "landmarks.json");
let LANDMARKS = [];

try {
  LANDMARKS = JSON.parse(fs.readFileSync(LANDMARKS_FILE, "utf8"));
  if (!Array.isArray(LANDMARKS)) throw new Error("Invalid landmark data");
  console.log(`Loaded ${LANDMARKS.length} local landmarks.`);
} catch (error) {
  console.error("Local landmark data could not be loaded:", error.message);
}

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error("Set BAZUU_ADMIN_USER and BAZUU_ADMIN_PASSWORD before starting.");
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 14) {
  console.error("BAZUU_ADMIN_PASSWORD must be at least 14 characters.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const GEOCODE_CACHE_FILE = path.join(DATA_DIR, "nominatim-cache.json");
let geocodeCache = {};
try {
  geocodeCache = JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, "utf8"));
  if (!geocodeCache || typeof geocodeCache !== "object" || Array.isArray(geocodeCache)) {
    geocodeCache = {};
  }
} catch {
  geocodeCache = {};
}

function saveGeocodeCache() {
  const temp = GEOCODE_CACHE_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(geocodeCache), { mode: 0o600 });
  fs.renameSync(temp, GEOCODE_CACHE_FILE);
}

let nominatimQueue = Promise.resolve();
let nominatimLastRequestAt = 0;

function queuedNominatimRequest(url) {
  const request = nominatimQueue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - nominatimLastRequestAt));
    if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    nominatimLastRequestAt = Date.now();

    return fetch(url, {
      headers: {
        "User-Agent": "BAZUU/1.0 (https://bazuu-tj9b.onrender.com)"
      },
      signal: AbortSignal.timeout(7000)
    });
  });

  nominatimQueue = request.catch(() => {});
  return request;
}
function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { links: Array.isArray(parsed.links) ? parsed.links : [], clicks: Array.isArray(parsed.clicks) ? parsed.clicks : [] };
  } catch {
    return { links: [], clicks: [] };
  }
}
let data = loadData();
function saveData() {
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function adminOnly(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="BAZUU Admin", charset="UTF-8"');
    return res.status(401).send("Authentication required.");
  }
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch {}
  const split = decoded.indexOf(":");
  const user = split >= 0 ? decoded.slice(0, split) : "";
  const pass = split >= 0 ? decoded.slice(split + 1) : "";
  const userOk = crypto.timingSafeEqual(Buffer.from(user.padEnd(256).slice(0,256)), Buffer.from(ADMIN_USER.padEnd(256).slice(0,256)));
  const passOk = crypto.timingSafeEqual(Buffer.from(pass.padEnd(256).slice(0,256)), Buffer.from(ADMIN_PASSWORD.padEnd(256).slice(0,256)));
  if (!userOk || !passOk) {
    res.set("WWW-Authenticate", 'Basic realm="BAZUU Admin", charset="UTF-8"');
    return res.status(401).send("Incorrect username or password.");
  }
  next();
}
const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const clickLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true, service: "BAZUU" }));

app.get("/admin", adminOnly, (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/api/links", adminOnly, (_req, res) => {
  const links = data.links.map(link => ({
    ...link,
    clickCount: data.clicks.filter(c => c.linkId === link.id).length,
    shortUrl: `${BASE_URL || ""}/r/${link.id}`
  }));
  res.json(links);
});

app.post("/api/links", adminOnly, createLimiter, (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 80);
  const destination = String(req.body.destination || "").trim();
  if (!title || !destination) return res.status(400).json({ error: "Enter a link name and destination URL." });
  let parsed;
  try { parsed = new URL(destination); } catch { return res.status(400).json({ error: "Enter a valid URL." }); }
  if (!["http:", "https:"].includes(parsed.protocol)) return res.status(400).json({ error: "Only HTTP and HTTPS links are allowed." });
  const id = crypto.randomBytes(5).toString("hex");
  data.links.unshift({ id, title, destination: parsed.toString(), createdAt: new Date().toISOString() });
  saveData();
  res.status(201).json({ id, title, destination: parsed.toString(), shortUrl: `${BASE_URL || ""}/r/${id}` });
});

app.get("/api/clicks/:id", adminOnly, (req, res) => {
  if (!data.links.some(l => l.id === req.params.id)) return res.status(404).json({ error: "Link not found." });
  const clicks = data.clicks.filter(c => c.linkId === req.params.id).slice(-200).reverse();
  res.json(clicks);
});

app.get("/r/:id", (req, res) => {
  const link = data.links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).send("This BAZUU link does not exist.");

  const safeTitle = escapeHtml(link.title);
  const safeDestination = escapeHtml(link.destination);

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Continue Ã¢â‚¬â€ BAZUU</title>
<style>
body{font:16px system-ui;background:#10131b;color:#eef2ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
main{max-width:520px;background:#1b2230;border:1px solid #30394a;border-radius:18px;padding:28px;box-sizing:border-box}
h1{margin-top:0}
p{line-height:1.6;color:#c5cede}
.muted{font-size:13px;color:#98a6ba;overflow-wrap:anywhere}
button{display:block;width:100%;margin-top:12px;background:#7c9cff;color:#10131b;border:0;border-radius:10px;padding:13px 18px;font-weight:700;font-size:16px;cursor:pointer}
button.secondary{background:#30394a;color:#eef2ff}
button:disabled{opacity:.6;cursor:wait}
</style>
</head>
<body>
<main>
<h1>Continue to your link</h1>
<p><strong>${safeTitle}</strong></p>
<p>Would you like to allow approximate location analytics? Your choice will not prevent you from visiting the destination.</p>
<p><strong>Location analytics:</strong> If you select Yes, your browser may ask permission to share your device location. If allowed, BAZUU sends your coordinates to external mapping services to estimate your area and identify nearby public landmarks such as schools and churches. If GPS is unavailable or denied, BAZUU uses approximate IP-based location instead. External providers process the information needed for these lookups. BAZUU does not save raw GPS coordinates or raw IP addresses in click records. You can select No to skip location collection.</p>
<p class="muted">Location results are visible only in the authenticated BAZUU admin dashboard.</p>
<p class="muted">Destination: ${safeDestination}</p>
<button id="locationYes">Yes</button>
<button id="locationNo" class="secondary">No</button>
<p class="muted">Your choice does not prevent you from visiting the destination.</p>
</main>
<script>
async function continueToDestination(locationConsent) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach(button => button.disabled = true);

  let gps = null;

  if (locationConsent && "geolocation" in navigator) {
    gps = await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        position => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy
        }),
        () => resolve(null),
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 0
        }
      );
    });
  }

  try {
    await fetch("/api/click/${link.id}", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        consent: true,
        locationConsent,
        gps
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    console.error("Click recording failed:", error);
  }

  window.location.assign(${JSON.stringify(link.destination)});
}

document.getElementById("locationYes").addEventListener("click", () => continueToDestination(true));
document.getElementById("locationNo").addEventListener("click", () => continueToDestination(false));
</script>
</body>
</html>`);
});
app.post("/api/click/:id", clickLimiter, (req, res) => {
  const link = data.links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: "Link not found." });
  if (req.body.consent !== true) return res.status(400).json({ error: "Visitor consent is required." });

  const ua = String(req.get("user-agent") || "").slice(0, 300);
  const referrer = String(req.get("referer") || "").slice(0, 500);
  const device = /mobile|android|iphone/i.test(ua) ? "Mobile" : (/ipad|tablet/i.test(ua) ? "Tablet" : "Desktop/Other");
  const browser = ua.includes("Edg/") ? "Edge" : (ua.includes("Firefox/") ? "Firefox" : (ua.includes("Chrome/") ? "Chrome" : (ua.includes("Safari/") ? "Safari" : "Other")));

  const click = {
    id: crypto.randomBytes(8).toString("hex"),
    linkId: link.id,
    clickedAt: new Date().toISOString(),
    device,
    browser,
    referrer: referrer || "Not provided",
    location: null
  };

  data.clicks.push(click);
  if (data.clicks.length > 10000) data.clicks = data.clicks.slice(-10000);
  saveData();

  res.json({ ok: true });

  if (req.body.locationConsent === true) {
    const gps = req.body.gps;
    const visitorIp = req.ip;

    (async () => {
      try {
        let location = null;

        const validGps = gps &&
          Number.isFinite(gps.latitude) &&
          Number.isFinite(gps.longitude) &&
          gps.latitude >= -90 && gps.latitude <= 90 &&
          gps.longitude >= -180 && gps.longitude <= 180;

        if (validGps) {
          try {
            location = await lookupGpsLocation(
              gps.latitude,
              gps.longitude,
              Number.isFinite(gps.accuracy) ? gps.accuracy : null
            );
          } catch (error) {
            console.error("GPS location lookup failed:", error.message);
          }
        }

        if (!location && visitorIp) {
          try {
            location = await lookupIpLocation(visitorIp);
          } catch (error) {
            console.error("IP location lookup failed:", error.message);
          }
        }

        if (location) {
          click.location = location;
          saveData();
        }
      } catch (error) {
        console.error("Location processing failed:", error.message);
      }
    })();
  }
});
app.get("/api/summary", adminOnly, (_req, res) => {
  res.json({
    links: data.links.length,
    clicks: data.clicks.length,
    recent: data.clicks.slice(-10).reverse()
  });
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}


function distanceBetweenMeters(lat1, lon1, lat2, lon2) {
  const toRad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function lookupGpsLocation(latitude, longitude, accuracy) {
  let address = {};

  try {
    const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;

    if (geocodeCache[cacheKey]) {
      address = geocodeCache[cacheKey];
    } else {
      const reverseUrl = new URL("https://nominatim.openstreetmap.org/reverse");
      reverseUrl.search = new URLSearchParams({
        format: "jsonv2",
        lat: String(latitude),
        lon: String(longitude),
        zoom: "18",
        addressdetails: "1"
      }).toString();

      const reverseResponse = await queuedNominatimRequest(reverseUrl);

      if (reverseResponse.ok) {
        const reverse = await reverseResponse.json();
        address = reverse.address || {};
        geocodeCache[cacheKey] = address;
        saveGeocodeCache();
      }
    }
  } catch (error) {
    console.error("GPS address lookup failed:", error.message);
  }

  const area = address.neighbourhood ||
    address.suburb ||
    address.quarter ||
    address.village ||
    address.town ||
    address.city_district ||
    address.city ||
    address.county ||
    null;

  let landmark = null;
  let nearestDistance = Infinity;

  for (const item of LANDMARKS) {
    if (!item ||
        typeof item.name !== "string" ||
        !Number.isFinite(item.latitude) ||
        !Number.isFinite(item.longitude)) {
      continue;
    }

    const distance = distanceBetweenMeters(
      latitude,
      longitude,
      item.latitude,
      item.longitude
    );

    if (distance <= 1500 && distance < nearestDistance) {
      nearestDistance = distance;
      landmark = {
        name: item.name.slice(0, 150),
        type: item.type,
        distanceMeters: Math.round(distance)
      };
    }
  }

  return {
    country: String(address.country || "Unknown").slice(0, 100),
    region: String(address.state || address.county || "Unknown").slice(0, 100),
    city: String(address.city || address.town || address.village || "Unknown").slice(0, 100),
    neighbourhood: area ? String(area).slice(0, 150) : null,
    landmark,
    accuracyMeters: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    source: "gps"
  };
}
async function lookupIpLocation(visitorIp) {
  const response = await fetch(
    `https://ipwho.is/${encodeURIComponent(visitorIp)}?fields=success,country,region,city`,
    { signal: AbortSignal.timeout(5000) }
  );

  if (!response.ok) throw new Error("IP location lookup unavailable.");

  const result = await response.json();
  if (result.success !== true) return null;

  return {
    country: String(result.country || "Unknown").slice(0, 100),
    region: String(result.region || "Unknown").slice(0, 100),
    city: String(result.city || "Unknown").slice(0, 100),
    neighbourhood: null,
    landmark: null,
    accuracyMeters: null,
    source: "ip"
  };
}

app.listen(PORT, () => console.log(`BAZUU running on port ${PORT}`));
