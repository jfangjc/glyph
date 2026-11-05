export type PdfPreviewView = "source" | "split" | "pdf";

export function resolvePreviewView(preferred: PdfPreviewView, viewportWidth: number): PdfPreviewView {
    return preferred === "split" && viewportWidth <= 700 ? "source" : preferred;
}
