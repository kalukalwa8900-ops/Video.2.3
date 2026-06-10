const express = require("express");
const multer  = require("multer");
const cors    = require("cors");
const ffmpeg  = require("fluent-ffmpeg");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const { execSync, spawn } = require("child_process");
const AdmZip  = require("adm-zip");

const app          = express();
const PORT         = process.env.PORT || 8080;
const RENDERER_NAME = process.env.RENDERER_NAME || "renderer";

// ════════════════════════════════════════════════════════════════
// RENDER CONSTANTS — tune here, apply everywhere
// ════════════════════════════════════════════════════════════════

const RC = {
  // Output resolution
  W: 1280,
  H: 720,

  // Encoding — optimised for speed vs. quality on 1-CPU Railway containers
  PRESET:        "veryfast",
  CRF:           26,          // 24-28 sweet-spot; lower = better quality / bigger file
  THREADS:       1,           // 1 thread = stable RAM; no parallelism fighting itself
  PIX_FMT:       "yuv420p",
  AUDIO_BITRATE: "128k",
  MOVFLAGS:      "+faststart",

  // Ken-Burns internal fps (zoompan is expensive; keep it low)
  ZOOMPAN_FPS:   15,

  // Zoom — subtle, cinematic, never aggressive
  ZOOM_AMOUNT:   1.02,        // 2 % extra headroom for pan/zoom
  PAN_PIXELS:    8,           // pixel offset for slide effects
  PAN_PIXELS_Y:  5,

  // Concat
  BATCH_SIZE:    50,          // segments per batch in recursive merge
  XFADE_MAX:     12,          // use xfade only for ≤ 12 clips
  XFADE_DUR:     0.5,         // seconds of crossfade

  // Watermark defaults
  WM_POSITION:   "bottom-right",
  WM_MARGIN:     20,
  WM_OPACITY:    0.2,
  WM_SCALE:      0.15,        // fraction of frame width

  // Segment retry
  MAX_RETRIES:   2,

  // Job eviction
  JOB_TTL_MS:    3 * 60 * 60 * 1000,
  FILE_TTL_MS:   2 * 60 * 60 * 1000,
  CLEANUP_INT:   30 * 60 * 1000,
};

// ════════════════════════════════════════════════════════════════
// FFmpeg detection
// ════════════════════════════════════════════════════════════════

function validateFFmpegInstallation() {
  const candidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/ffmpeg/bin/ffmpeg", "ffmpeg"];
  for (const p of candidates) {
    try {
      const r = execSync(`${p} -version 2>&1`, { encoding: "utf-8" });
      if (r.includes("ffmpeg version")) { console.log(`✓ FFmpeg: ${p}`); return p; }
    } catch (_) {}
  }
  console.error("❌ CRITICAL: FFmpeg not installed"); process.exit(1);
}

const FFMPEG_PATH  = validateFFmpegInstallation();
const FFPROBE_PATH = FFMPEG_PATH.replace("ffmpeg", "ffprobe");
ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

// ════════════════════════════════════════════════════════════════
// Middleware
// ════════════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ extended: true, limit: "2gb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));
app.use((req, _res, next) => { console.log(`${req.method} ${req.originalUrl}`); next(); });
// Auth placeholder — add bearer check here if needed
app.use((_req, _res, next) => next());

// ════════════════════════════════════════════════════════════════
// Directories
// ════════════════════════════════════════════════════════════════

const UPLOADS_ROOT     = path.join(__dirname, "uploads");
const VIDEOS_ROOT      = path.join(UPLOADS_ROOT, "videos");
const WATERMARKS_ROOT  = path.join(UPLOADS_ROOT, "watermarks");
const IMAGES_ROOT      = path.join(UPLOADS_ROOT, "images");
const OUTPUT_ROOT      = path.join(__dirname, "output");
const TEMP_ROOT        = path.join(__dirname, "temp");

[UPLOADS_ROOT, VIDEOS_ROOT, WATERMARKS_ROOT, IMAGES_ROOT, OUTPUT_ROOT, TEMP_ROOT].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ════════════════════════════════════════════════════════════════
// In-memory job store
// ════════════════════════════════════════════════════════════════

const jobs = {};

function createJob() {
  const jobId = crypto.randomBytes(8).toString("hex");
  jobs[jobId] = { status: "queued", progress: 0, url: null, error: null, createdAt: new Date() };
  return jobId;
}
function updateJob(id, patch) { if (jobs[id]) Object.assign(jobs[id], patch); }
function scheduleJobEviction(id) { setTimeout(() => { delete jobs[id]; }, RC.JOB_TTL_MS); }

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function safeName(v, fallback) {
  return (String(v || fallback || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)) || fallback;
}

function extFor(file, fallback) {
  const ext = file?.originalname ? path.extname(file.originalname) : "";
  if (ext) return ext.toLowerCase();
  const m = (file?.mimetype || "").toLowerCase();
  if (m.includes("jpeg")) return ".jpg";
  if (m.includes("png"))  return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("wav"))  return ".wav";
  if (m.includes("mp3") || m.includes("mpeg")) return ".mp3";
  if (m.includes("mp4")) return ".mp4";
  return fallback;
}

function wrapText(text, maxW = 44) {
  if (!text?.trim()) return "";
  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const c = line ? `${line} ${w}` : w;
    if (c.length <= maxW) { line = c; }
    else { if (line) lines.push(line); line = w.slice(0, maxW); }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function cleanupFiles(files = []) {
  for (const f of files) { try { fs.unlinkSync(f); } catch (_) {} }
}

function normalizeFfmpegPath(p) {
  return p ? String(p).replace(/\\/g, "/") : p;
}

function parseMaybeJson(v, fallback = {}) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch (_) { return fallback; }
}

function isValidWatermarkFile(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || file?.filename || "").toLowerCase();
  return ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mime) || [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
}

function isValidVideoFile(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || file?.filename || "").toLowerCase();
  return mime.startsWith("video/") || [".mp4", ".mov", ".m4v", ".webm", ".mkv"].includes(ext);
}

function logUploadedFiles(req) {
  const summary = {};
  for (const [field, files] of Object.entries(req.files || {})) {
    summary[field] = (files || []).map(f => ({
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      path: normalizeFfmpegPath(f.path),
    }));
  }
  console.log("[upload] req.files:", JSON.stringify(summary, null, 2));
}

// ════════════════════════════════════════════════════════════════
// Smart FPS — fewer frames = lighter FFmpeg
// ════════════════════════════════════════════════════════════════

function getFps(panelCount) {
  if (panelCount <= 100)  return 24;
  if (panelCount <= 500)  return 20;
  if (panelCount <= 1000) return 15;
  return 12;
}

// ════════════════════════════════════════════════════════════════
// Audio probe
// ════════════════════════════════════════════════════════════════

function getAudioDuration(audioPath) {
  return new Promise(resolve => {
    if (!fs.existsSync(audioPath)) return resolve({ valid: false, reason: "file missing" });
    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) return resolve({ valid: false, reason: err.message });
      const s = data.streams?.find(s => s.codec_type === "audio");
      if (!s)  return resolve({ valid: false, reason: "no audio stream" });
      const dur = parseFloat(s.duration || data.format?.duration || 0);
      if (!dur || dur <= 0) return resolve({ valid: false, reason: "invalid duration" });
      resolve({ valid: true, duration: dur });
    });
  });
}

// ════════════════════════════════════════════════════════════════
// Image probe
// ════════════════════════════════════════════════════════════════

function getImageDimensions(imagePath) {
  return new Promise(resolve => {
    if (!fs.existsSync(imagePath)) return resolve({ valid: false });
    ffmpeg.ffprobe(imagePath, (err, data) => {
      if (err) return resolve({ valid: false });
      const s = data.streams?.find(s => s.codec_type === "video");
      if (!s || !s.width || !s.height) return resolve({ valid: false });
      resolve({ valid: true, width: s.width, height: s.height, aspectRatio: s.width / s.height });
    });
  });
}

// ════════════════════════════════════════════════════════════════
// Panel duration calculator
// ════════════════════════════════════════════════════════════════

async function calculatePanelDuration(panel) {
  const PAD = 0.2;

  if (panel.audio && panel.audio_source === "zip") {
    const r = await getAudioDuration(path.join(panel.dir, panel.audio));
    if (r.valid) { console.log(`[panel ${panel.index + 1}] zip audio → ${r.duration.toFixed(1)}s + ${PAD}s`); return r.duration + PAD; }
    throw new Error(`Panel ${panel.index + 1} audio corrupted: ${r.reason}`);
  }
  if (panel.tts_duration && panel.tts_provider === "edge") {
    const dur = panel.tts_duration + PAD;
    console.log(`[panel ${panel.index + 1}] Edge TTS → ${dur.toFixed(1)}s`);
    return dur;
  }
  if (panel.tts_duration && panel.tts_provider === "gtts") {
    const dur = panel.tts_duration + PAD;
    console.log(`[panel ${panel.index + 1}] gTTS → ${dur.toFixed(1)}s`);
    return dur;
  }
  if (panel.narration) {
    const wc  = String(panel.narration).split(/\s+/).filter(Boolean).length;
    const dur = Math.max(3, Math.min(12, Math.round(wc / 2.3) + 1));
    console.log(`[panel ${panel.index + 1}] text (${wc}w) → ${dur}s`);
    return dur;
  }
  return 4;
}

// ════════════════════════════════════════════════════════════════
// Segment validator
// ════════════════════════════════════════════════════════════════

function validateSegment(segPath) {
  return new Promise(resolve => {
    if (!fs.existsSync(segPath)) return resolve({ valid: false, reason: "missing" });
    ffmpeg.ffprobe(segPath, (err, data) => {
      if (err) return resolve({ valid: false, reason: err.message });
      const hasV = data.streams?.some(s => s.codec_type === "video");
      const hasA = data.streams?.some(s => s.codec_type === "audio");
      if (!hasV) return resolve({ valid: false, reason: "no video stream" });
      if (!hasA) return resolve({ valid: false, reason: "no audio stream" });
      resolve({ valid: true });
    });
  });
}

// ════════════════════════════════════════════════════════════════
// Ken-Burns / motion filter builder
// ════════════════════════════════════════════════════════════════
//
// FIT MODE     — full image visible, black letterbox, no zoompan
// CINEMATIC    — 2% zoom + gentle pan; internal fps = RC.ZOOMPAN_FPS
//
// All zoompan uses RC.ZOOM_AMOUNT (1.02) and tiny pixel offsets to avoid
// aggressive crop while still providing subtle motion.
// ════════════════════════════════════════════════════════════════

function buildScaleFilter() {
  // High-quality Lanczos scaling into a black-padded 1280×720 frame
  return `scale=${RC.W}:${RC.H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
         `pad=${RC.W}:${RC.H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

function getKenBurnsFilter(idx, duration, panelCount, aspectMode) {
  const fps    = RC.ZOOMPAN_FPS;
  const frames = Math.max(1, Math.ceil(duration * fps));
  const z      = RC.ZOOM_AMOUNT;
  const px     = RC.PAN_PIXELS;
  const py     = RC.PAN_PIXELS_Y;
  const WH     = `${RC.W}x${RC.H}`;
  const scale  = buildScaleFilter();

  const mode = String(aspectMode || "fit").toLowerCase().trim();

  if (mode !== "cinematic") {
    // FIT: no zoompan at all — just scale+pad+setsar, no motion
    return scale;
  }

  // CINEMATIC: subtle motion — pick one of 5 patterns round-robin
  // We scale first (lightweight), then apply zoompan on the already-scaled stream.
  // zoompan operates on the padded 1280×720 frame so it never crops outside the image.
  const cx = `iw/2-(iw/zoom/2)`;
  const cy = `ih/2-(ih/zoom/2)`;

  const patterns = [
    // 0: gentle zoom-in from centre
    `zoompan=z='min(zoom+0.0004,${z})':x='${cx}':y='${cy}':d=${frames}:s=${WH}:fps=${fps}`,
    // 1: gentle zoom-out from centre
    `zoompan=z='if(lte(on,1),${z},max(zoom-0.0004,1.0))':x='${cx}':y='${cy}':d=${frames}:s=${WH}:fps=${fps}`,
    // 2: subtle left-to-right pan
    `zoompan=z='${z}':x='min(${cx}+(on*${px}/${frames}),iw-iw/zoom)':y='${cy}':d=${frames}:s=${WH}:fps=${fps}`,
    // 3: subtle right-to-left pan
    `zoompan=z='${z}':x='max(${cx}-(on*${px}/${frames}),0)':y='${cy}':d=${frames}:s=${WH}:fps=${fps}`,
    // 4: subtle up pan
    `zoompan=z='${z}':x='${cx}':y='max(${cy}-(on*${py}/${frames}),0)':d=${frames}:s=${WH}:fps=${fps}`,
  ];

  const chosenPan = patterns[idx % patterns.length];
  return `${scale},${chosenPan}`;
}

// ════════════════════════════════════════════════════════════════
// Audio filter chain
// ════════════════════════════════════════════════════════════════

function buildAudioFilterChain(options = {}) {
  const filters = [];
  if (options.audioNormalize || options.loudnorm) {
    // EBU R128 loudness normalisation — consistent voice level, no clipping
    filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  }
  if (options.smoothAudio) {
    // Light dynamic compression — prevents sudden jumps
    filters.push("acompressor=threshold=0.05:ratio=4:attack=5:release=50");
  }
  return filters.join(",");
}

// ════════════════════════════════════════════════════════════════
// Watermark overlay filter
// ════════════════════════════════════════════════════════════════

function buildWatermarkFilter(opts = {}) {
  const margin  = parseInt(opts.wmMargin  ?? RC.WM_MARGIN);
  const opacity = parseFloat(opts.wmOpacity ?? RC.WM_OPACITY);
  const scale   = parseFloat(opts.wmScale  ?? RC.WM_SCALE);
  const pos     = String(opts.wmPosition || RC.WM_POSITION).toLowerCase();

  const scaledW = Math.round(RC.W * scale);

  const positions = {
    "bottom-right": `x=main_w-overlay_w-${margin}:y=main_h-overlay_h-${margin}`,
    "bottom-left":  `x=${margin}:y=main_h-overlay_h-${margin}`,
    "top-right":    `x=main_w-overlay_w-${margin}:y=${margin}`,
    "top-left":     `x=${margin}:y=${margin}`,
    "center":       `x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2`,
  };
  const posStr = positions[pos] || positions["bottom-right"];

  // Scale watermark, set alpha, then overlay
  return {
    wmScale: `scale=${scaledW}:-1`,
    overlay: `format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}`,
    position: posStr,
  };
}

// ════════════════════════════════════════════════════════════════
// Extract render options from request body
// ════════════════════════════════════════════════════════════════

function extractRenderOptions(body = {}) {
  const payload = parseMaybeJson(body.payload, {});
  const overlayMeta = parseMaybeJson(body.overlayMeta || body.overlay, payload.overlay || {});
  const merged = { ...payload, ...body };
  const sizePct = overlayMeta.sizePct ?? overlayMeta.size_pct;
  const opacity = overlayMeta.opacity;
  const marginPx = overlayMeta.marginPx ?? overlayMeta.margin_px;
  const position = overlayMeta.position;

  return {
    // Encoding
    crf:           Math.max(18, Math.min(32, parseInt(merged.crf)  || RC.CRF)),
    preset:        merged.preset        || RC.PRESET,
    audioBitrate:  merged.audioBitrate  || RC.AUDIO_BITRATE,
    pixFmt:        merged.pixFmt        || RC.PIX_FMT,
    videoCodec:    merged.videoCodec    || "libx264",
    movflags:      merged.movflags      || RC.MOVFLAGS,
    maxrate:       merged.maxrate       || "",
    bufsize:       merged.bufsize       || "",
    // Aspect
    aspectMode:    merged.aspectMode || merged.aspect_mode || "fit",
    // Audio processing
    audioNormalize: merged.audioNormalize === true || merged.audioNormalize === "true" || merged.audio_normalize === true || merged.audio_normalize === "true",
    loudnorm:       merged.loudnorm       === true || merged.loudnorm       === "true",
    smoothAudio:    merged.smoothAudio    === true || merged.smoothAudio    === "true",
    // Watermark
    watermarkFile: null,  // filled by route handlers when a file is uploaded
    wmPosition:    position || merged.wmPosition || merged.watermark_position || RC.WM_POSITION,
    wmOpacity:     Math.max(0, Math.min(1, parseFloat(opacity ?? merged.wmOpacity ?? merged.watermark_opacity ?? RC.WM_OPACITY))),
    wmScale:       Math.max(0.03, Math.min(0.5, parseFloat(merged.wmScale ?? merged.watermark_scale ?? (Number(sizePct || 0) ? Number(sizePct) / 100 : RC.WM_SCALE)))),
    wmMargin:      Math.max(0, parseInt(marginPx ?? merged.wmMargin ?? merged.watermark_margin ?? RC.WM_MARGIN)),
  };
}

// ════════════════════════════════════════════════════════════════
// Create single segment MP4
// ════════════════════════════════════════════════════════════════

function createSegment({ imagePath, audioPath, text, duration, outPath,
                         jobId, idx, panelCount, aspectMode, renderOptions = {} }) {
  return new Promise((resolve, reject) => {
    const FONT   = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const fps    = getFps(panelCount);
    const kenVf  = getKenBurnsFilter(idx, duration, panelCount, aspectMode);

    const vfParts = [kenVf];
    // Subtitle overlay (optional text)
    if (text && text.trim() && fs.existsSync(FONT)) {
      const safe = wrapText(text);
      if (safe) {
        vfParts.push(
          `drawtext=fontfile='${FONT}':text='${safe.replace(/'/g, "\\'")}':` +
          `fontsize=22:fontcolor=white:borderw=2:bordercolor=black:` +
          `x=(w-text_w)/2:y=h-th-30`
        );
      }
    }

    const hasAudio = audioPath && fs.existsSync(audioPath);
    const memMB   = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[seg${idx}] START mode=${aspectMode} dur=${duration}s fps=${fps} mem=${memMB}MB`);

    const cmd = ffmpeg()
      .setFfmpegPath(FFMPEG_PATH)
      .input(imagePath)
      // Use RC.ZOOMPAN_FPS as input framerate only in cinematic mode (avoids unnecessary frames in fit mode)
      .inputOptions(["-loop 1", `-framerate ${String(aspectMode).toLowerCase() === "cinematic" ? RC.ZOOMPAN_FPS : fps}`]);

    if (hasAudio) {
      cmd.input(audioPath);
    } else {
      cmd
        .input(`aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${duration}`)
        .inputOptions(["-f lavfi"]);
    }

    const audioFilter = buildAudioFilterChain(renderOptions);

    const outputOpts = [
      `-vf ${vfParts.join(",")}`,
      `-c:v ${renderOptions.videoCodec || "libx264"}`,
      `-pix_fmt ${renderOptions.pixFmt || RC.PIX_FMT}`,
      `-r ${fps}`,
      `-crf ${renderOptions.crf || RC.CRF}`,
      `-preset ${renderOptions.preset || RC.PRESET}`,
      `-threads ${RC.THREADS}`,
      `-movflags ${renderOptions.movflags || RC.MOVFLAGS}`,
      `-c:a aac`,
      `-b:a ${renderOptions.audioBitrate || RC.AUDIO_BITRATE}`,
      "-shortest",
      `-t ${duration}`,
    ];

    if (renderOptions.maxrate) outputOpts.splice(-3, 0, `-maxrate ${renderOptions.maxrate}`);
    if (renderOptions.bufsize) outputOpts.splice(-3, 0, `-bufsize ${renderOptions.bufsize}`);
    if (audioFilter) outputOpts.splice(0, 0, `-af ${audioFilter}`);

    cmd
      .outputOptions(outputOpts)
      .output(outPath)
      .on("start", () => console.log(`[seg${idx}] encoding…`))
      .on("progress", () => {})
      .on("end", () => {
        const m = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[seg${idx}] ✓ done mem=${m}MB`);
        resolve();
      })
      .on("error", (err) => {
        const m   = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const oom = err.message.includes("Cannot allocate memory") ||
                    err.message.includes("Out of memory") ||
                    err.message.includes("ENOMEM") ||
                    err.message.includes("killed");
        console.error(`[seg${idx}] ❌ ${oom ? "OOM" : "ERROR"} mem=${m}MB — ${err.message.split("\n")[0]}`);
        reject(err);
      })
      .run();
  });
}

// ════════════════════════════════════════════════════════════════
// createSegment with retry + graceful skip
// ════════════════════════════════════════════════════════════════

async function createSegmentSafe(params) {
  let lastErr;
  for (let attempt = 1; attempt <= RC.MAX_RETRIES; attempt++) {
    try {
      await createSegment(params);
      // quick sanity-check
      const v = await validateSegment(params.outPath);
      if (!v.valid) throw new Error(`Segment invalid after encode: ${v.reason}`);
      return { success: true };
    } catch (err) {
      lastErr = err;
      const oom = err.message.includes("Cannot allocate memory") ||
                  err.message.includes("Out of memory") ||
                  err.message.includes("ENOMEM") ||
                  err.message.includes("killed");
      console.warn(`[seg${params.idx}] attempt ${attempt}/${RC.MAX_RETRIES} failed${oom ? " (OOM)" : ""}: ${err.message.split("\n")[0]}`);
      // Clean broken output before retry
      try { fs.unlinkSync(params.outPath); } catch (_) {}
      if (oom) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  console.error(`[seg${params.idx}] ❌ ALL RETRIES FAILED — skipping. Last: ${lastErr.message.split("\n")[0]}`);
  return { success: false, error: lastErr.message };
}

// ════════════════════════════════════════════════════════════════
// Spawn FFmpeg directly (for complex filter_complex operations)
// ════════════════════════════════════════════════════════════════

function spawnFfmpeg(args, desc = "") {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] ${desc || "run"}: ffmpeg ${args.slice(0, 6).join(" ")} …`);
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", d => { stderr += d; });
    proc.on("close", code => {
      if (code === 0) return resolve({ success: true, stderr });
      const oom = stderr.includes("Cannot allocate memory") || stderr.includes("ENOMEM") || code === 137;
      const m   = Math.round(process.memoryUsage().rss / 1024 / 1024);
      reject(new Error(`FFmpeg ${oom ? "OOM" : `failed (${code})`}: ${desc} mem=${m}MB\n${stderr.slice(-800)}`));
    });
    proc.on("error", reject);
  });
}

// ════════════════════════════════════════════════════════════════
// Apply watermark to finished video
// ════════════════════════════════════════════════════════════════

async function applyWatermark(inputPath, watermarkPath, outputPath, renderOptions = {}) {
  const videoPath = normalizeFfmpegPath(inputPath);
  const wmPath = normalizeFfmpegPath(watermarkPath);
  console.log("VIDEO:", videoPath);
  console.log("WATERMARK:", wmPath);

  if (!wmPath || !fs.existsSync(wmPath)) {
    throw new Error("Watermark image missing");
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error("Video input missing");
  }

  console.log(`[watermark] applying ${path.basename(wmPath)} → ${path.basename(outputPath)}`);
  const wm  = buildWatermarkFilter(renderOptions);
  const crf = renderOptions.crf || RC.CRF;

  await spawnFfmpeg([
    "-i", videoPath,
    "-i", wmPath,
    "-filter_complex",
    `[1:v]${wm.wmScale},${wm.overlay}[wm];[0:v][wm]overlay=${wm.position}:format=auto[vout]`,
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-pix_fmt", RC.PIX_FMT,
    "-crf",  String(crf),
    "-preset", RC.PRESET,
    "-threads", String(RC.THREADS),
    "-c:a", "copy",
    "-movflags", RC.MOVFLAGS,
    "-y",
    outputPath,
  ], "watermark overlay");
}

// ════════════════════════════════════════════════════════════════
// Concat — xfade (≤12 clips), simple concat (>12), batch+recurse (>BATCH_SIZE)
// ════════════════════════════════════════════════════════════════

async function concatWithTransitions(segPaths, durations, outPath, renderOptions = {}) {
  const n = segPaths.length;
  const m = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`\n[concat] ${n} segments mem=${m}MB`);
  if (!n) throw new Error("No segments to concat");
  if (n === 1) { fs.copyFileSync(segPaths[0], outPath); return; }

  for (let i = 0; i < n; i++) {
    if (!fs.existsSync(segPaths[i])) throw new Error(`Segment ${i} missing: ${segPaths[i]}`);
  }

  if (n > RC.BATCH_SIZE) {
    await batchMerge(segPaths, durations, outPath, renderOptions);
  } else if (n <= RC.XFADE_MAX) {
    await concatWithXfade(segPaths, durations, outPath, renderOptions);
  } else {
    await concatSimple(segPaths, outPath, renderOptions);
  }

  console.log(`[concat] ✓ done → ${path.basename(outPath)}`);
}

// ─── Batch merge: split → merge each → recurse ───────────────────────────────

async function batchMerge(segPaths, durations, outPath, renderOptions = {}) {
  const n      = segPaths.length;
  const bCount = Math.ceil(n / RC.BATCH_SIZE);
  console.log(`[batchMerge] ${n} clips → ${bCount} batches`);

  const batchOuts = [];
  const batchDurs = [];
  const tempFiles = [];

  for (let b = 0; b < bCount; b++) {
    const sl  = b * RC.BATCH_SIZE;
    const el  = Math.min(sl + RC.BATCH_SIZE, n);
    const bS  = segPaths.slice(sl, el);
    const bD  = durations.slice(sl, el);
    const bO  = path.join(TEMP_ROOT, `batch_${Date.now()}_${b}.mp4`);

    console.log(`[batchMerge] batch ${b + 1}/${bCount}: clips ${sl + 1}–${el}`);
    if (bS.length <= RC.XFADE_MAX) {
      await concatWithXfade(bS, bD, bO, renderOptions);
    } else {
      await concatSimple(bS, bO, renderOptions);
    }

    batchOuts.push(bO);
    tempFiles.push(bO);
    batchDurs.push(bD.reduce((a, v) => a + v, 0));
    console.log(`[batchMerge] batch ${b + 1} done mem=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
  }

  try {
    await concatWithTransitions(batchOuts, batchDurs, outPath, renderOptions);
  } finally {
    cleanupFiles(tempFiles);
  }
}

// ─── xfade concat (smooth crossfade, ≤ XFADE_MAX clips) ─────────────────────

async function concatWithXfade(segPaths, durations, outPath, renderOptions = {}) {
  const T    = RC.XFADE_DUR;
  const crf  = renderOptions.crf || RC.CRF;

  let fc     = "";
  let vLabel = "0:v";
  let aLabel = "0:a";
  let offset = durations[0];

  for (let i = 1; i < segPaths.length; i++) {
    const vl = `v${i}`;
    const al = `a${i}`;
    fc +=
      (fc ? ";" : "") +
      `[${vLabel}][${i}:v]xfade=transition=fade:duration=${T}:offset=${(offset - T).toFixed(4)}[${vl}]` +
      `;[${aLabel}][${i}:a]acrossfade=d=${T}:c1=tri:c2=tri[${al}]`;
    vLabel = vl;
    aLabel = al;
    offset += durations[i] - T;
  }
  fc += `;[${vLabel}]format=yuv420p[vout];[${aLabel}]aformat=sample_rates=44100:channel_layouts=stereo[aout]`;

  const inputArgs = segPaths.flatMap(s => ["-i", s]);
  const outputArgs = [
    "-filter_complex", fc,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-pix_fmt", RC.PIX_FMT,
    "-crf", String(crf), "-preset", RC.PRESET,
    "-threads", String(RC.THREADS),
    "-movflags", RC.MOVFLAGS,
    "-c:a", "aac", "-b:a", renderOptions.audioBitrate || RC.AUDIO_BITRATE,
    "-y", outPath,
  ];

  try {
    await spawnFfmpeg([...inputArgs, ...outputArgs], "xfade concat");
  } catch (err) {
    console.warn(`[concat] xfade failed (${err.message.split("\n")[0]}) — fallback to simple`);
    await concatSimple(segPaths, outPath, renderOptions);
  }
}

// ─── Simple concat demuxer (>XFADE_MAX clips or fallback) ────────────────────

async function concatSimple(segPaths, outPath, renderOptions = {}) {
  console.log(`[concat] simple concat ${segPaths.length} clips`);
  const concatFile = path.join(TEMP_ROOT, `concat_${Date.now()}.txt`);
  fs.writeFileSync(concatFile, segPaths.map(s => `file '${s}'`).join("\n"), "utf8");

  const crf = renderOptions.crf || RC.CRF;

  const args = [
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-c:v", "libx264", "-pix_fmt", RC.PIX_FMT,
    "-crf", String(crf), "-preset", RC.PRESET,
    "-threads", String(RC.THREADS),
    "-movflags", RC.MOVFLAGS,
    "-c:a", "aac", "-b:a", renderOptions.audioBitrate || RC.AUDIO_BITRATE,
    "-y", outPath,
  ];

  try {
    await spawnFfmpeg(args, "simple concat");
  } finally {
    try { fs.unlinkSync(concatFile); } catch (_) {}
  }
}

// ════════════════════════════════════════════════════════════════
// Pre-render validation
// ════════════════════════════════════════════════════════════════

async function validateRenderPanels(panels) {
  const errors = [];
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const n = i + 1;
    if (!p.image || !fs.existsSync(path.join(p.dir, p.image))) {
      errors.push(`Panel ${n} image missing`); continue;
    }
    if (p.audio) {
      const ap = path.join(p.dir, p.audio);
      if (!fs.existsSync(ap)) { errors.push(`Panel ${n} audio missing`); continue; }
      const r = await getAudioDuration(ap);
      if (!r.valid) { errors.push(`Panel ${n} audio corrupted: ${r.reason}`); continue; }
    }
    console.log(`[validate] ✓ panel ${n}`);
  }
  if (errors.length) throw new Error(`Validation failed:\n${errors.join("\n")}`);
  console.log(`[validate] ✓ all ${panels.length} panels OK`);
}

// ════════════════════════════════════════════════════════════════
// Core render loop (shared by project + multipart paths)
// ════════════════════════════════════════════════════════════════

async function runRenderLoop({ jobId, panels, getImage, getAudio, getText, getDuration,
                               renderOptions, batchIndex, totalBatches, projectId, uploadPaths = [] }) {
  const panelCount = panels.length;
  const segPaths   = [];
  const durations  = [];
  updateJob(jobId, { status: "processing", progress: 0, batchIndex, totalBatches });

  try {
    let skipped = 0;
    for (let i = 0; i < panels.length; i++) {
      const p       = panels[i];
      p.index       = i;
      const dur     = await getDuration(p);
      const segPath = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);

      const result = await createSegmentSafe({
        imagePath: getImage(p),
        audioPath: getAudio(p),
        text:      getText(p),
        duration:  dur,
        outPath:   segPath,
        jobId, idx: i, panelCount,
        aspectMode: renderOptions.aspectMode,
        renderOptions,
      });

      if (result.success) { segPaths.push(segPath); durations.push(dur); }
      else                { skipped++; console.warn(`[${jobId}] panel ${i + 1} skipped`); }

      updateJob(jobId, { progress: Math.round(((i + 1) / panels.length) * 75), skipped });
    }

    if (!segPaths.length) throw new Error("All panels failed — no segments produced.");
    if (skipped)          console.warn(`[${jobId}] ⚠ ${skipped} panels skipped`);

    updateJob(jobId, { progress: 80 });

    // ── concat ──────────────────────────────────────────────────
    const mergedPath = path.join(TEMP_ROOT, `${jobId}_merged.mp4`);
    await concatWithTransitions(segPaths, durations, mergedPath, renderOptions);
    cleanupFiles(segPaths);

    updateJob(jobId, { progress: 90 });

    // ── watermark (if any) ──────────────────────────────────────
    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    if (renderOptions.watermarkFile && fs.existsSync(renderOptions.watermarkFile)) {
      await applyWatermark(mergedPath, renderOptions.watermarkFile, finalPath, renderOptions);
      try { fs.unlinkSync(mergedPath); } catch (_) {}
    } else {
      fs.renameSync(mergedPath, finalPath);
    }

    // cleanup uploads
    cleanupFiles(uploadPaths);
    if (renderOptions.watermarkFile) {
      try { fs.unlinkSync(renderOptions.watermarkFile); } catch (_) {}
    }

    updateJob(jobId, { progress: 95 });

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || "localhost"}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    // Auto-delete final file after TTL
    setTimeout(() => { try { fs.unlinkSync(finalPath); } catch (_) {} }, RC.FILE_TTL_MS);

    updateJob(jobId, {
      status: "done", progress: 100, url,
      videoUrl: url, video_url: url, download_url: url,
      project_id: projectId,
      panels: panels.length, rendered: segPaths.length, skipped,
      batchIndex, totalBatches,
      renderer: RENDERER_NAME,
      format: "MP4 (H264 + AAC)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)",
      fps: getFps(panelCount),
      aspectMode: renderOptions.aspectMode,
      watermark: !!renderOptions.watermarkFile,
      encodingSettings: {
        crf:            renderOptions.crf,
        preset:         renderOptions.preset,
        threads:        RC.THREADS,
        audioBitrate:   renderOptions.audioBitrate,
        audioNormalize: renderOptions.audioNormalize,
        audioSmoothing: renderOptions.smoothAudio,
      },
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] ✓ render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] ❌ render error:`, err.message);
    cleanupFiles(segPaths);
    cleanupFiles(uploadPaths);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ════════════════════════════════════════════════════════════════
// renderFromProject  — panel-upload workflow
// ════════════════════════════════════════════════════════════════

async function renderFromProject(req, jobId) {
  const body = { ...parseMaybeJson(req.body?.payload, {}), ...(req.body || {}) };
  const projectId  = safeName(body.project_id || body.projectId, "");
  if (!projectId) return updateJob(jobId, { status: "error", error: "Missing project_id" });

  const projectDir = path.join(UPLOADS_ROOT, projectId);
  if (!fs.existsSync(projectDir)) {
    return updateJob(jobId, { status: "error", error: `No panels found for project_id ${projectId}` });
  }

  const renderOptions  = extractRenderOptions(body);
  const batchIndex     = Number(body.batchIndex   || body.batch_index   || 0);
  const totalBatches   = Number(body.totalBatches || body.total_batches || 1);

  const wmFile = req.files?.watermark?.[0];
  if (wmFile) {
    if (!isValidWatermarkFile(wmFile)) {
      cleanupFiles([wmFile.path]);
      return updateJob(jobId, { status: "error", error: "Invalid watermark file. Use PNG, JPEG, or WebP." });
    }
    renderOptions.watermarkFile = normalizeFfmpegPath(wmFile.path);
  }

  let orderedRefs = [];
  try {
    if (Array.isArray(body.panels))         orderedRefs = body.panels;
    else if (typeof body.panels === "string") orderedRefs = JSON.parse(body.panels);
  } catch (_) { orderedRefs = []; }

  const readPanel = (panelId, fi) => {
    const dir      = path.join(projectDir, safeName(panelId, `panel_${fi + 1}`));
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { ...meta, dir, index: fi };
  };

  let panels = [];
  if (orderedRefs.length) {
    panels = orderedRefs.map((p, i) => readPanel(p.ref || p.panel_id || p.id || p.panel, i)).filter(Boolean);
  } else {
    const folders = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    panels = folders.map((n, i) => readPanel(n, i)).filter(Boolean);
    panels.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  if (!panels.length) return updateJob(jobId, { status: "error", error: "No complete panels found" });

  await validateRenderPanels(panels);

  await runRenderLoop({
    jobId, panels, projectId, renderOptions, batchIndex, totalBatches,
    getImage:    p => path.join(p.dir, p.image),
    getAudio:    p => p.audio ? path.join(p.dir, p.audio) : null,
    getText:     p => p.narration || "",
    getDuration: p => calculatePanelDuration(p),
  });
}

// ════════════════════════════════════════════════════════════════
// renderFromMultipart — direct upload workflow
// ════════════════════════════════════════════════════════════════

async function renderFromMultipart(req, jobId) {
  const imageFiles = req.files?.images || [];
  if (!imageFiles.length) return updateJob(jobId, { status: "error", error: "No images uploaded" });

  const renderOptions = extractRenderOptions(req.body);
  const batchIndex    = Number(req.body.batchIndex   || 0);
  const totalBatches  = Number(req.body.totalBatches || 1);
  const uploadPaths   = imageFiles.map(f => f.path);

  // Watermark file (uploaded in this request). Use req.files.watermark[0], never req.file.
  const wmFile = req.files?.watermark?.[0];
  if (wmFile) {
    if (!isValidWatermarkFile(wmFile)) {
      cleanupFiles([wmFile.path, ...uploadPaths]);
      return updateJob(jobId, { status: "error", error: "Invalid watermark file. Use PNG, JPEG, or WebP." });
    }
    renderOptions.watermarkFile = normalizeFfmpegPath(wmFile.path);
  }

  const lines = String(req.body.narration || "").split("\n").map(l => l.trim());
  while (lines.length < imageFiles.length) lines.push("");

  const panels = imageFiles.map((f, i) => ({ _file: f, _line: lines[i], _idx: i }));

  await runRenderLoop({
    jobId, panels, projectId: null, renderOptions, batchIndex, totalBatches,
    getImage:    p => p._file.path,
    getAudio:    _  => null,
    getText:     p => p._line,
    getDuration: p => {
      const wc  = String(p._line || "").split(/\s+/).filter(Boolean).length;
      return Promise.resolve(Math.max(3, Math.min(12, Math.round(wc / 2.3) + 1)));
    },
    uploadPaths,
  });
}

// ════════════════════════════════════════════════════════════════
// Multer storages
// ════════════════════════════════════════════════════════════════

function makeDiskStorage(dest) {
  return multer.diskStorage({
    destination: (_req, file, cb) => {
      const field = String(file.fieldname || "");
      let finalDest = dest;
      if (field === "video") finalDest = VIDEOS_ROOT;
      else if (field === "watermark") finalDest = WATERMARKS_ROOT;
      else if (field === "images" || field === "image") finalDest = IMAGES_ROOT;
      fs.mkdirSync(finalDest, { recursive: true });
      cb(null, finalDest);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || extFor(file, ".bin");
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  });
}

function uploadFileFilter(_req, file, cb) {
  if (file.fieldname === "watermark" && !isValidWatermarkFile(file)) {
    return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "watermark"));
  }
  if (file.fieldname === "video" && !isValidVideoFile(file)) {
    return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "video"));
  }
  cb(null, true);
}

const panelUpload = multer({ storage: makeDiskStorage(UPLOADS_ROOT), fileFilter: uploadFileFilter, limits: { fileSize: 500 * 1024 * 1024, files: 4 } });
const diskUpload  = multer({ storage: makeDiskStorage(UPLOADS_ROOT), fileFilter: uploadFileFilter, limits: { fileSize: 300 * 1024 * 1024, files: 3000 } });
const zipUpload   = multer({ storage: makeDiskStorage(TEMP_ROOT),    limits: { fileSize: 500 * 1024 * 1024, files: 1 } });

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

// ── Health ───────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok", renderer: RENDERER_NAME,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString(),
    config: { preset: RC.PRESET, crf: RC.CRF, threads: RC.THREADS, zoompanFps: RC.ZOOMPAN_FPS },
  });
});

// ── Job status ───────────────────────────────────────────────────

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: "Job not found" });
  res.json({ success: true, ...job });
});

// ── Panel upload ─────────────────────────────────────────────────

app.post(
  "/panel",
  panelUpload.fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]),
  (req, res) => {
    try {
      const projectId = safeName(req.body.project_id || req.body.projectId, "project");
      const panelId   = safeName(req.body.panel_id   || req.body.panelId   || `panel_${Date.now()}`, "panel");
      const duration  = Number(req.body.duration || 4);
      const narration = String(req.body.narration || "").trim();

      if (!req.files?.image?.[0]) return res.status(400).json({ success: false, error: "Image required" });

      const panelDir = path.join(UPLOADS_ROOT, projectId, panelId);
      fs.mkdirSync(panelDir, { recursive: true });

      const imgSrc  = req.files.image[0].path;
      const imgDest = path.join(panelDir, "image.jpg");
      fs.copyFileSync(imgSrc, imgDest);
      fs.unlinkSync(imgSrc);

      let audioFileName = null;
      if (req.files?.audio?.[0]) {
        const ext          = extFor(req.files.audio[0], ".mp3");
        audioFileName      = `audio${ext}`;
        const audioSrc     = req.files.audio[0].path;
        const audioDest    = path.join(panelDir, audioFileName);
        fs.copyFileSync(audioSrc, audioDest);
        fs.unlinkSync(audioSrc);
      }

      const index = Number(req.body.index || 0);
      fs.writeFileSync(path.join(panelDir, "metadata.json"), JSON.stringify(
        { index, duration, narration, image: "image.jpg", audio: audioFileName, uploaded_at: new Date().toISOString() }, null, 2
      ));

      console.log(`[panel] saved ${projectId}/${panelId}`);
      res.json({ success: true, panel: panelId, panel_id: panelId, ref: panelId, project_id: projectId });

    } catch (err) {
      console.error("/panel error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── Audio ZIP upload ─────────────────────────────────────────────

app.post("/audio-zip", zipUpload.single("audioZip"), async (req, res) => {
  try {
    const projectId = safeName(req.body.project_id || req.body.projectId, "");
    if (!projectId) return res.status(400).json({ success: false, error: "Missing project_id" });
    if (!req.file)  return res.status(400).json({ success: false, error: "audioZip required" });

    const projectDir = path.join(UPLOADS_ROOT, projectId);
    if (!fs.existsSync(projectDir)) return res.status(404).json({ success: false, error: "Project not found" });

    const zip      = new AdmZip(req.file.path);
    fs.unlinkSync(req.file.path);

    const mp3Entries = zip.getEntries()
      .filter(e => !e.isDirectory)
      .filter(e => {
        const n = e.entryName.replace(/\\/g, "/");
        return !n.includes("__MACOSX") && !path.basename(n).startsWith(".") && /\.mp3$/i.test(n);
      })
      .map(e => { const m = path.basename(e.entryName).match(/(\d+)/); return m ? { entry: e, num: Number(m[1]), file: path.basename(e.entryName) } : null; })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);

    if (!mp3Entries.length) return res.status(400).json({ success: false, error: "No numbered MP3s found (use 1.mp3, 2.mp3 …)" });

    const panelFolders = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const dir      = path.join(projectDir, d.name);
        const metaPath = path.join(dir, "metadata.json");
        if (!fs.existsSync(metaPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return { name: d.name, dir, metaPath, meta };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.meta.index || 0) - Number(b.meta.index || 0));

    const attached = [];
    const missing  = [];

    for (let i = 0; i < panelFolders.length; i++) {
      const num   = i + 1;
      const audio = mp3Entries.find(x => x.num === num);
      if (!audio) { missing.push(num); continue; }

      const panel     = panelFolders[i];
      const audioPath = path.join(panel.dir, "audio.mp3");
      fs.writeFileSync(audioPath, audio.entry.getData());
      panel.meta.audio        = "audio.mp3";
      panel.meta.audio_source = "zip";
      panel.meta.audio_original = audio.file;
      fs.writeFileSync(panel.metaPath, JSON.stringify(panel.meta, null, 2));
      attached.push({ panel: num, audio: audio.file, status: "attached" });
    }

    res.json({
      success: true, project_id: projectId,
      totalPanels: panelFolders.length, totalMp3Found: mp3Entries.length,
      attached, missing,
      message: missing.length
        ? `Attached ${attached.length} files. Missing: panels ${missing.join(", ")}`
        : `All ${attached.length} MP3 files attached.`,
    });

  } catch (err) {
    console.error("/audio-zip error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Main render route ────────────────────────────────────────────
//
// Accepts:
//   POST /render  JSON { project_id }                              → project-panel workflow, no watermark file
//   POST /render  multipart project_id + watermark                 → project-panel workflow with watermark file
//   POST /render  multipart video + watermark                      → direct video watermark workflow
//   POST /render  multipart images[] + optional watermark          → direct image workflow
//
// IMPORTANT: multipart fields MUST be parsed by multer before reading req.body.
// Watermark file field name is exactly `watermark`; direct video field is exactly `video`.

app.post("/render", (req, res) => {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();

  const startProjectJob = () => {
    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });
    setImmediate(() =>
      renderFromProject(req, jobId).catch(err => {
        console.error(`[${jobId}] unhandled:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      })
    );
  };

  if (!contentType.includes("multipart/form-data")) {
    return startProjectJob();
  }

  diskUpload.fields([
    { name: "video",     maxCount: 1 },
    { name: "watermark", maxCount: 1 },
    { name: "images",    maxCount: 2000 },
  ])(req, res, multerErr => {
    if (multerErr) {
      console.error("[upload] multer error:", multerErr);
      return res.status(400).json({ success: false, error: multerErr.field ? `Invalid upload field or file type: ${multerErr.field}` : multerErr.message });
    }

    logUploadedFiles(req);

    const body = { ...parseMaybeJson(req.body?.payload, {}), ...(req.body || {}) };
    const hasProject = body.project_id || body.projectId;
    const videoFile = req.files?.video?.[0];
    const watermarkFile = req.files?.watermark?.[0];

    if (watermarkFile && !fs.existsSync(watermarkFile.path)) {
      return res.status(400).json({ success: false, error: "Watermark image missing" });
    }
    if (videoFile && !fs.existsSync(videoFile.path)) {
      return res.status(400).json({ success: false, error: "Video file missing" });
    }

    if (hasProject) return startProjectJob();

    if (videoFile) {
      if (!watermarkFile) return res.status(400).json({ success: false, error: "Watermark image missing" });
      const jobId = createJob();
      res.json({ success: true, jobId, status: "queued" });
      setImmediate(async () => {
        const renderOptions = extractRenderOptions(body);
        const videoPath = normalizeFfmpegPath(videoFile.path);
        const watermarkPath = normalizeFfmpegPath(watermarkFile.path);
        const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
        try {
          renderOptions.watermarkFile = watermarkPath;
          console.log("VIDEO:", videoPath);
          console.log("WATERMARK:", watermarkPath);
          await applyWatermark(videoPath, watermarkPath, finalPath, renderOptions);
          cleanupFiles([videoPath, watermarkPath]);
          const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || "localhost"}`;
          const url = `${host}/output/${jobId}_final.mp4`;
          setTimeout(() => { try { fs.unlinkSync(finalPath); } catch (_) {} }, RC.FILE_TTL_MS);
          updateJob(jobId, { status: "done", progress: 100, url, videoUrl: url, video_url: url, watermark: true });
          scheduleJobEviction(jobId);
        } catch (err) {
          cleanupFiles([videoPath, watermarkPath, finalPath]);
          console.error(`[${jobId}] ❌ video watermark error:`, err.message);
          updateJob(jobId, { status: "error", error: err.message });
          scheduleJobEviction(jobId);
        }
      });
      return;
    }

    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });
    setImmediate(() =>
      renderFromMultipart(req, jobId).catch(err => {
        console.error(`[${jobId}] unhandled:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      })
    );
  });
});

// ── 404 ──────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found", path: req.originalUrl });
});

// ════════════════════════════════════════════════════════════════
// Auto cleanup (every 30 min) — delete files older than FILE_TTL
// ════════════════════════════════════════════════════════════════

setInterval(() => {
  const now = Date.now();
  [OUTPUT_ROOT, TEMP_ROOT].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(file => {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > RC.FILE_TTL_MS) {
            fs.unlinkSync(full);
            console.log(`[cleanup] deleted ${file}`);
          }
        } catch (_) {}
      });
    } catch (_) {}
  });
}, RC.CLEANUP_INT);

// ════════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════════

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 ScriptReel / ${RENDERER_NAME} — port ${PORT}`);
  console.log(`   FFmpeg  : ${FFMPEG_PATH}`);
  console.log(`   Preset  : ${RC.PRESET}  CRF: ${RC.CRF}  Threads: ${RC.THREADS}`);
  console.log(`   ZoompanFPS: ${RC.ZOOMPAN_FPS}  ZoomAmt: ${RC.ZOOM_AMOUNT}`);
  console.log(`   Watermark defaults: ${RC.WM_POSITION} opacity=${RC.WM_OPACITY} scale=${RC.WM_SCALE}\n`);
});

server.timeout = 0; // no request timeout — renders can take minutes
