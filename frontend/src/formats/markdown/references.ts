export type MarkdownReference = {
    destination: string;
    title?: string;
};

export type MarkdownReferenceMap = Record<string, MarkdownReference>;

export function normalizeReferenceLabel(label: string): string {
    return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseMarkdownReferenceDefinition(
    line: string,
): { normalizedLabel: string; reference: MarkdownReference } | null {
    const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? "";
    if (countIndentColumns(leadingWhitespace) > 3) {
        return null;
    }

    const startIndex = leadingWhitespace.length;
    if (line[startIndex] !== "[") {
        return null;
    }

    const labelEnd = findUnescapedCharacter(line, "]", startIndex + 1);
    if (labelEnd <= startIndex + 1 || line[labelEnd + 1] !== ":") {
        return null;
    }

    const label = line.slice(startIndex + 1, labelEnd);
    const normalizedLabel = normalizeReferenceLabel(label);
    if (!normalizedLabel) {
        return null;
    }

    const reference = parseMarkdownDestinationWithTitle(line.slice(labelEnd + 2));
    if (!reference) {
        return null;
    }

    return { normalizedLabel, reference };
}

export function parseMarkdownDestinationWithTitle(value: string): MarkdownReference | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    let destination = "";
    let rest = "";

    if (trimmed.startsWith("<")) {
        const closingBracket = findUnescapedCharacter(trimmed, ">", 1);
        if (closingBracket <= 1) {
            return null;
        }

        destination = trimmed.slice(1, closingBracket);
        rest = trimmed.slice(closingBracket + 1).trim();
    } else {
        const destinationEnd = findDestinationEnd(trimmed);
        destination = trimmed.slice(0, destinationEnd);
        rest = trimmed.slice(destinationEnd).trim();
    }

    if (!destination) {
        return null;
    }

    let title: string | undefined;
    if (rest) {
        const parsedTitle = parseMarkdownTitle(rest);
        if (parsedTitle === null) {
            return null;
        }

        title = parsedTitle;
    }

    return {
        destination: unescapeMarkdownText(destination),
        ...(title !== undefined ? { title } : {}),
    };
}

export function unescapeMarkdownText(value: string): string {
    return value.replace(/\\([\\`*{}\[\]<>#!_()+\-.|])/g, "$1");
}

function parseMarkdownTitle(value: string): string | null {
    const quote = value[0];

    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        return unescapeMarkdownText(value.slice(1, -1));
    }

    if (quote === "(" && value.endsWith(")")) {
        return unescapeMarkdownText(value.slice(1, -1));
    }

    return null;
}

function findDestinationEnd(value: string): number {
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "\\") {
            index += 1;
            continue;
        }

        if (/\s/.test(value[index])) {
            return index;
        }
    }

    return value.length;
}

function findUnescapedCharacter(text: string, character: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }

        if (text[index] === character) {
            return index;
        }
    }

    return -1;
}

function countIndentColumns(value: string): number {
    let columns = 0;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];

        if (character === "\t") {
            columns += 4 - (columns % 4);
        } else {
            columns += 1;
        }
    }

    return columns;
}
