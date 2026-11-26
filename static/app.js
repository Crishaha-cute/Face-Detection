const $ = (id) => document.getElementById(id);
const page = document.body.dataset.page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, ...data };
}

function say(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status " + kind;
}

function flash(kind) {
  const f = $("finder");
  f.classList.remove("ok", "bad");
  f.classList.add(kind);
  setTimeout(() => f.classList.remove(kind), 1800);
}

async function startCamera() {
  const video = $("video");
  if (!navigator.mediaDevices?.getUserMedia) {
    say("Camera not available. Use HTTPS or localhost.", "bad");
    return false;
  }
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    await video.play();
    return true;
  } catch {
    say("Camera blocked. Allow camera access in your browser and reload.", "bad");
    return false;
  }
}

function grabFrame() {
  const v = $("video"), c = $("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  return c.toDataURL("image/jpeg", 0.85);
}

// Low-resolution frame grab for fast pose verification
function grabFrameSmall() {
  const v = $("video"), c = $("canvas");
  c.width = 320;
  c.height = 240;
  c.getContext("2d").drawImage(v, 0, 0, 320, 240);
  return c.toDataURL("image/jpeg", 0.65);
}

async function withScan(fn) {
  const btn = $("action");
  btn.disabled = true;
  $("finder").classList.add("scanning");
  try { await fn(); } finally {
    $("finder").classList.remove("scanning");
    btn.disabled = false;
  }
}

function beep(freq = 880, dur = 0.15) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq; g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur);
    setTimeout(() => ctx.close(), Math.round((dur + 0.3) * 1000));
  } catch {}
}

// Visual Step & Progress Bar Manager
function setScanStep(stepNum, progressPercent, doneSteps = []) {
  const wrap = $("scan-progress-wrap");
  const bar = $("scan-progress-bar");
  if (wrap) wrap.hidden = false;
  if (bar) bar.style.width = progressPercent + "%";

  for (let i = 1; i <= 3; i++) {
    const el = $("step-ind-" + i);
    if (!el) continue;
    const circle = el.querySelector(".step-circle");
    el.classList.remove("active", "done");
    if (doneSteps.includes(i)) {
      el.classList.add("done");
      if (circle) circle.textContent = "✓";
    } else if (i === stepNum) {
      el.classList.add("active");
      if (circle) circle.textContent = i;
    } else {
      if (circle) circle.textContent = i;
    }
  }
}

function hideScanProgress() {
  const wrap = $("scan-progress-wrap");
  if (wrap) wrap.hidden = true;
}

// Interactive step-by-step liveness scanner
// Requires: 1. Look straight -> 2. Rotate/turn head slightly left or right -> 3. Close eyes
async function runChallenge() {
  const c = await post("/api/challenge");
  if (!c.ok) throw new Error(c.error || "Could not start the scan.");

  const tiltLabel = $("step-label-tilt");
  if (tiltLabel) tiltLabel.textContent = `Turn ${c.tilt === "left" ? "Left" : "Right"}`;

  setScanStep(1, 10, []);
  $("prompt").hidden = false;
  $("prompt-count").textContent = "";

  const out = { token: c.token, straight: [], tilt: [], eyes: [] };
  let baselineRoll = 0;
  let baselineYaw = 0;
  let openContrasts = [];

  // ---------- STEP 1: Look Straight ----------
  // Strictly requires 3 consecutive level frames facing camera
  $("prompt-text").textContent = "Look straight at the camera";
  let straightFrames = [];
  let straightPassedCount = 0;
  const start1 = Date.now();

  while (straightPassedCount < 3) {
    if (Date.now() - start1 > 60000) throw new Error("Scan timed out. Please restart.");
    const fullImg = grabFrame();
    const res = await post("/api/verify_pose", {
      token: c.token,
      step: "straight",
      frame: grabFrameSmall(),
    });

    if (res.ok && res.passed) {
      straightFrames.push(fullImg);
      straightPassedCount++;
      baselineRoll = res.roll || 0;
      baselineYaw = res.yaw || 0;
      if (typeof res.contrast === "number" && res.contrast > 5) {
        openContrasts.push(res.contrast);
      }
      $("prompt-text").textContent = "Hold still…";
    } else {
      straightFrames = [];
      straightPassedCount = 0;
      if (res.reason) $("prompt-text").textContent = res.reason;
    }
    await sleep(140);
  }

  // Calculate actual open-eye baseline contrast for this user
  const openContrast = openContrasts.length > 0
    ? (openContrasts.reduce((a, b) => a + b, 0) / openContrasts.length)
    : 28.0;

  beep(720);
  setScanStep(2, 38, [1]);
  out.straight = straightFrames.slice(-2);
  $("prompt-text").textContent = "✓ Level! Next step…";
  await sleep(700);

  // ---------- STEP 2: Rotate / Turn Head Slightly ----------
  // Rotates head horizontally to the left or right (not ear-to-shoulder)
  const turnPrompt = `Turn your head slightly to the ${c.tilt}`;
  $("prompt-text").textContent = turnPrompt;
  let tiltFrames = [];
  let tiltPassedCount = 0;
  const start2 = Date.now();

  while (tiltPassedCount < 3) {
    if (Date.now() - start2 > 60000) throw new Error("Scan timed out. Please restart.");
    const fullImg = grabFrame();
    const res = await post("/api/verify_pose", {
      token: c.token,
      step: "turn",
      frame: grabFrameSmall(),
      baseline_yaw: baselineYaw,
      baseline_roll: baselineRoll,
    });

    if (res.ok && res.passed) {
      tiltFrames.push(fullImg);
      tiltPassedCount++;
      $("prompt-text").textContent = "Good, hold that turn…";
    } else {
      tiltFrames = [];
      tiltPassedCount = 0;
      $("prompt-text").textContent = res.reason || turnPrompt;
    }
    await sleep(140);
  }

  beep(880);
  setScanStep(3, 72, [1, 2]);
  out.tilt = tiltFrames.slice(-2);
  $("prompt-text").textContent = "✓ Turn confirmed! Next step…";
  await sleep(700);

  // ---------- STEP 3: Close Eyes (Quick & Responsive) ----------
  $("prompt-text").textContent = "Close your eyes briefly";
  $("prompt-count").textContent = "";
  beep(660, 0.15);

  // Short 300ms transition delay so the user sees the prompt and hears the chime
  await sleep(300);

  let eyesFrames = [];
  const start3 = Date.now();

  // Requires only 2 quick verified frames (or 1 fast closure) to pass immediately
  while (eyesFrames.length < 2) {
    if (Date.now() - start3 > 60000) throw new Error("Scan timed out. Please restart.");
    const fullImg = grabFrame();
    const res = await post("/api/verify_pose", {
      token: c.token,
      step: "eyes",
      frame: grabFrameSmall(),
      open_contrast: openContrast,
    });

    if (res.ok && res.passed) {
      eyesFrames.push(fullImg);
      $("prompt-text").textContent = "Keep eyes closed…";
    } else {
      eyesFrames = [];
      $("prompt-text").textContent = "Close your eyes now";
    }
    await sleep(90);
  }

  beep(1040, 0.2);
  setScanStep(3, 100, [1, 2, 3]);
  out.eyes = eyesFrames.length >= 2 ? eyesFrames.slice(-2) : [eyesFrames[0], eyesFrames[0]];
  $("prompt-text").textContent = "✓ Verified! You can open your eyes";
  await sleep(200);

  return out;
}

async function cameraPage() {
  const ready = await startCamera();
  if (!ready) return;
  say(page === "login" ? "Ready. Press Start face scan." : "Enter a username, then start the scan.");
  $("action").disabled = false;

  $("action").addEventListener("click", () => withScan(async () => {
    let username = "";
    if (page === "register") {
      username = $("username").value.trim();
      if (!username) { say("Enter a username first.", "bad"); $("username").focus(); return; }
    }
    try {
      say("Follow the prompts on the camera.");
      const poses = await runChallenge();
      $("prompt").hidden = true;
      say(page === "login" ? "Checking face print…" : "Saving your account…");
      const r = await post(page === "login" ? "/api/login" : "/api/register", { ...poses, username });
      if (r.ok) { flash("ok"); say("Done. Signing in…", "ok"); location.href = r.redirect; }
      else { flash("bad"); hideScanProgress(); say(r.error || "Something went wrong.", "bad"); }
    } catch (e) {
      $("prompt").hidden = true;
      hideScanProgress();
      flash("bad"); say(e.message || "Something went wrong.", "bad");
    }
  }));
}

if (page === "login" || page === "register") cameraPage();

function stopCamera() {
  const v = $("video");
  v?.srcObject?.getTracks().forEach((t) => t.stop());
  if (v) v.srcObject = null;
}

// ==========================================
// Dashboard & Live Face Accessories Studio
// ==========================================
if (page === "dashboard") {
  const fmt = (utc) => new Date(utc.replace(" ", "T") + "Z").toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  document.querySelectorAll("[data-utc]").forEach((t) => (t.textContent = fmt(t.dataset.utc)));

  // ----- sign out -----
  $("logout").addEventListener("click", async () => { location.href = (await post("/api/logout")).redirect; });

  // ----- delete account behind a fresh face scan -----
  const dlg = $("rescan");
  const closeDialog = () => { stopCamera(); $("prompt").hidden = true; hideScanProgress(); if (dlg.open) dlg.close(); };
  $("delete").addEventListener("click", async () => {
    say("Starting camera…"); $("action").disabled = true; dlg.showModal();
    if (await startCamera()) { say("Ready. Press Start face scan."); $("action").disabled = false; }
  });
  $("cancel").addEventListener("click", closeDialog);
  dlg.addEventListener("close", stopCamera);
  $("action").addEventListener("click", () => withScan(async () => {
    try {
      say("Follow the prompts on the camera.");
      const poses = await runChallenge();
      $("prompt").hidden = true;
      say("Checking…");
      const r = await post("/api/rescan", poses);
      if (!r.ok) { flash("bad"); hideScanProgress(); return say(r.error || "Something went wrong.", "bad"); }
      flash("ok"); closeDialog();
      if (!confirm("Delete your account permanently? This can't be undone.")) return;
      const d = await post("/api/delete");
      if (d.ok) location.href = d.redirect; else alert(d.error || "Could not delete the account.");
    } catch (e) {
      $("prompt").hidden = true; hideScanProgress(); flash("bad"); say(e.message || "Something went wrong.", "bad");
    }
  }));

  // ----- Live Accessories Studio -----
  initAccessoriesStudio();
}

function initAccessoriesStudio() {
  const video = $("acc-video");
  const canvas = $("acc-canvas");
  const badge = $("tracker-badge");
  const scaleInput = $("acc-scale");
  const scaleVal = $("scale-val");
  const yoffInput = $("acc-yoff");
  const yoffVal = $("yoff-val");
  const snapBtn = $("acc-snap");
  const clearBtn = $("acc-clear");
  const accBtns = document.querySelectorAll(".acc-btn");

  if (!canvas || !video) return;
  const ctx = canvas.getContext("2d");

  const activeAccessories = new Set(["sunglasses"]);
  let globalScale = 1.0;
  let customYOffset = 0;

  accBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.dataset.item;
      if (activeAccessories.has(item)) {
        activeAccessories.delete(item);
        btn.classList.remove("active");
      } else {
        activeAccessories.add(item);
        btn.classList.add("active");
      }
    });
  });

  scaleInput.addEventListener("input", (e) => {
    globalScale = parseInt(e.target.value, 10) / 100;
    scaleVal.textContent = e.target.value + "%";
  });

  yoffInput.addEventListener("input", (e) => {
    customYOffset = parseInt(e.target.value, 10);
    yoffVal.textContent = (customYOffset > 0 ? "+" : "") + customYOffset + "px";
  });

  clearBtn.addEventListener("click", () => {
    activeAccessories.clear();
    accBtns.forEach((b) => b.classList.remove("active"));
  });

  snapBtn.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = `face-accessories-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  // Start dedicated video stream for studio
  navigator.mediaDevices?.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  }).then(async (stream) => {
    video.srcObject = stream;
    await video.play();
    requestAnimationFrame(renderLoop);
    startDetectionLoop();
  }).catch(() => {
    badge.textContent = "Camera unavailable";
  });

  // ========================================================
  // 1-Euro Filter & Anti-Jitter Deadband for Rock-Solid AR
  // ========================================================
  class OneEuroFilter {
    constructor(minCutoff = 0.5, beta = 0.008, dCutoff = 1.0) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.xPrev = null;
      this.dxPrev = 0;
      this.tPrev = null;
    }
    filter(x, t = performance.now()) {
      if (this.xPrev === null || isNaN(this.xPrev)) {
        this.xPrev = x;
        this.dxPrev = 0;
        this.tPrev = t;
        return x;
      }
      const dt = Math.max((t - this.tPrev) / 1000, 0.001);
      this.tPrev = t;

      const dx = (x - this.xPrev) / dt;
      const edx = this.alpha(this.dCutoff, dt);
      const dxHat = edx * dx + (1 - edx) * this.dxPrev;
      this.dxPrev = dxHat;

      const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
      const a = this.alpha(cutoff, dt);
      const xHat = a * x + (1 - a) * this.xPrev;
      this.xPrev = xHat;
      return xHat;
    }
    alpha(cutoff, dt) {
      const tau = 1.0 / (2 * Math.PI * cutoff);
      return 1.0 / (1.0 + tau / dt);
    }
    reset() {
      this.xPrev = null;
      this.dxPrev = 0;
      this.tPrev = null;
    }
  }

  // Multi-channel stabilizers
  const fEyeX = new OneEuroFilter(0.65, 0.012);
  const fEyeY = new OneEuroFilter(0.65, 0.012);
  const fEyeDist = new OneEuroFilter(0.35, 0.004); // heavily stabilize size
  const fAngle = new OneEuroFilter(0.30, 0.005);   // heavily stabilize rotation to prevent hat wobble
  const fHeadTop = new OneEuroFilter(0.40, 0.006); // stabilize crown/hat base height
  const fNoseX = new OneEuroFilter(0.65, 0.012);
  const fNoseY = new OneEuroFilter(0.65, 0.012);
  const fMouthX = new OneEuroFilter(0.65, 0.012);
  const fMouthY = new OneEuroFilter(0.65, 0.012);

  let rawTarget = null;
  let detecting = false;
  let lastTrackTime = 0;
  let stableAngle = null;

  // Offscreen canvas: 480x360 for sharper landmark resolution and low bandwidth
  const offCanvas = document.createElement("canvas");
  offCanvas.width = 480;
  offCanvas.height = 360;
  const offCtx = offCanvas.getContext("2d");

  async function startDetectionLoop() {
    while (true) {
      if (video.videoWidth && !detecting) {
        detecting = true;
        const vAspect = video.videoHeight / (video.videoWidth || 1);
        offCanvas.height = Math.round(offCanvas.width * vAspect);
        offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
        const dataUrl = offCanvas.toDataURL("image/jpeg", 0.65);
        try {
          const res = await post("/api/detect_landmarks", { frame: dataUrl });
          if (res.ok && res.landmarks) {
            rawTarget = res.landmarks;
            lastTrackTime = Date.now();
            badge.textContent = "Face tracked 🎯";
            badge.classList.add("active");
          } else if (Date.now() - lastTrackTime > 750) {
            badge.textContent = "Looking for face…";
            badge.classList.remove("active");
          }
        } catch {}
        detecting = false;
      }
      await sleep(50);
    }
  }

  function renderLoop(frameTime) {
    if (video.videoWidth && video.videoHeight) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      const W = canvas.width;
      const H = canvas.height;

      // Draw camera frame mirrored (natural selfie mirror view)
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -W, 0, W, H);
      ctx.restore();

      const hasRecentFace = rawTarget && (Date.now() - lastTrackTime < 750);

      if (hasRecentFace) {
        const scaleX = W / rawTarget.w;
        const scaleY = H / rawTarget.h;

        // In mirrored view: mirrored X = W - (raw_x * scaleX)
        const ptA = { x: W - rawTarget.eye_left[0] * scaleX, y: rawTarget.eye_left[1] * scaleY };
        const ptB = { x: W - rawTarget.eye_right[0] * scaleX, y: rawTarget.eye_right[1] * scaleY };

        // Ensure eye1 is strictly screen-left (smaller X) and eye2 is screen-right (larger X)
        const [eye1, eye2] = [ptA, ptB].sort((a, b) => a.x - b.x);

        const rawNose = { x: W - rawTarget.nose[0] * scaleX, y: rawTarget.nose[1] * scaleY };
        const m1 = { x: W - rawTarget.mouth_left[0] * scaleX, y: rawTarget.mouth_left[1] * scaleY };
        const m2 = { x: W - rawTarget.mouth_right[0] * scaleX, y: rawTarget.mouth_right[1] * scaleY };
        const rawMouthCenter = { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 };

        const rawEyeCenter = { x: (eye1.x + eye2.x) / 2, y: (eye1.y + eye2.y) / 2 };
        const rawEyeDist = Math.hypot(eye2.x - eye1.x, eye2.y - eye1.y);
        let rawAngle = Math.atan2(eye2.y - eye1.y, eye2.x - eye1.x);

        // Anti-jitter deadband for rotation angle:
        // Human head naturally has micro-tremors. Clamping small angle deltas (< 0.018 rad ≈ 1 deg)
        // completely eliminates the side-to-side wobble on tall accessories.
        if (stableAngle === null) {
          stableAngle = rawAngle;
        } else {
          let diff = rawAngle - stableAngle;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          if (Math.abs(diff) < 0.016) {
            rawAngle = stableAngle; // inside deadband, keep rock solid
          } else {
            stableAngle += diff * 0.22; // smoothly adapt to genuine head turns
            rawAngle = stableAngle;
          }
        }

        // Anatomically anchored head top distance: tied to stable interpupillary distance
        const rawHeadTopDist = rawEyeDist * 1.90 + customYOffset;

        // Apply 1-Euro adaptive temporal smoothing filters
        const eyeCenterX = fEyeX.filter(rawEyeCenter.x, frameTime);
        const eyeCenterY = fEyeY.filter(rawEyeCenter.y, frameTime);
        const eyeDist = fEyeDist.filter(rawEyeDist, frameTime);
        const rollRad = fAngle.filter(rawAngle, frameTime);
        const headTopDist = fHeadTop.filter(rawHeadTopDist, frameTime);

        const nose = {
          x: fNoseX.filter(rawNose.x, frameTime),
          y: fNoseY.filter(rawNose.y, frameTime),
        };
        const mouthCenter = {
          x: fMouthX.filter(rawMouthCenter.x, frameTime),
          y: fMouthY.filter(rawMouthCenter.y, frameTime),
        };

        const eyeCenter = { x: eyeCenterX, y: eyeCenterY };

        // Draw active accessories with rock-solid coordinates
        if (activeAccessories.has("tophat")) drawTopHat(ctx, eyeCenter, eyeDist, rollRad, headTopDist, globalScale);
        if (activeAccessories.has("crown")) drawCrown(ctx, eyeCenter, eyeDist, rollRad, headTopDist, globalScale);
        if (activeAccessories.has("bunny")) drawBunnyEars(ctx, eyeCenter, eyeDist, rollRad, headTopDist, globalScale);
        if (activeAccessories.has("catears")) drawCatEars(ctx, eyeCenter, eyeDist, rollRad, headTopDist, nose, globalScale);
        if (activeAccessories.has("sunglasses")) drawSunglasses(ctx, eyeCenter, eyeDist, rollRad, globalScale);
        if (activeAccessories.has("cybervisor")) drawCyberVisor(ctx, eyeCenter, eyeDist, rollRad, globalScale);
        if (activeAccessories.has("carnival")) drawCarnivalMask(ctx, eyeCenter, eyeDist, rollRad, globalScale);
        if (activeAccessories.has("moustache")) drawMoustache(ctx, nose, mouthCenter, eyeDist, rollRad, globalScale);
      } else {
        stableAngle = null;
        fEyeX.reset();
        fEyeY.reset();
        fEyeDist.reset();
        fAngle.reset();
        fHeadTop.reset();
        fNoseX.reset();
        fNoseY.reset();
        fMouthX.reset();
        fMouthY.reset();
      }
    }
    requestAnimationFrame(renderLoop);
  }
}

// ==========================================
// Vector Accessory Renderers
// ==========================================

function drawSunglasses(ctx, center, eyeDist, angle, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  const w = eyeDist * 2.3 * scale;
  const h = w * 0.42;

  // Frame bridge
  ctx.fillStyle = "#111827";
  ctx.fillRect(-w * 0.12, -h * 0.1, w * 0.24, h * 0.18);

  // Left & right lenses
  [-1, 1].forEach((side) => {
    ctx.save();
    ctx.translate(side * w * 0.26, 0);

    // Outer dark rim
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.roundRect(-w * 0.23, -h * 0.48, w * 0.46, h * 0.96, [h * 0.25, h * 0.25, h * 0.45, h * 0.45]);
    ctx.fill();

    // Dark tinted lens
    const grad = ctx.createLinearGradient(0, -h * 0.4, 0, h * 0.4);
    grad.addColorStop(0, "#232b38");
    grad.addColorStop(0.5, "#0b0f19");
    grad.addColorStop(1, "#030712");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(-w * 0.20, -h * 0.42, w * 0.40, h * 0.84, [h * 0.2, h * 0.2, h * 0.4, h * 0.4]);
    ctx.fill();

    // Gloss glare highlight
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-w * 0.12, -h * 0.25);
    ctx.lineTo(w * 0.05, h * 0.22);
    ctx.stroke();

    ctx.restore();
  });

  ctx.restore();
}

function drawCrown(ctx, center, eyeDist, angle, headTopDist, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  const w = eyeDist * 2.3 * scale;
  const h = w * 0.72;
  const yOffset = -headTopDist * scale;

  ctx.translate(0, yOffset);

  // Golden Crown Body
  const grad = ctx.createLinearGradient(0, -h, 0, 0);
  grad.addColorStop(0, "#fde047");
  grad.addColorStop(0.5, "#eab308");
  grad.addColorStop(1, "#ca8a04");
  ctx.fillStyle = grad;
  ctx.strokeStyle = "#854d0e";
  ctx.lineWidth = 3;

  ctx.beginPath();
  // Arched bottom resting gracefully on head
  ctx.moveTo(-w * 0.46, 0);
  ctx.lineTo(-w * 0.50, -h * 0.72);
  ctx.lineTo(-w * 0.25, -h * 0.36);
  ctx.lineTo(0, -h);
  ctx.lineTo(w * 0.25, -h * 0.36);
  ctx.lineTo(w * 0.50, -h * 0.72);
  ctx.lineTo(w * 0.46, 0);
  ctx.quadraticCurveTo(0, h * 0.08, -w * 0.46, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Bottom Crown Band
  ctx.fillStyle = "#a16207";
  ctx.beginPath();
  ctx.moveTo(-w * 0.46, 0);
  ctx.lineTo(-w * 0.46, -h * 0.14);
  ctx.quadraticCurveTo(0, -h * 0.06, w * 0.46, -h * 0.14);
  ctx.lineTo(w * 0.46, 0);
  ctx.quadraticCurveTo(0, h * 0.08, -w * 0.46, 0);
  ctx.closePath();
  ctx.fill();

  // Sparkling Jewels
  const jewels = [
    { x: -w * 0.50, y: -h * 0.72, color: "#ef4444", r: h * 0.085 },
    { x: 0, y: -h, color: "#3b82f6", r: h * 0.10 },
    { x: w * 0.50, y: -h * 0.72, color: "#10b981", r: h * 0.085 },
    { x: -w * 0.26, y: -h * 0.07, color: "#ec4899", r: h * 0.06 },
    { x: 0, y: -h * 0.05, color: "#38bdf8", r: h * 0.07 },
    { x: w * 0.26, y: -h * 0.07, color: "#a855f7", r: h * 0.06 },
  ];
  jewels.forEach((j) => {
    ctx.fillStyle = j.color;
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  ctx.restore();
}

function drawTopHat(ctx, center, eyeDist, angle, headTopDist, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  const w = eyeDist * 2.3 * scale;
  const h = w * 0.95;
  const yOffset = -headTopDist * scale;

  ctx.translate(0, yOffset);

  // Brim resting curved on the top of head
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.65, h * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Cylinder Top standing tall
  const grad = ctx.createLinearGradient(-w * 0.38, 0, w * 0.38, 0);
  grad.addColorStop(0, "#1e293b");
  grad.addColorStop(0.4, "#334155");
  grad.addColorStop(0.6, "#334155");
  grad.addColorStop(1, "#0f172a");
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(-w * 0.40, 0);
  ctx.lineTo(-w * 0.36, -h);
  ctx.lineTo(w * 0.36, -h);
  ctx.lineTo(w * 0.40, 0);
  ctx.closePath();
  ctx.fill();

  // Top Cap Ellipse
  ctx.fillStyle = "#334155";
  ctx.beginPath();
  ctx.ellipse(0, -h, w * 0.36, h * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Red Ribbon Band
  ctx.fillStyle = "#dc2626";
  ctx.beginPath();
  ctx.moveTo(-w * 0.40, 0);
  ctx.lineTo(-w * 0.39, -h * 0.22);
  ctx.lineTo(w * 0.39, -h * 0.22);
  ctx.lineTo(w * 0.40, 0);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawMoustache(ctx, nose, mouthCenter, eyeDist, angle, scale) {
  ctx.save();
  const posX = (nose.x + mouthCenter.x) / 2;
  const posY = (nose.y * 0.45 + mouthCenter.y * 0.55);
  ctx.translate(posX, posY);
  ctx.rotate(angle);

  const w = eyeDist * 1.5 * scale;
  const h = w * 0.35;

  ctx.fillStyle = "#1c1917";
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.2);
  ctx.bezierCurveTo(-w * 0.2, -h * 0.6, -w * 0.45, -h * 0.2, -w * 0.5, h * 0.4);
  ctx.bezierCurveTo(-w * 0.4, h * 0.8, -w * 0.25, h * 0.1, 0, h * 0.2);
  ctx.bezierCurveTo(w * 0.25, h * 0.1, w * 0.4, h * 0.8, w * 0.5, h * 0.4);
  ctx.bezierCurveTo(w * 0.45, -h * 0.2, w * 0.2, -h * 0.6, 0, -h * 0.2);
  ctx.fill();

  ctx.restore();
}

function drawCyberVisor(ctx, center, eyeDist, angle, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  const w = eyeDist * 2.3 * scale;
  const h = w * 0.35;

  ctx.shadowColor = "#06b6d4";
  ctx.shadowBlur = 15;

  const grad = ctx.createLinearGradient(0, -h * 0.5, 0, h * 0.5);
  grad.addColorStop(0, "rgba(6, 182, 212, 0.85)");
  grad.addColorStop(1, "rgba(59, 130, 246, 0.75)");
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(-w * 0.5, -h * 0.5);
  ctx.lineTo(w * 0.5, -h * 0.5);
  ctx.lineTo(w * 0.45, h * 0.5);
  ctx.lineTo(-w * 0.45, h * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-w * 0.35, 0);
  ctx.lineTo(w * 0.35, 0);
  ctx.moveTo(0, -h * 0.35);
  ctx.lineTo(0, h * 0.35);
  ctx.stroke();

  ctx.restore();
}

function drawCatEars(ctx, center, eyeDist, angle, headTopDist, nose, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);

  const w = eyeDist * 2.2 * scale;
  const yOffset = -headTopDist * scale;

  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(0, w * 0.3, w * 0.44, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();

  [-1, 1].forEach((side) => {
    ctx.save();
    ctx.translate(side * w * 0.30, yOffset);
    ctx.rotate(side * 0.12);

    ctx.fillStyle = "#1e293b";
    ctx.beginPath();
    ctx.moveTo(-w * 0.16, 0);
    ctx.lineTo(0, -w * 0.45);
    ctx.lineTo(w * 0.16, 0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#f472b6";
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, -w * 0.04);
    ctx.lineTo(0, -w * 0.36);
    ctx.lineTo(w * 0.1, -w * 0.04);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  });
  ctx.restore();

  ctx.save();
  ctx.translate(nose.x, nose.y);
  ctx.rotate(angle);

  ctx.fillStyle = "#f472b6";
  ctx.beginPath();
  ctx.ellipse(0, 0, eyeDist * 0.15 * scale, eyeDist * 0.1 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  [-1, 1].forEach((side) => {
    const sx = side * eyeDist * 0.25 * scale;
    [-0.2, 0, 0.2].forEach((spread) => {
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(side * eyeDist * 1.1 * scale, spread * eyeDist * 0.4 * scale);
      ctx.stroke();
    });
  });

  ctx.restore();
}

function drawBunnyEars(ctx, center, eyeDist, angle, headTopDist, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  const w = eyeDist * 2.1 * scale;
  const h = w * 1.6;
  const yOffset = -headTopDist * scale;

  ctx.translate(0, yOffset);

  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(0, h * 0.2, w * 0.45, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();

  [-1, 1].forEach((side) => {
    ctx.save();
    ctx.translate(side * w * 0.22, 0);
    ctx.rotate(side * 0.14);

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w * 0.17, h * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#f472b6";
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.48, w * 0.09, h * 0.40, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });

  ctx.restore();
}

function drawCarnivalMask(ctx, center, eyeDist, angle, scale) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  const w = eyeDist * 2.4 * scale;
  const h = w * 0.48;

  const grad = ctx.createLinearGradient(0, -h * 0.5, 0, h * 0.5);
  grad.addColorStop(0, "#7c3aed");
  grad.addColorStop(1, "#4c1d95");
  ctx.fillStyle = grad;
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(0, h * 0.15);
  ctx.bezierCurveTo(-w * 0.2, h * 0.4, -w * 0.45, h * 0.4, -w * 0.5, 0);
  ctx.bezierCurveTo(-w * 0.45, -h * 0.6, -w * 0.15, -h * 0.5, 0, -h * 0.15);
  ctx.bezierCurveTo(w * 0.15, -h * 0.5, w * 0.45, -h * 0.6, w * 0.5, 0);
  ctx.bezierCurveTo(w * 0.45, h * 0.4, w * 0.2, h * 0.4, 0, h * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  [-1, 1].forEach((side) => {
    ctx.beginPath();
    ctx.ellipse(side * w * 0.24, -h * 0.05, w * 0.14, h * 0.22, side * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  ctx.restore();
}
