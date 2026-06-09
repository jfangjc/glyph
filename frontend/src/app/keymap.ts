export type AppMenuCommand =
    | "file:new"
    | "file:open"
    | "file:open-directory"
    | "file:save"
    | "file:save-as"
    | "file:export"
    | "edit:undo"
    | "edit:redo"
    | "edit:cut"
    | "edit:copy"
    | "edit:paste"
    | "edit:select-all"
    | "edit:find"
    | "edit:replace"
    | "view:toggle-file-tree"
    | "view:zoom-in"
    | "view:zoom-out"
    | "view:zoom-reset"
    | "help:about";

export type AppCommand = AppMenuCommand | "format:bold" | "format:italic";
export type ShortcutScope = "global" | "editor" | "title" | "markdown" | "menu";
export type ShortcutAvailability = "always" | "native-file-system";
export type ModifierRequirement = boolean | "any";
export type InlineFormat = "bold" | "italic";
export type ZoomShortcut = "in" | "out" | "reset";
export type ShortcutLabelPlatform = "windows" | "mac" | "linux";

export type ShortcutBinding = {
    key?: string;
    code?: string;
    primary?: true;
    shift?: ModifierRequirement;
    alt?: ModifierRequirement;
    labelKey?: string;
};

export type ShortcutDefinition = {
    command: AppCommand;
    scopes: readonly ShortcutScope[];
    availability?: ShortcutAvailability;
    bindings: readonly ShortcutBinding[];
};

type ShortcutMatchOptions = {
    canUseNativeFileSystem?: boolean;
};

export const shortcutKeymap = [
    {
        command: "file:new",
        scopes: ["global", "menu"],
        availability: "native-file-system",
        bindings: [{ key: "n", primary: true }],
    },
    {
        command: "file:open",
        scopes: ["global", "menu"],
        availability: "native-file-system",
        bindings: [{ key: "o", primary: true }],
    },
    {
        command: "file:open-directory",
        scopes: ["global", "menu"],
        availability: "native-file-system",
        bindings: [{ key: "o", primary: true, shift: true }],
    },
    {
        command: "file:save",
        scopes: ["global", "menu"],
        availability: "native-file-system",
        bindings: [{ key: "s", primary: true }],
    },
    {
        command: "file:save-as",
        scopes: ["global", "menu"],
        availability: "native-file-system",
        bindings: [{ key: "s", primary: true, shift: true }],
    },
    {
        command: "edit:undo",
        scopes: ["editor", "title", "menu"],
        bindings: [{ key: "z", primary: true }],
    },
    {
        command: "edit:redo",
        scopes: ["editor", "title", "menu"],
        bindings: [
            { key: "y", primary: true },
            { key: "z", primary: true, shift: true },
        ],
    },
    {
        command: "edit:cut",
        scopes: ["menu"],
        bindings: [{ key: "x", primary: true }],
    },
    {
        command: "edit:copy",
        scopes: ["menu"],
        bindings: [{ key: "c", primary: true }],
    },
    {
        command: "edit:paste",
        scopes: ["menu"],
        bindings: [{ key: "v", primary: true }],
    },
    {
        command: "edit:select-all",
        scopes: ["editor", "markdown", "menu"],
        bindings: [{ key: "a", primary: true, shift: "any", alt: "any" }],
    },
    {
        command: "edit:find",
        scopes: ["global", "menu"],
        bindings: [{ key: "f", primary: true }],
    },
    {
        command: "edit:replace",
        scopes: ["global", "menu"],
        bindings: [{ key: "h", primary: true }],
    },
    {
        command: "view:toggle-file-tree",
        scopes: ["global", "menu"],
        bindings: [{ key: "e", primary: true }],
    },
    {
        command: "view:zoom-in",
        scopes: ["global", "menu"],
        bindings: [
            { key: "+", primary: true, shift: "any" },
            { key: "=", primary: true, shift: "any" },
            { code: "NumpadAdd", primary: true, shift: "any" },
        ],
    },
    {
        command: "view:zoom-out",
        scopes: ["global", "menu"],
        bindings: [
            { key: "-", primary: true, shift: "any" },
            { key: "_", primary: true, shift: "any" },
            { code: "NumpadSubtract", primary: true, shift: "any" },
        ],
    },
    {
        command: "view:zoom-reset",
        scopes: ["global", "menu"],
        bindings: [
            { key: "0", primary: true, shift: "any" },
            { code: "Numpad0", primary: true, shift: "any" },
        ],
    },
    {
        command: "format:bold",
        scopes: ["editor", "markdown"],
        bindings: [{ key: "b", primary: true, shift: "any" }],
    },
    {
        command: "format:italic",
        scopes: ["editor", "markdown"],
        bindings: [{ key: "i", primary: true, shift: "any" }],
    },
] as const satisfies readonly ShortcutDefinition[];

export function matchesShortcutCommand(
    event: KeyboardEvent,
    command: AppCommand,
    scope: ShortcutScope,
    options: ShortcutMatchOptions = {},
): boolean {
    return shortcutKeymap.some(
        (definition) =>
            definition.command === command &&
            hasScope(definition.scopes, scope) &&
            isShortcutAvailable(definition, options) &&
            definition.bindings.some((binding) => matchesShortcutBinding(event, binding)),
    );
}

export function readShortcutCommand(
    event: KeyboardEvent,
    scope: ShortcutScope,
    options: ShortcutMatchOptions = {},
): AppCommand | null {
    for (const definition of shortcutKeymap) {
        if (!hasScope(definition.scopes, scope) || !isShortcutAvailable(definition, options)) {
            continue;
        }

        if (definition.bindings.some((binding) => matchesShortcutBinding(event, binding))) {
            return definition.command;
        }
    }

    return null;
}

export function readShortcutLabel(
    command: AppMenuCommand,
    platform: ShortcutLabelPlatform = readShortcutLabelPlatform(),
): string | null {
    const definition = shortcutKeymap.find(
        (candidate) => candidate.command === command && hasScope(candidate.scopes, "menu"),
    );
    const binding = definition?.bindings[0];
    if (!binding) {
        return null;
    }

    return formatShortcutBindingLabel(binding, platform);
}

export function readInlineFormatShortcut(
    event: KeyboardEvent,
    scope: ShortcutScope = "editor",
): InlineFormat | null {
    const command = readShortcutCommand(event, scope);
    if (command === "format:bold") {
        return "bold";
    }

    if (command === "format:italic") {
        return "italic";
    }

    return null;
}

export function readZoomShortcut(event: KeyboardEvent): ZoomShortcut | null {
    const command = readShortcutCommand(event, "global");
    if (command === "view:zoom-in") {
        return "in";
    }

    if (command === "view:zoom-out") {
        return "out";
    }

    if (command === "view:zoom-reset") {
        return "reset";
    }

    return null;
}

function matchesShortcutBinding(event: KeyboardEvent, binding: ShortcutBinding): boolean {
    if (binding.primary && !(event.ctrlKey || event.metaKey)) {
        return false;
    }

    if (!binding.primary && (event.ctrlKey || event.metaKey)) {
        return false;
    }

    if (!matchesModifier(event.shiftKey, binding.shift ?? false)) {
        return false;
    }

    if (!matchesModifier(event.altKey, binding.alt ?? false)) {
        return false;
    }

    if (binding.key && normalizeKey(event.key) !== normalizeKey(binding.key)) {
        return false;
    }

    if (binding.code && event.code !== binding.code) {
        return false;
    }

    return Boolean(binding.key || binding.code);
}

function matchesModifier(isPressed: boolean, requirement: ModifierRequirement): boolean {
    return requirement === "any" || isPressed === requirement;
}

function isShortcutAvailable(definition: ShortcutDefinition, options: ShortcutMatchOptions): boolean {
    if ((definition.availability ?? "always") === "native-file-system") {
        return options.canUseNativeFileSystem ?? true;
    }

    return true;
}

function formatShortcutBindingLabel(binding: ShortcutBinding, platform: ShortcutLabelPlatform): string {
    const keys: string[] = [];
    if (binding.primary) {
        keys.push(platform === "mac" ? "Cmd" : "Ctrl");
    }

    if (binding.alt === true) {
        keys.push(platform === "mac" ? "Option" : "Alt");
    }

    if (binding.shift === true) {
        keys.push("Shift");
    }

    keys.push(readBindingLabelKey(binding));
    return keys.join("+");
}

function readBindingLabelKey(binding: ShortcutBinding): string {
    if (binding.labelKey) {
        return binding.labelKey;
    }

    if (binding.key) {
        return binding.key.length === 1 && /[a-z]/i.test(binding.key) ? binding.key.toUpperCase() : binding.key;
    }

    return binding.code ?? "";
}

function readShortcutLabelPlatform(): ShortcutLabelPlatform {
    if (typeof navigator === "undefined") {
        return "windows";
    }

    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent;
    if (platform.includes("mac") || userAgent.includes("Mac OS")) {
        return "mac";
    }

    if (platform.includes("linux") || userAgent.includes("Linux")) {
        return "linux";
    }

    return "windows";
}

function hasScope(scopes: readonly ShortcutScope[], scope: ShortcutScope): boolean {
    return scopes.some((candidate) => candidate === scope);
}

function normalizeKey(key: string): string {
    return key.length === 1 && /[a-z]/i.test(key) ? key.toLowerCase() : key;
}

if (import.meta.env.DEV) {
    warnForDuplicateBindings();
}

function warnForDuplicateBindings(): void {
    const seenBindings = new Map<string, AppCommand>();

    for (const definition of shortcutKeymap) {
        for (const scope of definition.scopes) {
            for (const binding of definition.bindings) {
                const signature = `${scope}:${readBindingSignature(binding)}`;
                const previousCommand = seenBindings.get(signature);
                if (previousCommand) {
                    console.warn(
                        `Duplicate shortcut binding for ${signature}: ${previousCommand} and ${definition.command}`,
                    );
                } else {
                    seenBindings.set(signature, definition.command);
                }
            }
        }
    }
}

function readBindingSignature(binding: ShortcutBinding): string {
    return JSON.stringify({
        key: binding.key ? normalizeKey(binding.key) : null,
        code: binding.code ?? null,
        primary: binding.primary === true,
        shift: binding.shift ?? false,
        alt: binding.alt ?? false,
    });
}
