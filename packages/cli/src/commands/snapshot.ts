import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject } from "../utils/project.js";
import { c } from "../ui/colors.js";
import type { Example } from "./_examples.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extract a single frame from a video file at `timeSeconds` via FFmpeg.
 * Used to work around Chrome-headless's inability to reliably seek
 * <video> elements during snapshot capture.
 */
async function extractVideoFrameToBuffer(
  videoPath: string,
  timeSeconds: number,
): Promise<Buffer | null> {
  const tmp = mkdtempSync(join(tmpdir(), "hf-snapshot-frame-"));
  const outPath = join(tmp, "frame.png");
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
      // `-ss` before `-i` performs a fast keyframe seek; adequate for snapshot accuracy
      // (±1 frame) and orders of magnitude faster than the decode-and-scan alternative.
      const ff = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(Math.max(0, timeSeconds)),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        outPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      ff.on("close", (code) => resolvePromise({ code, stderr }));
      ff.on("error", () => resolvePromise({ code: null, stderr: "ffmpeg spawn failed" }));
    });
    if (result.code !== 0 || !existsSync(outPath)) return null;
    return readFileSync(outPath);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export const examples: Example[] = [
  ["Capture 5 key frames from a composition", "snapshot captures/stripe"],
  ["Capture 10 evenly-spaced frames", "snapshot captures/stripe --frames 10"],
];

/**
 * Render key frames from a composition as PNG screenshots.
 * The agent can Read these to verify its output visually.
 */
async function captureSnapshots(
  projectDir: string,
  opts: { frames?: number; timeout?: number; at?: number[] },
): Promise<string[]> {
  const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
  const { ensureBrowser } = await import("../browser/manager.js");

  const numFrames = opts.frames ?? 5;

  // 1. Bundle
  let html = await bundleToSingleHtml(projectDir);

  // Inject local runtime if available
  const runtimePath = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "core",
    "dist",
    "hyperframe.runtime.iife.js",
  );
  if (existsSync(runtimePath)) {
    const runtimeSource = readFileSync(runtimePath, "utf-8");
    html = html.replace(
      /<script[^>]*data-hyperframes-preview-runtime[^>]*src="[^"]*"[^>]*><\/script>/,
      () => `<script data-hyperframes-preview-runtime="1">${runtimeSource}</script>`,
    );
  }

  // 2. Start minimal file server
  const { createServer } = await import("node:http");
  const { getMimeType } = await import("@hyperframes/core/studio-api");

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
    const filePath = resolve(projectDir, decodeURIComponent(url).replace(/^\//, ""));
    const rel = relative(projectDir, filePath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": getMimeType(filePath) });
      res.end(readFileSync(filePath));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.on("error", rejectPort); // register before listen to catch sync bind errors
    server.listen(0, () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      if (!p) rejectPort(new Error("Failed to bind local HTTP server"));
      else resolvePort(p);
    });
  });

  const savedPaths: string[] = [];

  try {
    // 3. Launch headless Chrome
    const browser = await ensureBrowser();
    const puppeteer = await import("puppeteer-core");
    const chromeBrowser = await puppeteer.default.launch({
      headless: true,
      executablePath: browser.executablePath,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--enable-webgl",
        "--use-gl=angle",
        "--use-angle=swiftshader",
      ],
    });

    try {
      const page = await chromeBrowser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });

      await page.goto(`http://127.0.0.1:${port}/`, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });

      // Wait for runtime to initialize and sub-compositions to load
      const timeoutMs = opts.timeout ?? 5000;
      await page
        .waitForFunction(() => !!(window as any).__timelines || !!(window as any).__playerReady, {
          timeout: timeoutMs,
        })
        .catch(() => {});

      // Wait for sub-compositions to be mounted by the runtime
      // (they're fetched and injected asynchronously via data-composition-src)
      await page
        .waitForFunction(
          () => {
            const tls = (window as any).__timelines;
            if (!tls) return false;
            const keys = Object.keys(tls);
            // Wait until at least one sub-composition timeline is registered
            // (not counting "main" or empty registrations)
            return keys.length >= 2 || keys.some((k) => k !== "main");
          },
          { timeout: timeoutMs },
        )
        .catch(() => {});

      // Extra settle time for media, fonts, and animations to initialize
      await new Promise((r) => setTimeout(r, 1500));

      // Get composition duration
      const duration = await page.evaluate(() => {
        const win = window as any;
        const pd = win.__player?.duration;
        if (pd != null) return typeof pd === "function" ? pd() : pd;
        const root = document.querySelector("[data-composition-id][data-duration]");
        if (root) return parseFloat(root.getAttribute("data-duration") ?? "0");
        const tls = win.__timelines;
        if (tls) {
          for (const key in tls) {
            const d = tls[key]?.duration;
            if (d != null) return typeof d === "function" ? d() : d;
          }
        }
        return 0;
      });

      if (duration <= 0 && !opts.at?.length) {
        return [];
      }

      // Calculate seek positions — explicit timestamps or evenly spaced
      const positions: number[] = opts.at?.length
        ? opts.at
        : numFrames === 1
          ? [duration / 2]
          : Array.from({ length: numFrames }, (_, i) => (i / (numFrames - 1)) * duration);

      // Create output directory
      const snapshotDir = join(projectDir, "snapshots");
      mkdirSync(snapshotDir, { recursive: true });

      // Lazily load the engine's <img>-overlay injector. Chrome-headless cannot
      // reliably advance <video>.currentTime mid-seek (the setter is accepted but
      // the decoder ignores it without user activation), so the render pipeline
      // already extracts each frame via FFmpeg and injects it as an <img> sibling
      // over the <video>. We reuse that same primitive here so `snapshot` and
      // `render` behave identically for timed <video data-start> elements.
      let injectVideoFramesBatch:
        | ((page: any, updates: Array<{ videoId: string; dataUri: string }>) => Promise<void>)
        | null = null;
      try {
        const engine = await import("@hyperframes/engine");
        injectVideoFramesBatch = engine.injectVideoFramesBatch as typeof injectVideoFramesBatch;
      } catch {
        // Engine unavailable in this install — snapshot will still run, and
        // compositions without <video data-start> get exactly the old behaviour.
      }

      // Seek and capture each frame
      for (let i = 0; i < positions.length; i++) {
        const time = positions[i]!;

        await page.evaluate((t: number) => {
          const win = window as any;
          if (win.__player?.seek) {
            win.__player.seek(t);
          } else {
            const tls = win.__timelines;
            if (tls) {
              for (const key in tls) {
                if (tls[key]?.seek) {
                  tls[key].pause();
                  tls[key].seek(t);
                }
              }
            }
          }
        }, time);

        // Wait for rendering to settle after seek
        await page.evaluate(
          () =>
            new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
        );
        await new Promise((r) => setTimeout(r, 200));

        // ─── Inject real video frames over any active <video data-start> ───
        // Without this, Chrome-headless renders them blank/first-frame because
        // it silently drops programmatic `currentTime` writes during capture.
        // No-op when the composition has no timed videos (basecamp, linear, etc.)
        if (injectVideoFramesBatch) {
          const active = await page.evaluate((t: number) => {
            return Array.from(document.querySelectorAll("video[data-start]"))
              .map((el) => {
                const v = el as HTMLVideoElement;
                const start = parseFloat(v.dataset.start ?? "0") || 0;
                const rawDuration = parseFloat(v.dataset.duration ?? "");
                const srcDur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
                const duration =
                  Number.isFinite(rawDuration) && rawDuration > 0
                    ? rawDuration
                    : srcDur > 0
                      ? srcDur
                      : Number.POSITIVE_INFINITY;
                const mediaStart =
                  parseFloat(v.dataset.playbackStart ?? v.dataset.mediaStart ?? "0") || 0;
                return {
                  id: v.id,
                  src: v.currentSrc || v.src,
                  start,
                  duration,
                  mediaStart,
                };
              })
              .filter(
                (entry) =>
                  entry.id && entry.src && t >= entry.start && t < entry.start + entry.duration,
              );
          }, time);

          if (active.length > 0) {
            const updates: Array<{ videoId: string; dataUri: string }> = [];
            for (const v of active) {
              // The page-served URL (http://127.0.0.1:PORT/relative/path.mp4)
              // maps 1:1 to <projectDir>/relative/path.mp4. Reconstruct the
              // filesystem path from the URL pathname.
              let filePath: string | null = null;
              try {
                const url = new URL(v.src);
                const candidate = resolve(projectDir, url.pathname.replace(/^\//, ""));
                const rel = relative(projectDir, candidate);
                if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(candidate)) {
                  filePath = candidate;
                }
              } catch {
                /* unresolvable src (e.g. blob:, data:) — skip */
              }
              if (!filePath) continue;
              const relTime = Math.max(0, time - v.start + v.mediaStart);
              const png = await extractVideoFrameToBuffer(filePath, relTime);
              if (!png) continue;
              updates.push({
                videoId: v.id,
                dataUri: `data:image/png;base64,${png.toString("base64")}`,
              });
            }
            if (updates.length > 0) {
              try {
                await injectVideoFramesBatch(page, updates);
              } catch {
                // If injection fails, fall through to the plain screenshot — no worse
                // than pre-fix behaviour.
              }
            }
          }
        }

        const timeLabel = opts.at?.length
          ? `${time.toFixed(1)}s`
          : `${Math.round((time / duration) * 100)}pct`;
        const filename = `frame-${String(i).padStart(2, "0")}-at-${timeLabel}.png`;
        const framePath = join(snapshotDir, filename);

        await page.screenshot({ path: framePath, type: "png" });
        savedPaths.push(`snapshots/${filename}`);
      }
    } finally {
      await chromeBrowser.close();
    }
  } finally {
    server.close();
  }

  return savedPaths;
}

export default defineCommand({
  meta: {
    name: "snapshot",
    description: "Capture key frames from a composition as PNG screenshots for visual verification",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      required: false,
    },
    frames: {
      type: "string",
      description: "Number of evenly-spaced frames to capture (default: 5)",
      default: "5",
    },
    at: {
      type: "string",
      description: "Comma-separated timestamps in seconds (e.g., --at 3.0,10.5,18.0)",
    },
    timeout: {
      type: "string",
      description: "Ms to wait for runtime to initialize (default: 5000)",
      default: "5000",
    },
  },
  async run({ args }) {
    const project = resolveProject(args.dir);
    const frames = parseInt(args.frames as string, 10) || 5;
    const timeout = parseInt(args.timeout as string, 10) || 5000;
    const atTimestamps = args.at
      ? String(args.at)
          .split(",")
          .map((s) => parseFloat(s.trim()))
          .filter((n) => !isNaN(n))
      : undefined;

    const label = atTimestamps
      ? `${atTimestamps.length} frames at [${atTimestamps.map((t) => t.toFixed(1) + "s").join(", ")}]`
      : `${frames} frames`;
    console.log(`${c.accent("◆")}  Capturing ${label} from ${c.accent(project.name)}`);

    try {
      const paths = await captureSnapshots(project.dir, { frames, timeout, at: atTimestamps });

      if (paths.length === 0) {
        console.log(
          `\n${c.error("✗")} Could not determine composition duration — no frames captured`,
        );
        process.exit(1);
      }

      console.log(`\n${c.success("◇")}  ${paths.length} snapshots saved to snapshots/`);
      for (const p of paths) {
        console.log(`   ${p}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n${c.error("✗")} Snapshot failed: ${msg}`);
      process.exit(1);
    }
  },
});
