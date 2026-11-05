export type HostPlatform = "windows" | "mac" | "linux";

export function readHostPlatform(): HostPlatform | null {
    const nativeOS = typeof window === "undefined" ? undefined
        : (window as Window & { _wails?: { environment?: { OS?: string } } })._wails?.environment?.OS;
    if (nativeOS === "windows" || nativeOS === "linux") return nativeOS;
    if (nativeOS === "darwin") return "mac";

    if (typeof navigator === "undefined") return null;
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent;
    if (platform.startsWith("win") || userAgent.includes("Windows")) return "windows";
    if (platform.includes("linux") || userAgent.includes("Linux")) return "linux";
    if (platform.includes("mac") || userAgent.includes("Mac OS")) return "mac";
    return null;
}
