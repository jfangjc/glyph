type WailsRuntimeWindow = Window & {
    _wails?: { environment?: unknown };
    chrome?: { webview?: { postMessage?: unknown } };
    webkit?: { messageHandlers?: { external?: { postMessage?: unknown } } };
    wails?: { invoke?: unknown };
};

export function canUseNativeRuntime(): boolean {
    const runtimeWindow = window as WailsRuntimeWindow;

    return Boolean(
        runtimeWindow._wails?.environment ||
            runtimeWindow.chrome?.webview?.postMessage ||
            runtimeWindow.webkit?.messageHandlers?.external?.postMessage ||
            runtimeWindow.wails?.invoke,
    );
}

export function canUseWindowPrintRuntime(): boolean {
    return canUseNativeRuntime();
}
