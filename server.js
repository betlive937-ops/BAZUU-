const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.BAZUU_ADMIN_USER;
const ADMIN_PASSWORD = process.env.BAZUU_ADMIN_PASSWORD;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "bazuu.json");

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error("Set BAZUU_ADMIN_USER and BAZUU_ADMIN_PASSWORD before starting.");
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 14) {
  console.error("BAZUU_ADMIN_PASSWORD must be at least 14 characters.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
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

// This page explains the analytics before the visitor chooses to continue.
app.get("/r/:id", (req, res) => {
  const link = data.links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).send("This BAZUU link does not exist.");
  const safeTitle = escapeHtml(link.title);
  const safeDestination = escapeHtml(link.destination);
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue — BAZUU</title><style>
  body{font:16px system-ui;background:#10131b;color:#eef2ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
  main{max-width:520px;background:#1b2230;border:1px solid #30394a;border-radius:18px;padding:28px;box-sizing:border-box}
  h1{margin-top:0}p{line-height:1.6;color:#c5cede}.muted{font-size:13px;color:#98a6ba;overflow-wrap:anywhere}
  button{background:#7c9cff;color:#10131b;border:0;border-radius:10px;padding:13px 18px;font-weight:700;font-size:16px;cursor:pointer}
  </style></head><body><main><h1>Continue to your link</h1><p><strong>${safeTitle}</strong></p>
  <p>This link uses BAZUU click analytics. If you choose to continue, BAZUU records the time of the click, your browser/device category, and referring page when your browser provides it. BAZUU does <strong>not</strong> store your IP address or access your GPS location.</p>
  <p class="muted">Destination: ${safeDestination}</p>
  <button id="continue">Continue to destination</button>
  <p class="muted">If you do not want this click recorded, close this page.</p>
  </main><script>
  document.getElementById('continue').addEventListener('click', async function(){
    this.disabled=true; this.textContent='Continuing…';
    try {
      await fetch('/api/click/${link.id}', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({consent:true})});
    } catch(e) {}
    window.location.assign(${JSON.stringify(link.destination)});
  });
  </script></body></html>`);
});

app.post("/api/click/:id", clickLimiter, (req, res) => {
  const link = data.links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: "Link not found." });
  if (req.body.consent !== true) return res.status(400).json({ error: "Visitor consent is required." });
  const ua = String(req.get("user-agent") || "").slice(0, 300);
  const referrer = String(req.get("referer") || "").slice(0, 500);
  const device = /mobile|android|iphone/i.test(ua) ? "Mobile" : (/ipad|tablet/i.test(ua) ? "Tablet" : "Desktop/Other");
  const browser = ua.includes("Edg/") ? "Edge" : (ua.includes("Firefox/") ? "Firefox" : (ua.includes("Chrome/") ? "Chrome" : (ua.includes("Safari/") ? "Safari" : "Other")));
  data.clicks.push({ id: crypto.randomBytes(8).toString("hex"), linkId: link.id, clickedAt: new Date().toISOString(), device, browser, referrer: referrer || "Not provided" });
  if (data.clicks.length > 10000) data.clicks = data.clicks.slice(-10000);
  saveData();
  res.json({ ok: true });
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

app.listen(PORT, () => console.log(`BAZUU running on port ${PORT}`));
