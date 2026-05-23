const express = require("express");
const multer = require("multer");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const AdmZip = require("adm-zip");
const FormData = require("form-data");
// node-fetch v2 for CommonJS compatibility on Railway
const fetch = require("node-fetch");  // node-fetch@2 — CommonJS, supports res.buffer()

const app = express();
const PORT = process.env.PORT || 8080;
const RENDERER_NAME = process.env.RENDERER_NAME || "renderer";

// ================================
// Distributed Renderer Config
// ================================
const RENDERER_URLS = (process.env.RENDERER_URLS || "")
  .split(",")
  .map(u => u.trim())
  .filter(Boolean);

console.log(`✓ Distributed renderers: ${RENDERER_URLS.length > 0 ? RENDERER_URLS.length : "none (single-server mode)"}`);

// ================================
// FFmpeg Detection & Validation
// ================================

function validateFFmpegInstallation() {
  const possiblePaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/ffmpeg/bin/ffmpeg",
    "ffmpeg"
  ];

  let foundPath = null;
  for (const ffmpegPath of possiblePaths) {
    try {
      const result = execSync(`${ffmpegPath} -version 2>&1`, { encoding: "utf-8" });
      if (result.includes("ffmpeg version")) {
        foundPath = ffmpegPath;
        console.log(`✓ FFmpeg found at: ${ffmpegPath}`);
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!foundPath) {
    console.error("❌ CRITICAL: FFmpeg is NOT installed!");
    process.exit(1);
  }

  return foundPath;
}

const FFMPEG_PATH = validateFFmpegInstallation();
const FFPROBE_PATH = FFMPEG_PATH.replace("ffmpeg", "ffprobe");

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

console.log(`✓ FFmpeg Path: ${FFMPEG_PATH}`);
console.log(`✓ FFprobe Path: ${FFPROBE_PATH}`);

// ================================
// Middleware
// ================================

app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

// ================================
// No Token Authentication (Development/Testing)
// ================================

app.use((req, res, next) => {
  next();
});

// ================================
// Directories
// ================================

const UPLOADS_ROOT = path.join(__dirname, "uploads");
const OUTPUT_ROOT  = path.join(__dirname, "output");
const TEMP_ROOT    = path.join(__dirname, "temp");

[UPLOADS_ROOT, OUTPUT_ROOT, TEMP_ROOT].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ================================
// In-Memory Job Store
// ================================

const jobs = {};

function createJob() {
  const jobId = crypto.randomBytes(8).toString("hex");
  jobs[jobId] = {
    status: "queued",
    progress: 0,
    url: null,
    error: null,
    createdAt: new Date()
  };
  return jobId;
}

function updateJob(jobId, patch) {
  if (jobs[jobId]) Object.assign(jobs[jobId], patch);
}

function scheduleJobEviction(jobId) {
  setTimeout(() => { delete jobs[jobId]; }, 3 * 60 * 60 * 1000);
}

// ================================
// Helpers
// ================================

function safeName(value, fallback) {
  const raw = String(value || fallback || "").trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}

function extFor(file, fallback) {
  const original = file?.originalname ? path.extname(file.originalname) : "";
  if (original) return original.toLowerCase();

  const mime = (file?.mimetype || "").toLowerCase();
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png"))  return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("wav"))  return ".wav";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("mp3"))  return ".mp3";
  if (mime.includes("mp4"))  return ".mp4";
  return fallback;
}

function wrapText(text, maxW = 44) {
  if (!text || !text.trim()) return "";

  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxW) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word.slice(0, maxW);
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function cleanupFiles(files = []) {
  files.forEach((file) => {
    try { fs.unlinkSync(file); } catch (_) {}
  });
}

// ================================
// Get Audio Duration (with fallback)
// ================================

function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(audioPath)) {
      return resolve({ valid: false, reason: "Audio file does not exist" });
    }

    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const audioStream = data.streams?.find(s => s.codec_type === "audio");
      if (!audioStream) {
        return resolve({ valid: false, reason: "No audio stream found" });
      }

      const duration = parseFloat(
        audioStream.duration ||
        data.format?.duration ||
        0
      );

      if (!duration || duration <= 0) {
        return resolve({ valid: false, reason: "Invalid audio duration" });
      }

      resolve({ valid: true, duration });
    });
  });
}

// ================================
// Calculate Panel Duration (with priority order)
// ================================

async function calculatePanelDuration(panel) {
  const PADDING = 0.2;

  // Priority 1: ZIP MP3 audio (actual duration)
  if (panel.audio && panel.audio_source === "zip") {
    const audioPath = path.join(panel.dir, panel.audio);
    const result = await getAudioDuration(audioPath);
    if (result.valid) {
      const duration = result.duration + PADDING;
      console.log(`[panel ${panel.index + 1}] ${panel.audio} → ${result.duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
      return duration;
    } else {
      throw new Error(`Panel ${panel.index + 1} audio corrupted: ${result.reason}`);
    }
  }

  // Priority 2: Edge TTS duration (from metadata)
  if (panel.tts_duration && panel.tts_provider === "edge") {
    const duration = panel.tts_duration + PADDING;
    console.log(`[panel ${panel.index + 1}] Edge TTS → ${panel.tts_duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
    return duration;
  }

  // Priority 3: gTTS duration (from metadata)
  if (panel.tts_duration && panel.tts_provider === "gtts") {
    const duration = panel.tts_duration + PADDING;
    console.log(`[panel ${panel.index + 1}] gTTS → ${panel.tts_duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
    return duration;
  }

  // Priority 4: Narration text fallback
  if (panel.narration) {
    const wordCount = String(panel.narration).split(/\s+/).filter(Boolean).length;
    const duration = Math.max(3, Math.min(12, Math.round(wordCount / 2.3) + 1));
    console.log(`[panel ${panel.index + 1}] narration (${wordCount} words) → ${duration} sec`);
    return duration;
  }

  // Priority 5: Default
  console.log(`[panel ${panel.index + 1}] no audio/narration → default 4 sec`);
  return 4;
}

// ================================
// Validate Segment
// ================================

function validateSegment(segPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(segPath)) {
      return resolve({ valid: false, reason: "File does not exist" });
    }

    ffmpeg.ffprobe(segPath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const hasVideo = data.streams?.some(s => s.codec_type === "video");
      const hasAudio = data.streams?.some(s => s.codec_type === "audio");

      if (!hasVideo) {
        return resolve({ valid: false, reason: "No video stream found" });
      }

      if (!hasAudio) {
        return resolve({ valid: false, reason: "No audio stream found" });
      }

      resolve({ valid: true, data });
    });
  });
}

// ================================
// Multer
// ================================

const panelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024, files: 4 }
});

const diskStorage = multer.diskStorage({
  destination: UPLOADS_ROOT,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  }
});

// CHANGE 1: Increased files limit from 400 → 2000
const diskUpload = multer({
  storage: diskStorage,
  limits: {
    fileSize: 2 * 1024 * 1024,  // 2MB per image
    files: 2000                  // up to 2000 images
  }
});

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1000 * 1024 * 1024, files: 1 }  // 1GB — chunk ZIPs can exceed 300MB
});

// ================================
// CHANGE 2: Smart FPS helper by panel count
// ================================

function getFps(panelCount) {
  if (panelCount <= 100)  return 20;
  if (panelCount <= 500)  return 15;
  if (panelCount <= 1000) return 12;
  return 10; // 1000–2000 panels
}

// ================================
// Ken Burns Animation Presets
// ================================

function getKenBurnsFilter(idx, duration, panelCount = 1) {
  // CHANGE 2: Use getFps() helper instead of inline ternary
  const fps = getFps(panelCount);
  const totalFrames = Math.ceil(duration * fps);

  const PRE = "scale=1280:-1";  // Match output resolution — avoids wasted upscale RAM

  const zoomInStep  = "0.0019";
  const zoomOutStart = "1.5";
  const zoomOutStep = "0.0019";
  const panSpeed    = "2.5";
  const diagSpeed   = "1.8";

  const animations = [
    // 0: Slow zoom in from center
    `${PRE},zoompan=z='min(zoom+${zoomInStep},1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=${fps}`,

    // 1: Slow zoom out to center
    `${PRE},zoompan=z='if(lte(zoom,1.0),${zoomOutStart},max(zoom-${zoomOutStep},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=${fps}`,

    // 2: Pan left to right with slight zoom
    `${PRE},zoompan=z='1.3':x='if(lte(on,1),0,min(x+${panSpeed},iw/zoom))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=${fps}`,

    // 3: Pan right to left with slight zoom
    `${PRE},zoompan=z='1.3':x='if(lte(on,1),iw/zoom,max(x-${panSpeed},0))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=${fps}`,

    // 4: Slide up (pan bottom to top)
    `${PRE},zoompan=z='1.3':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih/zoom,max(y-${diagSpeed},0))':d=${totalFrames}:s=1280x720:fps=${fps}`,

    // 5: Slide down (pan top to bottom)
    `${PRE},zoompan=z='1.3':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),0,min(y+${diagSpeed},ih/zoom))':d=${totalFrames}:s=1280x720:fps=${fps}`,
  ];

  return animations[idx % animations.length];
}

// ================================
// Create Segment (MP4)
// ================================

function createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount }) {
  return new Promise((resolve, reject) => {

    const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const wrapped = wrapText(text);
    const kenBurns = getKenBurnsFilter(idx, duration, panelCount);

    const vfParts = [
      kenBurns,
      "setsar=1"
    ];

    const hasAudio = audioPath && fs.existsSync(audioPath);

    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[${RENDERER_NAME}][seg${idx}] START — jobId=${jobId} style=${idx % 6} dur=${duration}s panelCount=${panelCount} mem=${memMB}MB`);

    const cmd = ffmpeg()
      .setFfmpegPath(FFMPEG_PATH)
      .input(imagePath)
      .inputOptions(["-loop 1", "-framerate 25"]);

    if (hasAudio) {
      cmd.input(audioPath);
    } else {
      cmd
        .input(`aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${duration}`)
        .inputOptions(["-f lavfi"]);
    }

    // CHANGE 2: Use getFps() helper for consistent FPS
    const fps = getFps(panelCount);

    cmd
      .outputOptions([
        `-vf ${vfParts.join(",")}`,
        "-c:v libx264",
        "-pix_fmt yuv420p",
        `-r ${fps}`,
        "-preset ultrafast",
        "-movflags +faststart",
        "-c:a aac",
        "-b:a 128k",
        "-shortest",
        `-t ${duration}`
      ])
      .output(outPath)
      .on("start", (cmd) => {
        console.log(`[seg${idx}] FFmpeg started`);
      })
      .on("progress", (progress) => {
        // suppress per-frame logs
      })
      .on("end", () => {
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[seg${idx}] END — mem=${memMB}MB`);
        resolve();
      })
      .on("error", (err) => {
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const isOOM = err.message.includes("Cannot allocate memory") ||
                      err.message.includes("Out of memory") ||
                      err.message.includes("ENOMEM") ||
                      err.message.includes("killed");
        if (isOOM) {
          console.error(`[seg${idx}] ❌ OOM CRASH — mem=${memMB}MB — ${err.message}`);
        } else {
          console.error(`[seg${idx}] ❌ ERROR — mem=${memMB}MB — ${err.message}`);
        }
        reject(err);
      })
      .run();
  });
}

// ================================
// createSegment with retry — THROWS on failure (no silent panel skipping)
// Skipping panels silently breaks story continuity in novel/comic videos.
// ================================

async function createSegmentSafe({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount }) {
  const MAX_RETRIES = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount });
      return;
    } catch (err) {
      lastErr = err;
      const isOOM = err.message.includes("Cannot allocate memory") ||
                    err.message.includes("Out of memory") ||
                    err.message.includes("ENOMEM") ||
                    err.message.includes("killed");
      console.warn(`[seg${idx}] attempt ${attempt}/${MAX_RETRIES} failed${isOOM ? " (OOM)" : ""}: ${err.message.split("\n")[0]}`);
      if (attempt < MAX_RETRIES) {
        const waitMs = isOOM ? 4000 * attempt : 1000 * attempt;
        console.warn(`[seg${idx}] waiting ${waitMs}ms before retry...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  // All retries exhausted — throw so the job fails with a clear panel number
  const msg = `Panel ${idx + 1} failed after ${MAX_RETRIES} attempts: ${lastErr.message.split("\n")[0]}`;
  console.error(`[seg${idx}] ❌ FATAL — ${msg}`);
  throw new Error(msg);
}

// ================================
// SPAWN FFmpeg Helper
// ================================

function spawnFfmpeg(args, description = "") {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ffmpeg ${args.join(" ")}`);
    const proc = spawn(FFMPEG_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      console.log(`[ffmpeg] stderr: ${data}`);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[ffmpeg] ✓ ${description || "Command"} succeeded`);
        resolve({ success: true, stdout, stderr });
      } else {
        const isOOM = stderr.includes("Cannot allocate memory") ||
                      stderr.includes("Out of memory") ||
                      stderr.includes("ENOMEM") ||
                      code === 137;
        const label = isOOM ? "❌ OOM KILL" : "✗";
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const err = new Error(`FFmpeg ${isOOM ? "OOM" : `failed (code ${code})`}: ${description} — mem=${memMB}MB\n${stderr.slice(-800)}`);
        console.error(`[ffmpeg] ${label} ${description} code=${code} mem=${memMB}MB`);
        reject(err);
      }
    });

    proc.on("error", (err) => {
      console.error(`[ffmpeg] spawn error:`, err.message);
      reject(err);
    });
  });
}

// ================================
// CHANGE 4: CONCAT WITH TRANSITIONS — batch + recursive merge
// ================================

const BATCH_SIZE = 50; // max clips per FFmpeg process

async function concatWithTransitions(segPaths, durations, outPath) {
  const n = segPaths.length;
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`\n[concat] START — ${n} segments — mem=${memMB}MB`);

  if (!n) throw new Error("No segments to concat");

  if (n === 1) {
    console.log("[concat] Single segment — copying directly");
    fs.copyFileSync(segPaths[0], outPath);
    return;
  }

  for (let i = 0; i < n; i++) {
    if (!fs.existsSync(segPaths[i])) {
      throw new Error(`Segment ${i} missing: ${segPaths[i]}`);
    }
  }

  if (n <= BATCH_SIZE) {
    // Small enough — use xfade or simple directly
    const USE_XFADE = n <= 30;
    console.log(`[concat] strategy=${USE_XFADE ? "xfade" : "simple-concat"} (${n} clips)`);
    if (USE_XFADE) {
      await concatWithXfade(segPaths, durations, outPath);
    } else {
      await concatSimple(segPaths, outPath);
    }
  } else {
    // Large — batch merge then recursive merge
    await batchMerge(segPaths, durations, outPath);
  }

  const memAfterMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[concat] END — mem=${memAfterMB}MB → ${outPath}`);
}

// ================================
// CHANGE 4a: Batch merge — split into BATCH_SIZE chunks, merge each, then recurse
// ================================

async function batchMerge(segPaths, durations, outPath) {
  const n = segPaths.length;
  const batchCount = Math.ceil(n / BATCH_SIZE);
  console.log(`[batchMerge] ${n} clips → ${batchCount} batches of ≤${BATCH_SIZE}`);

  const batchOutputs = [];
  const batchDurations = [];
  const tempFiles = [];

  for (let b = 0; b < batchCount; b++) {
    const start = b * BATCH_SIZE;
    const end   = Math.min(start + BATCH_SIZE, n);
    const batchSegs = segPaths.slice(start, end);
    const batchDurs = durations.slice(start, end);
    const batchOut  = path.join(TEMP_ROOT, `batch_${Date.now()}_${b}.mp4`);

    console.log(`[batchMerge] batch ${b + 1}/${batchCount}: clips ${start + 1}–${end}`);

    const USE_XFADE = batchSegs.length <= 30;
    if (USE_XFADE) {
      await concatWithXfade(batchSegs, batchDurs, batchOut);
    } else {
      await concatSimple(batchSegs, batchOut);
    }

    batchOutputs.push(batchOut);
    tempFiles.push(batchOut);

    // Sum duration for this batch (used for xfade offsets in next level)
    const totalDur = batchDurs.reduce((a, v) => a + v, 0);
    batchDurations.push(totalDur);

    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[batchMerge] batch ${b + 1} done — mem=${memMB}MB`);
  }

  // Simple concat batch outputs — safer for 500+ panels (avoids xfade memory risk)
  console.log(`[batchMerge] Merging ${batchOutputs.length} batch files → final`);
  try {
    await concatSimple(batchOutputs, outPath);
  } finally {
    cleanupFiles(tempFiles);
  }
}

// ================================
// xfade concat (≤30 clips)
// ================================

async function concatWithXfade(segPaths, durations, outPath) {
  const TRANSITION_DURATION = 0.5;
  const TRANSITION_TYPE     = "slideright";

  let filterComplex = "";
  let currentVideoLabel = "0:v";
  let currentAudioLabel = "0:a";
  let offset = durations[0];

  for (let i = 1; i < segPaths.length; i++) {
    const vLabel = `v${i}`;
    const aLabel = `a${i}`;
    filterComplex +=
      (filterComplex ? ";" : "") +
      `[${currentVideoLabel}][${i}:v]xfade=transition=${TRANSITION_TYPE}:duration=${TRANSITION_DURATION}:offset=${(offset - TRANSITION_DURATION).toFixed(4)}[${vLabel}]` +
      `;[${currentAudioLabel}][${i}:a]acrossfade=d=${TRANSITION_DURATION}:c1=tri:c2=tri[${aLabel}]`;
    currentVideoLabel = vLabel;
    currentAudioLabel = aLabel;
    offset += durations[i];
  }

  filterComplex += `\n[${currentVideoLabel}]format=yuv420p[vout];\n[${currentAudioLabel}]aformat=sample_rates=44100:channel_layouts=stereo[aout]`;

  const inputArgs = [];
  for (const seg of segPaths) inputArgs.push("-i", seg);

  const outputArgs = [
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "23",
    "-preset", "ultrafast",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
    "-y",
    outPath
  ];

  console.log("[concat] Attempting xfade concat...");
  try {
    await spawnFfmpeg([...inputArgs, ...outputArgs], "xfade concat");
    console.log(`[concat] ✓ xfade succeeded`);
  } catch (xfadeErr) {
    console.warn(`[concat] xfade failed (${xfadeErr.message.split("\n")[0]}) — falling back to simple concat`);
    await concatSimple(segPaths, outPath);
  }
}

// ================================
// simple concat (>30 clips or fallback)
// ================================

async function concatSimple(segPaths, outPath) {
  console.log(`[concat] Running simple concat (${segPaths.length} clips)...`);
  const concatFile = path.join(TEMP_ROOT, `concat_${Date.now()}.txt`);
  fs.writeFileSync(concatFile, segPaths.map(s => `file '${s}'`).join("\n"), "utf8");

  const args = [
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "23",
    "-preset", "ultrafast",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
    "-y",
    outPath
  ];

  try {
    await spawnFfmpeg(args, "simple concat");
    console.log(`[concat] ✓ simple concat succeeded`);
  } finally {
    try { fs.unlinkSync(concatFile); } catch (_) {}
  }
}

// ================================
// VALIDATION - Check all panels before render
// ================================

async function validateRenderPanels(panels) {
  const errors = [];

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const panelNum = i + 1;

    // Check image exists
    if (!p.image || !fs.existsSync(path.join(p.dir, p.image))) {
      errors.push(`Panel ${panelNum} image missing`);
      continue;
    }

    console.log(`[validate] ✓ Panel ${panelNum} image valid`);

    // Check audio exists and is valid (if audio is specified)
    if (p.audio) {
      const audioPath = path.join(p.dir, p.audio);
      if (!fs.existsSync(audioPath)) {
        errors.push(`Panel ${panelNum} missing audio`);
        continue;
      }

      const result = await getAudioDuration(audioPath);
      if (!result.valid) {
        errors.push(`Panel ${panelNum} audio corrupted: ${result.reason}`);
        continue;
      }

      console.log(`[validate] ✓ Panel ${panelNum} audio valid (${result.duration.toFixed(1)} sec)`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Render validation failed:\n${errors.join("\n")}`);
  }

  console.log(`[validate] ✓ All ${panels.length} panels validated successfully`);
}

// ================================
// HEALTH CHECK
// ================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    renderer: RENDERER_NAME,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
});

// ================================
// STATUS ROUTE
// ================================

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  // For distributed jobs, include per-part breakdown
  if (job.type === "distributed") {
    return res.json({
      success: true,
      jobId: req.params.jobId,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      totalPanels: job.totalPanels,
      numParts: job.numParts,
      parts: (job.parts || []).map(p => ({
        part: p.partIndex + 1,
        renderer: p.renderer,
        panelCount: p.panelCount,
        status: p.status,
        progress: p.progress,
        remoteJobId: p.remoteJobId,
        error: p.error || null
      })),
      url: job.url || null,
      error: job.error || null,
      createdAt: job.createdAt
    });
  }

  res.json({ success: true, ...job });
});

// ================================
// PANEL UPLOAD ROUTE
// ================================

app.post(
  "/panel",
  panelUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  (req, res) => {
    try {
      const projectId = safeName(req.body.project_id || req.body.projectId, "project");
      const panelId   = safeName(req.body.panel_id || req.body.panelId || `panel_${Date.now()}`, "panel");
      const duration  = Number(req.body.duration || 4);
      const narration = String(req.body.narration || "").trim();

      if (!req.files?.image || !req.files.image[0]) {
        return res.status(400).json({ success: false, error: "Image required" });
      }

      const projectDir = path.join(UPLOADS_ROOT, projectId);
      const panelDir   = path.join(projectDir, panelId);

      [projectDir, panelDir].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });

      const imageBuffer = req.files.image[0].buffer;
      const imagePath = path.join(panelDir, `image.jpg`);
      fs.writeFileSync(imagePath, imageBuffer);

      let audioPath = null;
      let audioFileName = null;
      if (req.files?.audio && req.files.audio[0]) {
        const audioExt = extFor(req.files.audio[0], ".mp3");
        audioFileName = `audio${audioExt}`;
        audioPath = path.join(panelDir, audioFileName);
        fs.writeFileSync(audioPath, req.files.audio[0].buffer);
      }

      const index = Number(req.body.index || 0);

      fs.writeFileSync(
        path.join(panelDir, "metadata.json"),
        JSON.stringify({
          index,
          duration,
          narration,
          image:       "image.jpg",
          audio:       audioFileName,
          uploaded_at: new Date().toISOString()
        }, null, 2)
      );

      console.log(`[panel] saved ${projectId}/${panelId}`);

      return res.json({
        success:    true,
        panel:      panelId,
        panel_id:   panelId,
        ref:        panelId,
        project_id: projectId
      });

    } catch (err) {
      console.error("/panel error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ================================
// AUDIO ZIP UPLOAD ROUTE
// ================================

app.post("/audio-zip", zipUpload.single("audioZip"), async (req, res) => {
  try {
    const projectId = safeName(req.body.project_id || req.body.projectId, "");
    if (!projectId) {
      return res.status(400).json({ success: false, error: "Missing project_id" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "audioZip file required" });
    }

    const projectDir = path.join(UPLOADS_ROOT, projectId);
    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ success: false, error: "Project not found. Upload panels first." });
    }

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    const mp3Entries = entries
      .filter(e => !e.isDirectory)
      .filter(e => {
        const name = e.entryName.replace(/\\/g, "/");
        if (name.includes("__MACOSX")) return false;
        if (path.basename(name).startsWith(".")) return false;
        return /\.mp3$/i.test(name);
      })
      .map(e => {
        const base = path.basename(e.entryName);
        const match = base.match(/(\d+)/);
        return match ? { entry: e, num: Number(match[1]), file: base } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);

    if (!mp3Entries.length) {
      return res.status(400).json({
        success: false,
        error: "No valid numbered MP3 found. Use 1.mp3, 2.mp3, 3.mp3, audio_1.mp3, panel_1.mp3, etc."
      });
    }

    const panelFolders = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .map(name => {
        const dir = path.join(projectDir, name);
        const metaPath = path.join(dir, "metadata.json");
        if (!fs.existsSync(metaPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return { name, dir, metaPath, meta };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.meta.index || 0) - Number(b.meta.index || 0));

    const attached = [];
    const missing = [];

    for (let i = 0; i < panelFolders.length; i++) {
      const panelNumber = i + 1;
      const audio = mp3Entries.find(x => x.num === panelNumber);

      if (!audio) {
        missing.push(panelNumber);
        continue;
      }

      const panel = panelFolders[i];
      const outAudio = path.join(panel.dir, "audio.mp3");

      fs.writeFileSync(outAudio, audio.entry.getData());

      panel.meta.audio = "audio.mp3";
      panel.meta.audio_source = "zip";
      panel.meta.audio_original = audio.file;

      fs.writeFileSync(panel.metaPath, JSON.stringify(panel.meta, null, 2));

      attached.push({
        panel: panelNumber,
        image: panel.meta.image,
        audio: audio.file,
        status: "attached"
      });
    }

    return res.json({
      success: true,
      project_id: projectId,
      totalPanels: panelFolders.length,
      totalMp3Found: mp3Entries.length,
      attached,
      missing,
      message: missing.length
        ? `Attached ${attached.length} audio files. Missing audio for panels: ${missing.join(", ")}`
        : `All ${attached.length} MP3 files attached successfully.`
    });

  } catch (err) {
    console.error("/audio-zip error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ================================
// RENDER CHUNK ZIP ROUTE (called by master on each remote renderer)
// ================================

app.post("/render-chunk-zip", zipUpload.single("chunkZip"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "chunkZip file required" });
    }

    // Create a temp project ID for this chunk
    const chunkProjectId = `chunk_${crypto.randomBytes(8).toString("hex")}`;
    const chunkProjectDir = path.join(UPLOADS_ROOT, chunkProjectId);
    fs.mkdirSync(chunkProjectDir, { recursive: true });

    // Extract the ZIP into the temp project folder
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(chunkProjectDir, true);

    console.log(`[render-chunk-zip] Extracted chunk to ${chunkProjectDir}`);

    // Queue a render job using existing renderFromProject logic
    const jobId = createJob();
    updateJob(jobId, { chunkProjectId });

    res.json({ success: true, jobId, status: "queued", chunkProjectId });

    // Synthesize a req-like object for renderFromProject
    const fakeReq = {
      body: {
        project_id: chunkProjectId,
        panels: null
      },
      get: (h) => req.get(h)
    };

    setImmediate(() => {
      renderFromProject(fakeReq, jobId).catch((err) => {
        console.error(`[chunk-render][${jobId}] Error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
    });

    // Schedule chunk project cleanup after 3 hours
    setTimeout(() => {
      try { fs.rmSync(chunkProjectDir, { recursive: true, force: true }); } catch (_) {}
    }, 3 * 60 * 60 * 1000);

  } catch (err) {
    console.error("/render-chunk-zip error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ================================
// RENDER ROUTE (async background job)
// ================================

app.post("/render", (req, res) => {
  const hasProjectId = req.body?.project_id || req.body?.projectId;

  if (hasProjectId) {
    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      renderFromProject(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled project render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
    });
    return;
  }

  diskUpload.array("images", 2000)(req, res, (multerErr) => {
    if (multerErr) {
      console.error("[/render] Multer error:", multerErr.message);
      return res.status(400).json({ success: false, error: multerErr.message });
    }

    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      renderFromMultipart(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled multipart render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
    });
  });
});

// ================================
// Distributed Render Helpers
// ================================

// Split an array into N roughly-equal chunks
function splitIntoChunks(arr, n) {
  const chunks = [];
  const size = Math.ceil(arr.length / n);
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Build a ZIP buffer for a panel chunk
// Structure: <panelId>/image.jpg, <panelId>/audio.mp3, <panelId>/metadata.json
function buildChunkZip(panels) {
  const zip = new AdmZip();

  for (const panel of panels) {
    const panelId = path.basename(panel.dir);

    // Add image
    const imagePath = path.join(panel.dir, panel.image);
    if (fs.existsSync(imagePath)) {
      zip.addLocalFile(imagePath, panelId, panel.image);
    }

    // Add audio if present
    if (panel.audio) {
      const audioPath = path.join(panel.dir, panel.audio);
      if (fs.existsSync(audioPath)) {
        zip.addLocalFile(audioPath, panelId, panel.audio);
      }
    }

    // Add metadata — rewrite index to be relative within chunk
    const meta = {
      index:        panel._chunkIndex,
      duration:     panel.duration,
      narration:    panel.narration    || "",
      image:        panel.image,
      audio:        panel.audio        || null,
      audio_source: panel.audio_source || null,
      tts_duration: panel.tts_duration || null,
      tts_provider: panel.tts_provider || null
    };
    zip.addFile(
      `${panelId}/metadata.json`,
      Buffer.from(JSON.stringify(meta, null, 2), "utf8")
    );
  }

  return zip.toBuffer();
}

// Poll a remote /status/:jobId until done or error, with timeout
async function pollRemoteStatus(rendererUrl, remoteJobId, masterJobId, partIndex, timeoutMs = 90 * 60 * 1000) {
  const POLL_INTERVAL = 5000;
  const deadline = Date.now() + timeoutMs;

  console.log(`[distributed][part${partIndex + 1}] Polling ${rendererUrl}/status/${remoteJobId}`);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    try {
      const res = await fetch(`${rendererUrl}/status/${remoteJobId}`, { timeout: 15000 });

      if (!res.ok) {
        console.warn(`[distributed][part${partIndex + 1}] Poll HTTP ${res.status} — retrying`);
        continue;
      }

      const data = await res.json();

      // Forward remote progress into master job parts array
      if (jobs[masterJobId] && jobs[masterJobId].parts && jobs[masterJobId].parts[partIndex]) {
        jobs[masterJobId].parts[partIndex].progress = data.progress || 0;
      }

      if (data.status === "done") {
        console.log(`[distributed][part${partIndex + 1}] ✓ Remote render done`);
        return { success: true, url: data.url || data.videoUrl || data.video_url || data.download_url };
      }

      if (data.status === "error") {
        throw new Error(`Remote renderer ${rendererUrl} part ${partIndex + 1} failed: ${data.error}`);
      }

    } catch (err) {
      // Re-throw hard renderer failures immediately
      if (err.message.includes("Remote renderer")) throw err;
      // Network blip — keep retrying until timeout
      console.warn(`[distributed][part${partIndex + 1}] Poll error (will retry): ${err.message}`);
    }
  }

  throw new Error(`Renderer ${rendererUrl} part ${partIndex + 1} timed out after ${timeoutMs / 60000} min`);
}

// Download a remote MP4 to a local temp path
async function downloadPartVideo(url, destPath, partIndex) {
  console.log(`[distributed][part${partIndex + 1}] Downloading ${url} → ${destPath}`);
  const res = await fetch(url, { timeout: 10 * 60 * 1000 });
  if (!res.ok) throw new Error(`Failed to download part ${partIndex + 1}: HTTP ${res.status}`);

  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
  console.log(`[distributed][part${partIndex + 1}] ✓ Downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

// Send chunk ZIP to a remote renderer and get back a remote jobId
async function sendChunkToRenderer(rendererUrl, zipBuffer, partIndex) {
  console.log(`[distributed][part${partIndex + 1}] Sending chunk to ${rendererUrl}/render-chunk-zip`);

  const form = new FormData();
  form.append("chunkZip", zipBuffer, {
    filename:    `chunk_part${partIndex + 1}.zip`,
    contentType: "application/zip"
  });

  const res = await fetch(`${rendererUrl}/render-chunk-zip`, {
    method:  "POST",
    body:    form,
    headers: form.getHeaders(),
    timeout: 5 * 60 * 1000  // 5 min upload timeout
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Renderer ${rendererUrl} rejected chunk upload (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.jobId) throw new Error(`Renderer ${rendererUrl} returned no jobId`);

  console.log(`[distributed][part${partIndex + 1}] ✓ Remote jobId: ${data.jobId}`);
  return data.jobId;
}

// ================================
// RENDER DISTRIBUTED ROUTE
// ================================

app.post("/render-distributed", async (req, res) => {
  if (!RENDERER_URLS.length) {
    return res.status(400).json({
      success: false,
      error: "No RENDERER_URLS configured. Set RENDERER_URLS env var with comma-separated renderer URLs."
    });
  }

  const projectId = safeName(req.body.project_id || req.body.projectId, "");
  if (!projectId) {
    return res.status(400).json({ success: false, error: "Missing project_id" });
  }

  const projectDir = path.join(UPLOADS_ROOT, projectId);
  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({
      success: false,
      error: `No uploaded panels found for project_id: ${projectId}`
    });
  }

  // Read and sort all panels by metadata index
  const panelFolders = fs
    .readdirSync(projectDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir      = path.join(projectDir, d.name);
      const metaPath = path.join(dir, "metadata.json");
      if (!fs.existsSync(metaPath)) return null;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return { ...meta, dir };
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

  if (!panelFolders.length) {
    return res.status(400).json({ success: false, error: "No valid panels found in project" });
  }

  // Use however many renderers are available (up to RENDERER_URLS.length)
  const numRenderers = Math.min(RENDERER_URLS.length, panelFolders.length);
  const chunks       = splitIntoChunks(panelFolders, numRenderers);

  // Create master distributed job
  const jobId    = createJob();
  jobs[jobId] = {
    ...jobs[jobId],
    type:        "distributed",
    project_id:  projectId,
    totalPanels: panelFolders.length,
    numParts:    chunks.length,
    parts:       chunks.map((chunk, i) => ({
      partIndex:   i,
      renderer:    RENDERER_URLS[i],
      panelCount:  chunk.length,
      status:      "queued",
      progress:    0,
      remoteJobId: null,
      videoUrl:    null,
      error:       null
    })),
    phase:    "sending_chunks",
    status:   "processing",
    progress: 0,
    url:      null,
    error:    null
  };

  // Respond immediately with jobId — client polls /status/:jobId
  res.json({
    success:     true,
    jobId,
    status:      "processing",
    totalPanels: panelFolders.length,
    numParts:    chunks.length,
    renderers:   RENDERER_URLS.slice(0, numRenderers)
  });

  // Run distributed render in background
  setImmediate(() =>
    runDistributedRender(jobId, projectId, chunks, req).catch(err => {
      console.error(`[distributed][${jobId}] Unhandled error:`, err.message);
      updateJob(jobId, { status: "error", error: err.message });
      scheduleJobEviction(jobId);
    })
  );
});

// ================================
// Distributed Render Background Task
// ================================

async function runDistributedRender(jobId, projectId, chunks, req) {
  const downloadedParts = [];

  console.log(`\n[distributed][${jobId}] Starting — ${chunks.length} parts across ${chunks.length} renderers`);

  try {

    // ── Phase 1: Build each ZIP and send sequentially — one at a time to avoid RAM spike.
    //    Each buffer is built, uploaded, then released before the next is built.
    //    Remote renderers start immediately on receipt, so all 5 render in parallel
    //    even though the master uploads them one by one.
    updateJob(jobId, { phase: "sending_chunks", progress: 5 });

    const remoteJobIds = [];
    for (let i = 0; i < chunks.length; i++) {
      try {
        const memBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[distributed][${jobId}] Building ZIP part ${i + 1}/${chunks.length} — mem=${memBefore}MB`);

        const panelsWithIdx = chunks[i].map((p, ci) => ({ ...p, _chunkIndex: ci }));
        const zipBuffer     = buildChunkZip(panelsWithIdx);

        const zipMB = (zipBuffer.length / 1024 / 1024).toFixed(1);
        console.log(`[distributed][${jobId}] ZIP part ${i + 1} = ${zipMB}MB — uploading...`);

        const remoteJobId = await sendChunkToRenderer(RENDERER_URLS[i], zipBuffer, i);

        // Zero and release the buffer before building the next ZIP
        zipBuffer.fill(0);

        jobs[jobId].parts[i].status      = "rendering";
        jobs[jobId].parts[i].remoteJobId = remoteJobId;
        remoteJobIds.push(remoteJobId);

        const uploadPct = 5 + Math.round(((i + 1) / chunks.length) * 10);
        updateJob(jobId, { progress: uploadPct });
        console.log(`[distributed][${jobId}] Part ${i + 1} sent → remote job ${remoteJobId}`);

      } catch (err) {
        jobs[jobId].parts[i].status = "error";
        jobs[jobId].parts[i].error  = err.message;
        throw new Error(`Part ${i + 1} upload failed (${RENDERER_URLS[i]}): ${err.message}`);
      }
    }

    updateJob(jobId, { phase: "remote_rendering", progress: 15 });
    console.log(`[distributed][${jobId}] All ${chunks.length} chunks sent — polling for completion...`);

    // ── Phase 2: Poll all renderers in parallel until each finishes ──
    const partResults = await Promise.all(
      remoteJobIds.map(async (remoteJobId, i) => {
        try {
          const result = await pollRemoteStatus(RENDERER_URLS[i], remoteJobId, jobId, i);

          jobs[jobId].parts[i].status   = "done";
          jobs[jobId].parts[i].videoUrl = result.url;
          jobs[jobId].parts[i].progress = 100;

          // Update overall progress: 15–80% across remote renders
          const doneParts = jobs[jobId].parts.filter(p => p.status === "done").length;
          const pct       = 15 + Math.round((doneParts / chunks.length) * 65);
          updateJob(jobId, { progress: pct });

          return result;

        } catch (err) {
          jobs[jobId].parts[i].status = "error";
          jobs[jobId].parts[i].error  = err.message;
          throw err;
        }
      })
    );

    updateJob(jobId, { phase: "downloading_parts", progress: 80 });
    console.log(`[distributed][${jobId}] All remote renders done — downloading part videos...`);

    // ── Phase 3: Download part videos in order (sequential to avoid RAM spike) ──
    for (let i = 0; i < partResults.length; i++) {
      const destPath = path.join(TEMP_ROOT, `dist_${jobId}_part${i}.mp4`);
      await downloadPartVideo(partResults[i].url, destPath, i);
      downloadedParts.push(destPath);
    }

    updateJob(jobId, { phase: "merging", progress: 88 });
    console.log(`[distributed][${jobId}] Merging ${downloadedParts.length} part videos...`);

    // ── Phase 4: Simple concat merge of the 5 part files (no xfade between parts) ──
    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatSimple(downloadedParts, finalPath);

    // Cleanup downloaded part files immediately
    cleanupFiles(downloadedParts);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    // Schedule final video eviction after 2 hours
    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status:       "done",
      phase:        "done",
      progress:     100,
      url,
      videoUrl:     url,
      video_url:    url,
      download_url: url,
      project_id:   projectId,
      totalPanels:  chunks.flat().length,
      numParts:     chunks.length,
      renderer:     RENDERER_NAME,
      format:       "MP4 (H264 Video + AAC Audio)"
    });

    scheduleJobEviction(jobId);
    console.log(`[distributed][${jobId}] ✓ Done → ${url}`);

  } catch (err) {
    console.error(`[distributed][${jobId}] ❌ Error:`, err.message);

    // Identify which part failed for clear error reporting
    const failedPart = jobs[jobId]?.parts?.find(p => p.status === "error");
    const errorMsg   = failedPart
      ? `Part ${failedPart.partIndex + 1} failed on ${failedPart.renderer}: ${err.message}`
      : err.message;

    cleanupFiles(downloadedParts);
    updateJob(jobId, { status: "error", error: errorMsg, phase: "error" });
    scheduleJobEviction(jobId);
  }
}

// ================================
// Render from uploaded panels (background)
// ================================

async function renderFromProject(req, jobId) {
  const projectId = safeName(req.body.project_id || req.body.projectId, "");

  if (!projectId) {
    return updateJob(jobId, { status: "error", error: "Missing project_id" });
  }

  const projectDir = path.join(UPLOADS_ROOT, projectId);

  if (!fs.existsSync(projectDir)) {
    return updateJob(jobId, {
      status: "error",
      error: `No uploaded panels found for project_id ${projectId}`
    });
  }

  let orderedRefs = [];
  try {
    if (Array.isArray(req.body.panels)) {
      orderedRefs = req.body.panels;
    } else if (typeof req.body.panels === "string") {
      orderedRefs = JSON.parse(req.body.panels);
    }
  } catch (_) {
    orderedRefs = [];
  }

  const readPanel = (panelId, fallbackIndex) => {
    const dir = path.join(
      projectDir,
      safeName(panelId, `panel_${fallbackIndex + 1}`)
    );
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { ...meta, dir, index: fallbackIndex };
  };

  let panels = [];

  if (orderedRefs.length) {
    panels = orderedRefs
      .map((p, i) => readPanel(p.ref || p.panel_id || p.id || p.panel, i))
      .filter(Boolean);
  } else {
    const folders = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    panels = folders.map((name, i) => readPanel(name, i)).filter(Boolean);
    panels.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  if (!panels.length) {
    return updateJob(jobId, { status: "error", error: "No complete panels found to render" });
  }

  updateJob(jobId, { status: "processing", progress: 0 });

  const batchIndex   = Number(req.body.batchIndex   || req.body.batch_index   || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);
  const panelCount   = panels.length;

  updateJob(jobId, { batchIndex, totalBatches });

  const segPaths  = [];
  const durations = [];

  try {
    console.log(`[${RENDERER_NAME}][${jobId}] Starting validation — ${panels.length} panels`);
    await validateRenderPanels(panels);

    console.log(`[${RENDERER_NAME}][${jobId}] Starting render — ${panels.length} panels — batch ${batchIndex + 1}/${totalBatches} — panelCount=${panelCount}`);

    // Render each panel sequentially — throws immediately if any panel fails all retries
    for (let i = 0; i < panels.length; i++) {
      const p   = panels[i];
      p.index = i;
      const dur = await calculatePanelDuration(p);
      const segPath = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);

      await createSegmentSafe({
        imagePath: path.join(p.dir, p.image),
        audioPath: p.audio ? path.join(p.dir, p.audio) : null,
        text:      p.narration || "",
        duration:  dur,
        outPath:   segPath,
        jobId,
        idx: i,
        panelCount
      });

      segPaths.push(segPath);
      durations.push(dur);

      const pct = Math.round(((i + 1) / panels.length) * 80);
      updateJob(jobId, { progress: pct });
    }

    if (!segPaths.length) {
      throw new Error("No segments produced.");
    }

    updateJob(jobId, { progress: 85 });

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatWithTransitions(segPaths, durations, finalPath);
    cleanupFiles(segPaths);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status: "done",
      progress: 100,
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      project_id: projectId,
      panels: panels.length,
      rendered: segPaths.length,
      batchIndex,
      totalBatches,
      renderer: RENDERER_NAME,
      format: "MP4 (H264 Video + AAC Audio)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)"
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] Render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] Render ERROR:`, err.message);
    cleanupFiles(segPaths);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ================================
// Render from multipart upload (background)
// ================================

async function renderFromMultipart(req, jobId) {
  const segPaths    = [];
  const durations   = [];
  const uploadPaths = (req.files || []).map((f) => f.path);

  if (!req.files?.length) {
    return updateJob(jobId, { status: "error", error: "No images uploaded." });
  }

  updateJob(jobId, { status: "processing", progress: 0 });

  const batchIndex   = Number(req.body.batchIndex   || req.body.batch_index   || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);
  const panelCount   = req.files.length;

  updateJob(jobId, { batchIndex, totalBatches });

  try {
    const lines = String(req.body.narration || "")
      .split("\n")
      .map((l) => l.trim());

    while (lines.length < req.files.length) lines.push("");

    console.log(`[${RENDERER_NAME}][${jobId}] Starting multipart render — ${req.files.length} images — batch ${batchIndex + 1}/${totalBatches} — panelCount=${panelCount}`);

    // Render each panel sequentially — throws immediately if any panel fails all retries
    for (let i = 0; i < req.files.length; i++) {
      const segPath  = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);
      const wordCount = String(lines[i] || "").split(/\s+/).filter(Boolean).length;
      const dur = Math.max(3, Math.min(12, Math.round(wordCount / 2.3) + 1));

      await createSegmentSafe({
        imagePath: req.files[i].path,
        audioPath: null,
        text:      lines[i] || "",
        duration:  dur,
        outPath:   segPath,
        jobId,
        idx: i,
        panelCount
      });

      segPaths.push(segPath);
      durations.push(dur);

      const pct = Math.round(((i + 1) / req.files.length) * 80);
      updateJob(jobId, { progress: pct });
    }

    if (!segPaths.length) {
      throw new Error("No segments produced.");
    }

    updateJob(jobId, { progress: 85 });

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatWithTransitions(segPaths, durations, finalPath);
    cleanupFiles([...segPaths, ...uploadPaths]);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status: "done",
      progress: 100,
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      panels: req.files.length,
      rendered: segPaths.length,
      batchIndex,
      totalBatches,
      renderer: RENDERER_NAME,
      format: "MP4 (H264 Video + AAC Audio)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)"
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] Multipart render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] Multipart render ERROR:`, err.message);
    cleanupFiles([...segPaths, ...uploadPaths]);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ================================
// 404
// ================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   "Route not found",
    path:    req.originalUrl
  });
});

// ================================
// Auto Cleanup (every 30 min)
// ================================

setInterval(() => {
  const now = Date.now();

  [OUTPUT_ROOT, TEMP_ROOT].forEach((dir) => {
    try {
      fs.readdirSync(dir).forEach((file) => {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
            fs.unlinkSync(full);
            console.log(`[cleanup] Deleted old file: ${file}`);
          }
        } catch (_) {}
      });
    } catch (_) {}
  });
}, 30 * 60 * 1000);

// ================================
// START
// ================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ScriptReel running on port ${PORT}`);
  console.log(`Renderer: ${RENDERER_NAME}`);
  console.log(`FFmpeg: ${FFMPEG_PATH}`);
});
