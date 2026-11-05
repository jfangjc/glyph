import { readSiblingPdfPreview } from "../../bridge/documents";
import { canUseNativeRuntime } from "../../platform/runtime";
import { readEditorDom } from "../../editor/editor-dom";
import type { DocumentPreviewBehavior, DocumentPreviewContext } from "../types";

let sourcePath: string | null = null;
let requestId = 0;
let stale = false;
let feedback = "";
let latestContext: DocumentPreviewContext | null = null;
export const latexPreviewBehavior: DocumentPreviewBehavior = {
    kind: "pdf",
    sync(context) {
        latestContext = context;
        const { preview, previewFrame, previewStatus } = readEditorDom();
        if (!context.activeFilePath) {
            requestId++;
            sourcePath = null;
            previewFrame.removeAttribute("src");
            preview.dataset.pdfAvailable = "false";
            preview.dataset.state = "empty";
            previewStatus.textContent = "Save this LaTeX document to compile a PDF. A TeX compiler must be installed.";
            return;
        }
        if (sourcePath !== context.activeFilePath && !context.isSavingDocument) void load(context.activeFilePath);
        else updateFeedback();
    },
    onSaved(context) {
        latestContext = context;
        if (context.activeFilePath) void load(context.activeFilePath, true);
    },
    compile: saveAndCompileLatex,
    deactivate() {
        requestId++;
        sourcePath = null;
        feedback = "";
        latestContext = null;
        const { preview, previewFrame, previewStatus } = readEditorDom();
        previewFrame.removeAttribute("src");
        preview.dataset.pdfAvailable = "false";
        preview.dataset.state = "hidden";
        previewStatus.textContent = "";
    },
};
function updateFeedback(): void {
    const { preview, previewStatus } = readEditorDom();
    if (preview.dataset.state !== "ready") return;
    previewStatus.textContent = [feedback, stale || latestContext?.hasUnsavedChanges ? "PDF is older than the current source. Save & Compile to update." : ""].filter(Boolean).join(" ");
}
async function load(path: string, compile = false): Promise<void> {
    const id = ++requestId;
    const { preview, previewFrame, previewStatus } = readEditorDom();
    const sameSource = sourcePath === path;
    sourcePath = path;
    if (!sameSource) previewFrame.removeAttribute("src");
    preview.dataset.pdfAvailable = String(previewFrame.hasAttribute("src"));
    preview.dataset.state = "loading";
    previewStatus.textContent = compile ? "Source saved. Compiling PDF..." : "Loading PDF preview...";
    if (!canUseNativeRuntime()) {
        preview.dataset.state = "unavailable";
        previewStatus.textContent = "PDF compilation and file previews require the desktop app and a TeX compiler.";
        return;
    }
    try {
        const pdf = await readSiblingPdfPreview(path, compile);
        if (id !== requestId) return;
        previewFrame.src = `${pdf.dataUrl}#toolbar=0&navpanes=0&view=FitH`;
        preview.dataset.pdfAvailable = "true";
        stale = pdf.stale ?? false;
        feedback = pdf.stale === undefined ? "Preview freshness is unavailable from this backend." : "";
        preview.dataset.state = "ready";
        updateFeedback();
    } catch (error) {
        if (id !== requestId) return;
        feedback = `PDF ${compile ? "compilation failed" : "unavailable"}: ${error instanceof Error ? error.message : String(error)}. Check your TeX installation and source, then Save & Compile.`;
        if (previewFrame.hasAttribute("src")) {
            stale = true;
            preview.dataset.state = "ready";
            updateFeedback();
        } else {
            preview.dataset.state = "unavailable";
            previewStatus.textContent = feedback;
        }
    }
}

// A clean document still needs an explicit retry after a compiler failure.
export async function saveAndCompileLatex(saveDocument: () => Promise<boolean>): Promise<void> {
    const before = requestId;
    const session = latestContext?.sessionId;
    const saved = await saveDocument();
    if (saved && latestContext && session === latestContext.sessionId && requestId === before && latestContext.activeFilePath) {
        await load(latestContext.activeFilePath, true);
    }
}
