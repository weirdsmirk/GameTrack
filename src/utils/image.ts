/**
 * Compresses an image file (File object) to a base64 WebP string.
 * Resizes the image to fit within maximum dimensions while maintaining aspect ratio,
 * and applies compression quality. WebP is ~25-35% smaller than JPEG at the
 * same visual quality, so uploads store and load faster. (If a browser can't
 * encode WebP, canvas falls back to PNG and the server accepts that too.)
 */
export async function compressImage(
  file: File,
  maxWidth = 500,
  maxHeight = 667,
  quality = 0.85
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("File is not an image"));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        // Scale calculations
        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          // Fallback to original read if canvas context fails
          resolve(event.target?.result as string);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // Output as lightweight compressed WebP representation
        const dataUrl = canvas.toDataURL("image/webp", quality);
        resolve(dataUrl);
      };
      
      img.onerror = () => {
        reject(new Error("Failed to load image in Image object"));
      };

      img.src = event.target?.result as string;
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file with FileReader"));
    };

    reader.readAsDataURL(file);
  });
}

export const IGDB_COVER_SIZE = "t_cover_big_2x";

/**
 * Warm the browser cache with a set of poster URLs, so the `<img>` tags that
 * render them paint instantly instead of each one starting its own request as
 * it scrolls into view.
 *
 * Two details make the warmed entry actually the one the `<img>` will read:
 * the URL is passed through `upgradeIgdbPosterUrl` exactly as `PosterImage`
 * does it, and `referrerPolicy` is set to `no-referrer` to match — IGDB and
 * Steam reject requests that carry a Referer, so a preloaded image fetched
 * under different rules would not be reused.
 *
 * Never rejects. A dead CDN link resolves as fast as a good one, and every
 * image gets a timeout so one hung socket cannot hold a page gate open.
 */
export function preloadImages(
  urls: (string | null | undefined)[],
  { concurrency = 6, timeoutMs = 8000 }: { concurrency?: number; timeoutMs?: number } = {}
): Promise<void> {
  const list = Array.from(
    new Set(
      urls
        .filter((u): u is string => typeof u === "string" && u.length > 0)
        .map((u) => (upgradeIgdbPosterUrl(u) as string) || u)
    )
  );
  if (list.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let index = 0;
    let live = 0;

    const finishOne = () => {
      live -= 1;
      if (index >= list.length && live <= 0) resolve();
      else pump();
    };

    const loadOne = (url: string) => {
      const img = new Image();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        finishOne();
      };
      // Belt and braces: `onload`/`onerror` normally settle this, but a
      // connection that stalls without erroring would otherwise hang the gate.
      const timer = setTimeout(done, timeoutMs);
      img.onload = () => {
        clearTimeout(timer);
        done();
      };
      img.onerror = () => {
        clearTimeout(timer);
        done();
      };
      img.referrerPolicy = "no-referrer";
      img.src = url;
    };

    const pump = () => {
      while (live < concurrency && index < list.length) {
        const url = list[index];
        index += 1;
        if (url === undefined) continue;
        live += 1;
        loadOne(url);
      }
      if (index >= list.length && live <= 0) resolve();
    };

    pump();
  });
}

/**
 * Upgrade a stored IGDB poster URL to the highest-quality cover preset in
 * the modern WebP format. Mirrors the server-side helper so every render
 * path loads the fastest best-quality variant even if the row was written
 * before the format switch.
 */
export function upgradeIgdbPosterUrl(url: string | null | undefined): string | null | undefined {
  if (!url || typeof url !== "string") return url;
  if (!url.includes("images.igdb.com")) return url;
  const upgradedSize = url.replace(
    /\/t_(cover_small_2x|cover_small|cover_big|thumb_2x|thumb|micro_2x|micro)\//,
    `/${IGDB_COVER_SIZE}/`
  );
  return upgradedSize.replace(/\.(jpe?g|png)(\?.*)?$/, ".webp$2");
}

/**
 * Handles image file uploads, attempting compression and falling back to original base64 on error.
 */
export async function uploadAndCompressImage(file: File): Promise<string> {
  try {
    return await compressImage(file);
  } catch (err) {
    console.error("Failed to compress uploaded image, falling back to original:", err);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("FileReader did not return a string"));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}

/**
 * Compresses an image and uploads it to the server, which stores it on disk
 * in the project's data/posters directory. Returns the served poster URL.
 */
export async function uploadPoster(file: File): Promise<string> {
  const dataUrl = await uploadAndCompressImage(file);
  const res = await fetch("/api/upload-poster", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    let message = "Failed to upload poster";
    try {
      const err = await res.json();
      if (err?.error) message = err.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  const data = await res.json();
  return data.url as string;
}
