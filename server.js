import express from "express";
import cors from "cors";
import { spawn } from "child_process";

const app = express();

// =========================
// Config
// =========================
const PORT = process.env.PORT || 3000;
const RATE_LIMIT = 15;
const WINDOW_MS = 60 * 1000;
const MAX_STDOUT = 5 * 1024 * 1024; // 5MB safety

// =========================
// Middleware
// =========================
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =========================
// Rate limiter (fixed)
// =========================
const requestMap = new Map();

app.use((req, res, next) => {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown";

  const now = Date.now();
  const timestamps = requestMap.get(ip) || [];

  const filtered = timestamps.filter((t) => now - t < WINDOW_MS);
  filtered.push(now);
  requestMap.set(ip, filtered);

  if (filtered.length > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests" });
  }

  next();
});

// Cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of requestMap.entries()) {
    const filtered = timestamps.filter((t) => now - t < WINDOW_MS);
    if (filtered.length === 0) {
      requestMap.delete(ip);
    } else {
      requestMap.set(ip, filtered);
    }
  }
}, WINDOW_MS);

// =========================
// Security helpers
// =========================
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isAllowedDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname.includes("youtube.com") ||
      hostname.includes("youtu.be") ||
      hostname.includes("facebook.com")
    );
  } catch {
    return false;
  }
}

// =========================
// Utils
// =========================
function formatSize(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return null;
  return `${(Number(bytes) / (1024 * 1024)).toFixed(2)} MB`;
}

function videoLabelFromHeight(h) {
  const height = Number(h || 0);
  if (height <= 144) return "144p";
  if (height <= 240) return "240p";
  if (height <= 360) return "360p";
  if (height <= 480) return "480p";
  if (height <= 720) return "720p";
  if (height <= 1080) return "1080p";
  if (height <= 1440) return "2K";
  if (height <= 2160) return "4K";
  return `${height}p`;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// =========================
// yt-dlp execution (SAFE)
// =========================
function extractInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ["-J", "--no-playlist", url];

    const child = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Extraction timeout"));
      }
    }, 20000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT) {
        child.kill("SIGKILL");
        reject(new Error("Output too large"));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        return reject(
          new Error(stderr.trim() || `yt-dlp exited with ${code}`)
        );
      }

      const parsed = safeParseJson(stdout);
      if (!parsed) return reject(new Error("JSON parse failed"));

      resolve(parsed);
    });
  });
}

// =========================
// API
// =========================
app.post("/download", async (req, res) => {
  try {
    const { url } = req.body ?? {};

    if (!url) {
      return res.status(400).json({ error: "URL required" });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    if (!isAllowedDomain(url)) {
      return res.status(400).json({ error: "Unsupported platform" });
    }

    const data = await extractInfo(url);
    const formats = Array.isArray(data.formats) ? data.formats : [];

    const audio = formats.filter((f) => f.vcodec === "none" && f.url);
    const video = formats.filter((f) => f.vcodec !== "none" && f.acodec !== "none" && f.url);

    return res.json({
      title: data.title || null,
      thumbnail: data.thumbnail || null,
      duration: data.duration || null,
      audio,
      video,
    });

  } catch (err) {
    console.error("ERROR:", err);

    return res.status(500).json({
      error: "Extraction failed",
      message: err.message || "Internal error",
    });
  }
});

// =========================
// Health
// =========================
app.get("/", (_req, res) => {
  res.json({ ok: true });
});

// =========================
// Start
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});