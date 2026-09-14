import { isSupportedPastedImage } from "../../bridge/clipboard";
import { savePastedImage } from "../../bridge/documents";
import { documentState } from "../../documents/document-state";
import { dispatch, getEditorState, readRetainedSourceDocuments, rewriteSourceHistory } from "../../editor/core/store";

const maxImageBytes = 20 * 1024 * 1024;
const maxPendingBytes = 100 * 1024 * 1024;
const maxPendingImages = 20;
const pendingScheme = "glyph-pending-image://";

type PendingImage = {
    id: string;
    sessionId: number;
    file: File;
    objectUrl: string;
    source: string;
    persistedRelativePath: string | null;
};

export type StagedPendingImages = {
    sources: Array<{ source: string; file: File; inputIndex: number }>;
    rejected: string[];
};

export type PreparedPendingImages = {
    content: string;
    replacements: Array<{ source: string; relativePath: string }>;
};

let registrySessionId = -1;
const pendingImages = new Map<string, PendingImage>();

export function stagePendingImages(files: File[]): StagedPendingImages {
    ensureCurrentSession();
    const accepted: Array<{ source: string; file: File; inputIndex: number }> = [];
    const rejected: string[] = [];
    let totalBytes = Array.from(pendingImages.values()).reduce((sum, item) => sum + item.file.size, 0);

    for (const [inputIndex, file] of files.entries()) {
        if (!isSupportedPastedImage(file)) {
            rejected.push(`${file.name || "Image"} has an unsupported image type.`);
            continue;
        }
        if (file.size > maxImageBytes) {
            rejected.push(`${file.name || "Image"} is larger than 20 MB.`);
            continue;
        }
        if (pendingImages.size >= maxPendingImages || totalBytes + file.size > maxPendingBytes) {
            rejected.push("The document's pending image limit has been reached.");
            continue;
        }

        const id = createPendingImageId();
        const source = `${pendingScheme}${id}`;
        let objectUrl: string;
        try {
            objectUrl = URL.createObjectURL(file);
        } catch {
            rejected.push(`${file.name || "Image"} could not be prepared for preview.`);
            continue;
        }
        const item: PendingImage = {
            id,
            sessionId: documentState.sessionId,
            file,
            objectUrl,
            source,
            persistedRelativePath: null,
        };
        pendingImages.set(id, item);
        totalBytes += file.size;
        accepted.push({ source, file, inputIndex });
    }

    return { sources: accepted, rejected };
}

export function readPendingImageObjectUrl(source: string): string | null {
    ensureCurrentSession();
    const item = readPendingImage(source);
    return item?.sessionId === documentState.sessionId ? item.objectUrl : null;
}

export function hasPendingImagesInContent(content: string): boolean {
    ensureCurrentSession();
    return Array.from(pendingImages.values()).some((item) => content.includes(item.source));
}

export async function preparePendingImagesForSave(
    path: string,
    content: string,
    sessionId: number,
): Promise<PreparedPendingImages> {
    ensureCurrentSession();
    if (sessionId !== documentState.sessionId) {
        throw new Error("The document changed before pending images could be saved.");
    }

    const referenced = Array.from(pendingImages.values()).filter((item) => content.includes(item.source));
    const replacements: PreparedPendingImages["replacements"] = [];
    let preparedContent = content;

    for (const item of referenced) {
        if (sessionId !== documentState.sessionId) {
            throw new Error("The document changed before pending images could be saved.");
        }
        if (!item.persistedRelativePath) {
            const dataUrl = await readFileAsDataUrl(item.file);
            if (sessionId !== documentState.sessionId) {
                throw new Error("The document changed before a pending image could be written.");
            }
            const saved = await savePastedImage(path, dataUrl, item.file.name, item.file.type);
            if (sessionId !== documentState.sessionId) {
                throw new Error(
                    `${item.file.name || "An image"} may have been saved as an orphan because the document changed.`,
                );
            }
            item.persistedRelativePath = saved.relativePath;
        }
        replacements.push({ source: item.source, relativePath: item.persistedRelativePath });
        preparedContent = preparedContent.split(item.source).join(item.persistedRelativePath);
    }

    return { content: preparedContent, replacements };
}

export function finalizePendingImages(
    prepared: PreparedPendingImages,
    sessionId: number,
): void {
    if (sessionId !== documentState.sessionId || prepared.replacements.length === 0) {
        return;
    }

    const state = getEditorState();
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (const replacement of prepared.replacements) {
        let from = state.doc.indexOf(replacement.source);
        while (from >= 0) {
            changes.push({
                from,
                to: from + replacement.source.length,
                insert: replacement.relativePath,
            });
            from = state.doc.indexOf(replacement.source, from + replacement.source.length);
        }
    }
    if (changes.length > 0) {
        dispatch({
            changes,
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
    }
    rewriteSourceHistory(prepared.replacements.map((replacement) => ({
        source: replacement.source,
        replacement: replacement.relativePath,
    })));

    for (const replacement of prepared.replacements) {
        const item = readPendingImage(replacement.source);
        if (item) {
            URL.revokeObjectURL(item.objectUrl);
            pendingImages.delete(item.id);
        }
    }
}

export function resetPendingImagesForSession(): void {
    clearPendingImages();
    registrySessionId = documentState.sessionId;
}

export function pruneUnreferencedPendingImages(): void {
    ensureCurrentSession();
    if (pendingImages.size === 0) return;
    const retainedDocuments = readRetainedSourceDocuments();
    for (const item of pendingImages.values()) {
        if (retainedDocuments.some((document) => document.includes(item.source))) {
            continue;
        }
        URL.revokeObjectURL(item.objectUrl);
        pendingImages.delete(item.id);
    }
}

export async function persistImageFiles(
    path: string,
    files: File[],
    sessionId: number,
): Promise<Array<{ relativePath: string; file: File }>> {
    const saved: Array<{ relativePath: string; file: File }> = [];
    for (const file of files) {
        if (sessionId !== documentState.sessionId) {
            break;
        }
        if (!isSupportedPastedImage(file) || file.size > maxImageBytes) {
            throw new Error(`${file.name || "Image"} is unsupported or larger than 20 MB.`);
        }
        const dataUrl = await readFileAsDataUrl(file);
        if (sessionId !== documentState.sessionId) {
            break;
        }
        const result = await savePastedImage(path, dataUrl, file.name, file.type);
        if (sessionId !== documentState.sessionId) {
            throw new Error(
                `${file.name || "An image"} may have been saved as an orphan because the document changed.`,
            );
        }
        saved.push({ relativePath: result.relativePath, file });
    }
    return saved;
}

function ensureCurrentSession(): void {
    if (registrySessionId === documentState.sessionId) {
        return;
    }
    clearPendingImages();
    registrySessionId = documentState.sessionId;
}

function clearPendingImages(): void {
    for (const item of pendingImages.values()) {
        URL.revokeObjectURL(item.objectUrl);
    }
    pendingImages.clear();
}

function readPendingImage(source: string): PendingImage | null {
    if (!source.startsWith(pendingScheme)) {
        return null;
    }
    return pendingImages.get(source.slice(pendingScheme.length)) ?? null;
}

function createPendingImageId(): string {
    return typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("Unable to read image data."));
            }
        });
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image data.")));
        reader.readAsDataURL(file);
    });
}
