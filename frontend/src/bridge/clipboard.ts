import { Clipboard } from "@wailsio/runtime";
import type { ClipboardPayload, ClipboardReadResult } from "../formats/types";

export const maxRichClipboardHtmlLength = 5 * 1024 * 1024;
const supportedPastedImageMimeTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export function isSupportedPastedImage(file: File): boolean {
    return supportedPastedImageMimeTypes.has(file.type.toLowerCase());
}

export async function writeNativeClipboard(
    payload: ClipboardPayload,
    includeMarkdown: boolean,
): Promise<void> {
    if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
        try {
            const clipboardData: Record<string, Blob> = {
                "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
                "text/html": new Blob([payload.html], { type: "text/html" }),
            };
            if (includeMarkdown && (typeof ClipboardItem.supports !== "function" || ClipboardItem.supports("text/markdown"))) {
                clipboardData["text/markdown"] = new Blob([payload.markdown], { type: "text/markdown" });
            }
            await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
            return;
        } catch {
            // Wails clipboard is the permission-safe desktop fallback.
        }
    }
    await Clipboard.SetText(payload.markdown);
}

export async function readNativeRichClipboard(convertHtml: (html: string) => string): Promise<ClipboardReadResult> {
    if (navigator.clipboard?.read) {
        try {
            const items = await navigator.clipboard.read();
            const item = items[0];
            if (item) {
                const imageTypes = item.types.filter((type) => supportedPastedImageMimeTypes.has(type.toLowerCase()));
                const hasMarkdown = item.types.includes("text/markdown");
                const html = imageTypes.length > 0 && item.types.includes("text/html")
                    ? await (await item.getType("text/html")).text()
                    : "";
                if (
                    imageTypes.length > 0 &&
                    !hasMarkdown &&
                    (!html || !hasMeaningfulNonImageClipboardHtml(html))
                ) {
                    const files = await Promise.all(imageTypes.map(async (type, index) => {
                        const blob = await item.getType(type);
                        return new File([blob], `clipboard-image-${index + 1}.${extensionForImageMimeType(type)}`, { type });
                    }));
                    return { kind: "images", files };
                }
            }
            for (const type of ["text/markdown", "text/html", "text/plain"] as const) {
                if (!item?.types.includes(type)) continue;
                const value = await (await item.getType(type)).text();
                if (type === "text/html" && value.length > maxRichClipboardHtmlLength) {
                    return {
                        kind: "plain",
                        value: new DOMParser().parseFromString(value, "text/html").body.textContent?.replace(/\r\n?/g, "\n") ?? "",
                        warning: "Rich clipboard content exceeded 5 MB and was pasted as plain text.",
                    };
                }
                return {
                    kind: type === "text/markdown" ? "markdown" : type === "text/html" ? "html" : "plain",
                    value: type === "text/html"
                        ? convertHtml(value)
                        : value.replace(/\r\n?/g, "\n"),
                };
            }
        } catch {
            // Wails clipboard is the permission-safe desktop fallback.
        }
    }
    return { kind: "plain", value: (await Clipboard.Text()).replace(/\r\n?/g, "\n") };
}

export async function readNativePlainClipboard(): Promise<string> {
    if (navigator.clipboard?.readText) {
        try {
            return (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n");
        } catch {
            // Wails clipboard is the permission-safe desktop fallback.
        }
    }
    return (await Clipboard.Text()).replace(/\r\n?/g, "\n");
}

export function readClipboardImages(dataTransfer: DataTransfer | null | undefined): File[] {
    if (!dataTransfer) {
        return [];
    }

    const fromItems = Array.from(dataTransfer.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file && isSupportedPastedImage(file)));
    return fromItems.length > 0
        ? fromItems
        : Array.from(dataTransfer.files).filter(isSupportedPastedImage);
}

export function hasMeaningfulNonImageClipboardHtml(html: string): boolean {
    if (!html) {
        return false;
    }
    const clipboardDocument = new DOMParser().parseFromString(html, "text/html");
    for (const element of Array.from(clipboardDocument.body.querySelectorAll("script, style, img"))) {
        element.remove();
    }
    if (clipboardDocument.body.textContent?.trim()) {
        return true;
    }
    return Boolean(clipboardDocument.body.querySelector(
        "br, hr, table, ul, ol, pre, blockquote, input, textarea, select, video, audio, canvas, svg",
    ));
}

export function extensionForImageMimeType(mimeType: string): string {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

