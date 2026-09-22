import { readSiblingPdfPreview } from "../../bridge/documents";
import { canUseNativeRuntime } from "../../platform/runtime";
import { documentState } from "../../documents/document-state";
import { readEditorDom } from "../../editor/editor-dom";
import type { DocumentPreviewBehavior } from "../types";

let sourcePath: string | null = null;
let requestId = 0;
let stale = false;
let feedback = "";
export const latexPreviewBehavior: DocumentPreviewBehavior = {
    sync(context) {
        const { latexPreview, latexFrame, latexStatus } = readEditorDom();
        if (!context.activeFilePath) {
            requestId++;
            sourcePath = null;
            latexFrame.removeAttribute("src");
            latexPreview.dataset.pdfAvailable = "false";
            latexPreview.dataset.state = "empty";
            latexStatus.textContent = "Save this LaTeX document to compile a PDF. A TeX compiler must be installed.";
            return;
        }
        if (sourcePath !== context.activeFilePath) void load(context.activeFilePath);
        else updateFeedback();
    },
    deactivate() {
        requestId++;
        sourcePath = null;
        feedback = "";
        const { latexPreview, latexFrame, latexStatus } = readEditorDom();
        latexFrame.removeAttribute("src");
        latexPreview.dataset.pdfAvailable = "false";
        latexPreview.dataset.state = "hidden";
        latexStatus.textContent = "";
    },
};
window.addEventListener("glyph:document-saved", () => {
    if (documentState.activeFormatId === "latex" && documentState.activeFilePath) void load(documentState.activeFilePath, true);
});
function updateFeedback(): void {
    const { latexPreview, latexStatus } = readEditorDom();
    if (latexPreview.dataset.state !== "ready") return;
    latexStatus.textContent = [feedback, stale || documentState.hasUnsavedChanges ? "PDF is older than the current source. Save & Compile to update." : ""].filter(Boolean).join(" ");
}
async function load(path: string, compile = false): Promise<void> {
    const id = ++requestId;
    const { latexPreview, latexFrame, latexStatus } = readEditorDom();
    const sameSource = sourcePath === path;
    sourcePath = path;
    if (!sameSource) latexFrame.removeAttribute("src");
    latexPreview.dataset.pdfAvailable = String(latexFrame.hasAttribute("src"));
    latexPreview.dataset.state = "loading";
    latexStatus.textContent = compile ? "Source saved. Compiling PDF..." : "Loading PDF preview...";
    if (!canUseNativeRuntime()) {
        latexPreview.dataset.state = "unavailable";
        latexStatus.textContent = "PDF compilation and file previews require the desktop app and a TeX compiler.";
        return;
    }
    try {
        const pdf = await readSiblingPdfPreview(path, compile);
        if (id !== requestId) return;
        latexFrame.src = `${pdf.dataUrl}#toolbar=0&navpanes=0&view=FitH`;
        latexPreview.dataset.pdfAvailable = "true";
        stale = pdf.stale ?? false;
        feedback = pdf.stale === undefined ? "Preview freshness is unavailable from this backend." : "";
        latexPreview.dataset.state = "ready";
        updateFeedback();
    } catch (error) {
        if (id !== requestId) return;
        feedback = `PDF ${compile ? "compilation failed" : "unavailable"}: ${error instanceof Error ? error.message : String(error)}. Check your TeX installation and source, then Save & Compile.`;
        if (latexFrame.hasAttribute("src")) {
            stale = true;
            latexPreview.dataset.state = "ready";
            updateFeedback();
        } else {
            latexPreview.dataset.state = "unavailable";
            latexStatus.textContent = feedback;
        }
    }
}

// A clean document still needs an explicit retry after a compiler failure.
export async function saveAndCompileLatex(saveDocument: () => Promise<boolean>): Promise<void> {
    const before = requestId;
    const session = documentState.sessionId;
    const saved = await saveDocument();
    if (saved && session === documentState.sessionId && requestId === before && documentState.activeFilePath) {
        await load(documentState.activeFilePath, true);
    }
}
