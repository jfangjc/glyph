import { readImage } from "../../bridge/documents";
import { documentState } from "../../documents/document-state";
import { normalizeExternalImageUrl } from "./inline";
import { readPendingImageObjectUrl } from "./pending-images";

type ImageCacheEntry = {
    promise: Promise<string | null>;
    dataUrl: string | null;
    bytes: number;
    accessedAt: number;
};

const maxCacheEntries = 32;
const maxCacheBytes = 64 * 1024 * 1024;
const localImageCache = new Map<string, ImageCacheEntry>();
let cacheSessionId = -1;
let cacheBasePath: string | null = null;

export function hydrateMarkdownImagePreviews(content: HTMLElement, baseFilePath: string | null): void {
    syncCacheScope(baseFilePath);
    const previews = Array.from(content.querySelectorAll<HTMLElement>(".markdown-image-preview"));

    for (const preview of previews) {
        const source = preview.dataset.imageSource;
        if (!source) {
            showImageError(preview, "Image source is empty");
            continue;
        }

        const cacheKey = `${documentState.sessionId}\u0000${baseFilePath ?? ""}\u0000${source}`;
        if (preview.dataset.resolvedFor === cacheKey) {
            continue;
        }

        preview.dataset.resolvedFor = cacheKey;
        setImagePreviewState(preview, "loading");
        preview.setAttribute("aria-busy", "true");
        preview.replaceChildren();

        const pendingUrl = readPendingImageObjectUrl(source);
        if (pendingUrl) {
            setImagePreviewSource(preview, pendingUrl, cacheKey, "Pending image");
            continue;
        }

        const externalImageUrl = normalizeExternalImageUrl(source);
        if (externalImageUrl) {
            const origin = externalImageUrl.startsWith("data:")
                ? "Embedded image"
                : new URL(externalImageUrl).origin;
            setImagePreviewSource(preview, externalImageUrl, cacheKey, origin);
            continue;
        }

        void resolveLocalImageSource(source, baseFilePath, cacheKey).then((dataUrl) => {
            if (preview.dataset.resolvedFor !== cacheKey) {
                return;
            }
            if (!dataUrl) {
                showImageError(preview, "Local image unavailable", cacheKey);
                return;
            }
            setImagePreviewSource(preview, dataUrl, cacheKey, "Local image");
        });
    }
}

export function invalidateMarkdownImageCache(): void {
    localImageCache.clear();
}

function setImagePreviewSource(
    preview: HTMLElement,
    source: string,
    cacheKey: string,
    originLabel: string,
): void {
    if (preview.dataset.resolvedFor !== cacheKey) {
        return;
    }

    const image = document.createElement("img");
    image.alt = preview.dataset.imageAlt ?? "";
    image.title = preview.dataset.imageTitle ?? "";
    image.decoding = "async";
    image.draggable = false;
    image.loading = "lazy";
    if (/^https?:/i.test(source)) image.referrerPolicy = "no-referrer";
    image.dataset.imageOrigin = originLabel;
    image.addEventListener("load", () => {
        if (preview.dataset.resolvedFor === cacheKey) {
            preview.style.setProperty("--markdown-image-natural-width", `${image.naturalWidth}px`);
            setImagePreviewState(preview, "ready");
            preview.setAttribute("aria-busy", "false");
        }
    });
    image.addEventListener("error", () => {
        if (preview.dataset.resolvedFor === cacheKey) {
            showImageError(preview, `${originLabel} unavailable`, cacheKey);
        }
    });

    image.src = source;
    preview.replaceChildren(image);

    if (image.complete && image.naturalWidth > 0) {
        preview.style.setProperty("--markdown-image-natural-width", `${image.naturalWidth}px`);
        setImagePreviewState(preview, "ready");
        preview.setAttribute("aria-busy", "false");
    }
}

function showImageError(preview: HTMLElement, message: string, cacheKey?: string): void {
    setImagePreviewState(preview, "error");
    preview.setAttribute("aria-busy", "false");
    const label = document.createElement("span");
    label.className = "markdown-image-error-label";
    const title = document.createElement("strong");
    title.textContent = preview.dataset.imageAlt || "Image unavailable";
    const detail = document.createElement("small");
    detail.className = "markdown-image-error-detail";
    detail.textContent = `${message}: ${abbreviateImageSource(preview.dataset.imageSource ?? "")}`;
    label.append(title, detail);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "markdown-image-retry";
    retry.textContent = "Retry";
    retry.setAttribute("aria-label", `Retry loading ${preview.dataset.imageAlt || "image"}`);
    retry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (cacheKey) {
            localImageCache.delete(cacheKey);
        }
        delete preview.dataset.resolvedFor;
        const content = preview.closest<HTMLElement>(".block-content");
        if (content) {
            hydrateMarkdownImagePreviews(content, cacheBasePath);
        }
    });
    preview.replaceChildren(label, retry);
}

function setImagePreviewState(preview: HTMLElement, state: "loading" | "ready" | "error"): void {
    preview.dataset.state = state;
    const token = preview.closest<HTMLElement>(".markdown-image-token");
    if (token) token.dataset.imageState = state;
}

function abbreviateImageSource(source: string): string {
    if (source === "") return "no source";
    return source.length <= 96 ? source : `${source.slice(0, 93)}…`;
}

function resolveLocalImageSource(
    source: string,
    baseFilePath: string | null,
    cacheKey: string,
): Promise<string | null> {
    const cached = localImageCache.get(cacheKey);
    if (cached) {
        cached.accessedAt = performance.now();
        return cached.promise;
    }

    const entry: ImageCacheEntry = {
        dataUrl: null,
        bytes: 0,
        accessedAt: performance.now(),
        promise: Promise.resolve(null),
    };
    entry.promise = readImage(source, baseFilePath)
        .then((image) => {
            entry.dataUrl = image.dataUrl;
            entry.bytes = Math.ceil(image.dataUrl.length * 0.75);
            entry.accessedAt = performance.now();
            evictImageCache();
            return image.dataUrl;
        })
        .catch((error) => {
            localImageCache.delete(cacheKey);
            console.error("Failed to load local image:", error);
            return null;
        });

    localImageCache.set(cacheKey, entry);
    evictImageCache();
    return entry.promise;
}

function syncCacheScope(baseFilePath: string | null): void {
    if (cacheSessionId === documentState.sessionId && cacheBasePath === baseFilePath) {
        return;
    }
    localImageCache.clear();
    cacheSessionId = documentState.sessionId;
    cacheBasePath = baseFilePath;
}

function evictImageCache(): void {
    let bytes = Array.from(localImageCache.values()).reduce((sum, entry) => sum + entry.bytes, 0);
    if (localImageCache.size <= maxCacheEntries && bytes <= maxCacheBytes) {
        return;
    }

    const oldest = Array.from(localImageCache.entries())
        .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key, entry] of oldest) {
        if (localImageCache.size <= maxCacheEntries && bytes <= maxCacheBytes) {
            break;
        }
        localImageCache.delete(key);
        bytes -= entry.bytes;
    }
}
