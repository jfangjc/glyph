export type TextBoundaryDirection = "backward" | "forward";

const graphemeSegmenter = createSegmenter("grapheme");
const wordSegmenter = createSegmenter("word");

export function previousGraphemeBoundary(text: string, offset: number): number {
    const clamped = clampOffset(text, offset);
    let previous = 0;

    for (const boundary of readGraphemeBoundaries(text)) {
        if (boundary >= clamped) {
            break;
        }
        previous = boundary;
    }

    return previous;
}

export function nextGraphemeBoundary(text: string, offset: number): number {
    const clamped = clampOffset(text, offset);
    for (const boundary of readGraphemeBoundaries(text)) {
        if (boundary > clamped) {
            return boundary;
        }
    }

    return text.length;
}

export function previousWordBoundary(text: string, offset: number): number {
    const clamped = clampOffset(text, offset);
    if (clamped === 0) {
        return 0;
    }

    const segments = readWordSegments(text);
    let cursor = clamped;
    while (cursor > 0 && isWhitespace(text.slice(previousGraphemeBoundary(text, cursor), cursor))) {
        cursor = previousGraphemeBoundary(text, cursor);
    }

    const containing = [...segments].reverse().find((segment) => segment.from < cursor && segment.to >= cursor);
    return containing?.from ?? previousGraphemeBoundary(text, cursor);
}

export function nextWordBoundary(text: string, offset: number): number {
    const clamped = clampOffset(text, offset);
    if (clamped >= text.length) {
        return text.length;
    }

    const segments = readWordSegments(text);
    let cursor = clamped;
    while (cursor < text.length) {
        const next = nextGraphemeBoundary(text, cursor);
        if (!isWhitespace(text.slice(cursor, next))) {
            break;
        }
        cursor = next;
    }

    const containing = segments.find((segment) => segment.from <= cursor && segment.to > cursor);
    let boundary = containing?.to ?? nextGraphemeBoundary(text, cursor);
    while (boundary < text.length) {
        const next = nextGraphemeBoundary(text, boundary);
        if (!isHorizontalWhitespace(text.slice(boundary, next))) {
            break;
        }
        boundary = next;
    }
    return boundary;
}

export function previousLineBoundary(text: string, offset: number): number {
    return text.lastIndexOf("\n", Math.max(0, clampOffset(text, offset) - 1)) + 1;
}

export function nextLineBoundary(text: string, offset: number): number {
    const nextBreak = text.indexOf("\n", clampOffset(text, offset));
    return nextBreak < 0 ? text.length : nextBreak;
}

function readGraphemeBoundaries(text: string): number[] {
    if (graphemeSegmenter) {
        const boundaries = Array.from(graphemeSegmenter.segment(text), (segment) => segment.index);
        boundaries.push(text.length);
        return boundaries;
    }

    const boundaries = [0];
    let offset = 0;
    let regionalCount = 0;
    for (const character of Array.from(text)) {
        const codePoint = character.codePointAt(0) ?? 0;
        const joinsPrevious = isCombiningCodePoint(codePoint) || codePoint === 0x200d || regionalCount % 2 === 1 && isRegionalIndicator(codePoint);
        if (!joinsPrevious && offset > 0 && text.codePointAt(offset - 1) !== 0x200d) {
            boundaries.push(offset);
        }
        regionalCount = isRegionalIndicator(codePoint) ? regionalCount + 1 : 0;
        offset += character.length;
    }
    boundaries.push(text.length);
    return Array.from(new Set(boundaries)).sort((left, right) => left - right);
}

function readWordSegments(text: string): Array<{ from: number; to: number }> {
    if (wordSegmenter) {
        return Array.from(wordSegmenter.segment(text), (segment) => ({
            from: segment.index,
            to: segment.index + segment.segment.length,
        }));
    }

    const segments: Array<{ from: number; to: number }> = [];
    const pattern = /\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]+/gu;
    for (const match of text.matchAll(pattern)) {
        segments.push({ from: match.index, to: match.index + match[0].length });
    }
    return segments;
}

function createSegmenter(granularity: "grapheme" | "word"): Intl.Segmenter | null {
    return typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity }) : null;
}

function isCombiningCodePoint(codePoint: number): boolean {
    return (
        /\p{M}/u.test(String.fromCodePoint(codePoint)) ||
        codePoint === 0xfe0e ||
        codePoint === 0xfe0f ||
        codePoint >= 0x1f3fb && codePoint <= 0x1f3ff
    );
}

function isRegionalIndicator(codePoint: number): boolean {
    return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isWhitespace(value: string): boolean {
    return /^\s+$/u.test(value);
}

function isHorizontalWhitespace(value: string): boolean {
    return /^[\t ]+$/u.test(value);
}

function clampOffset(text: string, offset: number): number {
    return Math.max(0, Math.min(Math.trunc(offset), text.length));
}
