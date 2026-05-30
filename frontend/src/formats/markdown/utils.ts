export function isEscapedAt(text: string, index: number): boolean {
    let slashCount = 0;

    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
    }

    return slashCount % 2 === 1;
}

export function findUnescapedSequence(text: string, sequence: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }

        if (text.startsWith(sequence, index)) {
            return index;
        }
    }

    return -1;
}

export function countIndentColumns(value: string): number {
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

export function serializeListIndent(indent: number | undefined): string {
    return "  ".repeat(Math.max(0, Math.min(indent ?? 0, 3)));
}
