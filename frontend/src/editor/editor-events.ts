type EditorEventTargets = {
    surface: HTMLElement;
    editor: HTMLElement;
    title: HTMLInputElement;
};

type EditorEventHandlers = {
    onSurfaceMouseDown: (event: PointerEvent) => void;
    onSurfaceMouseMove: (event: PointerEvent) => void;
    onSurfaceMouseLeave: (event: PointerEvent) => void;
    onSurfaceMouseOver: (event: MouseEvent) => void;
    onSurfaceMouseOut: (event: MouseEvent) => void;
    onDocumentMouseMove: (event: PointerEvent) => void;
    onDocumentMouseUp: (event: PointerEvent) => void;
    onEditorKeydown: (event: KeyboardEvent) => void;
    onEditorMouseDown: (event: PointerEvent) => void;
    onEditorBeforeInput: (event: InputEvent) => void;
    onEditorInput: (event: Event) => void;
    onEditorCopy: (event: ClipboardEvent) => void;
    onEditorCut: (event: ClipboardEvent) => void;
    onEditorPaste: (event: ClipboardEvent) => void;
    onEditorDragStart: (event: DragEvent) => void;
    onEditorDragEnd: (event: DragEvent) => void;
    onEditorDragOver: (event: DragEvent) => void;
    onEditorDrop: (event: DragEvent) => void;
    onEditorChange: (event: Event) => void;
    onEditorClick: (event: MouseEvent) => void;
    onEditorCompositionStart: (event: CompositionEvent) => void;
    onEditorCompositionEnd: (event: CompositionEvent) => void;
    onEditorFocusOut: (event: FocusEvent) => void;
    onTitleBeforeInput: (event: InputEvent) => void;
    onTitleKeydown: (event: KeyboardEvent) => void;
    onTitleInput: (event: Event) => void;
    onTitleFocus: (event: FocusEvent) => void;
    onTitleBlur: (event: FocusEvent) => void;
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
    targets.surface.addEventListener("pointerdown", handlers.onSurfaceMouseDown);
    targets.surface.addEventListener("pointermove", handlers.onSurfaceMouseMove);
    targets.surface.addEventListener("pointerleave", handlers.onSurfaceMouseLeave);
    targets.surface.addEventListener("mouseover", handlers.onSurfaceMouseOver);
    targets.surface.addEventListener("mouseout", handlers.onSurfaceMouseOut);
    document.addEventListener("pointermove", handlers.onDocumentMouseMove);
    document.addEventListener("pointerup", handlers.onDocumentMouseUp);
    document.addEventListener("pointercancel", handlers.onDocumentMouseUp);
    targets.editor.addEventListener("keydown", handlers.onEditorKeydown);
    targets.editor.addEventListener("pointerdown", handlers.onEditorMouseDown);
    targets.editor.addEventListener("beforeinput", handlers.onEditorBeforeInput);
    targets.editor.addEventListener("input", handlers.onEditorInput);
    targets.editor.addEventListener("copy", handlers.onEditorCopy);
    targets.editor.addEventListener("cut", handlers.onEditorCut);
    targets.editor.addEventListener("paste", handlers.onEditorPaste);
    targets.editor.addEventListener("dragstart", handlers.onEditorDragStart);
    targets.editor.addEventListener("dragend", handlers.onEditorDragEnd);
    targets.editor.addEventListener("dragover", handlers.onEditorDragOver);
    targets.editor.addEventListener("drop", handlers.onEditorDrop);
    targets.editor.addEventListener("change", handlers.onEditorChange);
    targets.editor.addEventListener("click", handlers.onEditorClick);
    targets.editor.addEventListener("compositionstart", handlers.onEditorCompositionStart);
    targets.editor.addEventListener("compositionend", handlers.onEditorCompositionEnd);
    targets.editor.addEventListener("focusout", handlers.onEditorFocusOut);
    targets.title.addEventListener("beforeinput", handlers.onTitleBeforeInput);
    targets.title.addEventListener("keydown", handlers.onTitleKeydown);
    targets.title.addEventListener("input", handlers.onTitleInput);
    targets.title.addEventListener("focus", handlers.onTitleFocus);
    targets.title.addEventListener("blur", handlers.onTitleBlur);
    document.addEventListener("selectionchange", handlers.onSelectionChange);
    window.addEventListener("keydown", handlers.onWindowKeydown);
    window.addEventListener("keyup", handlers.onWindowKeyup);
    window.addEventListener("blur", handlers.onWindowBlur);
    window.addEventListener(documentStateChangedEvent, handlers.onDocumentStateChanged);
}
