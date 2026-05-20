type EditorEventTargets = {
    surface: HTMLElement;
    editor: HTMLElement;
    title: HTMLInputElement;
};

type EditorEventHandlers = {
    onSurfaceMouseDown: (event: MouseEvent) => void;
    onSurfaceMouseMove: (event: MouseEvent) => void;
    onSurfaceMouseLeave: (event: MouseEvent) => void;
    onSurfaceMouseOver: (event: MouseEvent) => void;
    onSurfaceMouseOut: (event: MouseEvent) => void;
    onDocumentMouseMove: (event: MouseEvent) => void;
    onDocumentMouseUp: (event: MouseEvent) => void;
    onEditorKeydown: (event: KeyboardEvent) => void;
    onEditorMouseDown: (event: MouseEvent) => void;
    onEditorBeforeInput: (event: InputEvent) => void;
    onEditorInput: (event: Event) => void;
    onEditorCopy: (event: ClipboardEvent) => void;
    onEditorCut: (event: ClipboardEvent) => void;
    onEditorPaste: (event: ClipboardEvent) => void;
    onEditorChange: (event: Event) => void;
    onEditorClick: (event: MouseEvent) => void;
    onEditorCompositionStart: (event: CompositionEvent) => void;
    onEditorCompositionEnd: (event: CompositionEvent) => void;
    onTitleInput: (event: Event) => void;
    onTitleFocus: (event: FocusEvent) => void;
    onSelectionChange: (event: Event) => void;
    onWindowKeydown: (event: KeyboardEvent) => void;
    onWindowKeyup: (event: KeyboardEvent) => void;
    onWindowBlur: (event: FocusEvent) => void;
    onDocumentStateChanged: (event: Event) => void;
};

export function installEditorEventListeners(
    targets: EditorEventTargets,
    handlers: EditorEventHandlers,
    documentStateChangedEvent: string,
): void {
    targets.surface.addEventListener("mousedown", handlers.onSurfaceMouseDown);
    targets.surface.addEventListener("mousemove", handlers.onSurfaceMouseMove);
    targets.surface.addEventListener("mouseleave", handlers.onSurfaceMouseLeave);
    targets.surface.addEventListener("mouseover", handlers.onSurfaceMouseOver);
    targets.surface.addEventListener("mouseout", handlers.onSurfaceMouseOut);
    document.addEventListener("mousemove", handlers.onDocumentMouseMove);
    document.addEventListener("mouseup", handlers.onDocumentMouseUp);
    targets.editor.addEventListener("keydown", handlers.onEditorKeydown);
    targets.editor.addEventListener("mousedown", handlers.onEditorMouseDown);
    targets.editor.addEventListener("beforeinput", handlers.onEditorBeforeInput);
    targets.editor.addEventListener("input", handlers.onEditorInput);
    targets.editor.addEventListener("copy", handlers.onEditorCopy);
    targets.editor.addEventListener("cut", handlers.onEditorCut);
    targets.editor.addEventListener("paste", handlers.onEditorPaste);
    targets.editor.addEventListener("change", handlers.onEditorChange);
    targets.editor.addEventListener("click", handlers.onEditorClick);
    targets.editor.addEventListener("compositionstart", handlers.onEditorCompositionStart);
    targets.editor.addEventListener("compositionend", handlers.onEditorCompositionEnd);
    targets.title.addEventListener("input", handlers.onTitleInput);
    targets.title.addEventListener("focus", handlers.onTitleFocus);
    document.addEventListener("selectionchange", handlers.onSelectionChange);
    window.addEventListener("keydown", handlers.onWindowKeydown);
    window.addEventListener("keyup", handlers.onWindowKeyup);
    window.addEventListener("blur", handlers.onWindowBlur);
    window.addEventListener(documentStateChangedEvent, handlers.onDocumentStateChanged);
}
