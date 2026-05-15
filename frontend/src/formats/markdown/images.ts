import { readImage } from "../../bridge/documents";
import { normalizeExternalImageUrl } from "./inline";

const localImageCache = new Map<string, Promise<string | null>>();

export function hydrateMarkdownImagePreviews(content: HTMLElement, baseFilePath: string | null): void {
    const previews = Array.from(content.querySelectorAll<HTMLElement>(".markdown-image-preview"));

    for (const preview of previews) {
        const source = preview.dataset.imageSource;
        if (!source) {
            continue;
        }

        const cacheKey = `${baseFilePath ?? ""}\u0000${source}`;
        if (preview.dataset.resolvedFor === cacheKey) {
            continue;
        }

        preview.dataset.resolvedFor = cacheKey;
        preview.dataset.state = "loading";
        preview.replaceChildren();

        const externalImageUrl = normalizeExternalImageUrl(source);
        if (externalImageUrl) {
            setImagePreviewSource(preview, externalImageUrl, cacheKey);
            continue;
        }

        void resolveLocalImageSource(source, baseFilePath).then((dataUrl) => {
            if (preview.dataset.resolvedFor !== cacheKey) {
                return;
            }

            if (!dataUrl) {
                preview.dataset.state = "error";
                preview.replaceChildren();
                return;
            }

            setImagePreviewSource(preview, dataUrl, cacheKey);
        });
    }
}

function setImagePreviewSource(preview: HTMLElement, source: string, cacheKey: string): void {
    if (preview.dataset.resolvedFor !== cacheKey) {
        return;
    }

    const image = document.createElement("img");
    image.alt = preview.dataset.imageAlt ?? "";
    image.decoding = "async";
    image.draggable = false;
    image.loading = "lazy";
    image.addEventListener("load", () => {
        if (preview.dataset.resolvedFor === cacheKey) {
            preview.dataset.state = "ready";
        }
    });
    image.addEventListener("error", () => {
        if (preview.dataset.resolvedFor === cacheKey) {
            preview.dataset.state = "error";
            preview.replaceChildren();
        }
    });

    image.src = source;
    preview.replaceChildren(image);

    if (image.complete && image.naturalWidth > 0) {
        preview.dataset.state = "ready";
    }
}

function resolveLocalImageSource(source: string, baseFilePath: string | null): Promise<string | null> {
    const cacheKey = `${baseFilePath ?? ""}\u0000${source}`;
    const cached = localImageCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const request = readImage(source, baseFilePath)
        .then((image) => image.dataUrl)
        .catch((error) => {
            localImageCache.delete(cacheKey);
            console.error("Failed to load local image:", error);
            return null;
        });

    localImageCache.set(cacheKey, request);
    return request;
}
