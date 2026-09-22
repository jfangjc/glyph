const graphemeSegmenter = createSegmenter("grapheme");
const wordSegmenter = createSegmenter("word");

type LineSegments = {
    text: string;
    graphemes?: Intl.Segments;
    words?: Intl.Segments;
    fallbackGraphemes?: number[];
    fallbackWords?: Array<{ from: number; to: number }>;
};
const lineCache = new Map<string, LineSegments>();
let cachedCharacters = 0;
let currentLine: { doc: string; from: number; to: number; segments: LineSegments } | null = null;

// Cache by source content, never by the selection revision. Intl.Segments.containing
// seeks directly using Unicode boundaries, including on exceptionally long lines;
// no fixed substring can split a ZWJ sequence or change regional-indicator parity.
function lineAt(text: string, offset: number) {
    if (currentLine?.doc === text && offset >= currentLine.from && offset < currentLine.to) return currentLine;
    const from = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
    const newline = text.indexOf("\n", offset);
    const to = newline < 0 ? text.length : newline + 1;
    const source = text.slice(from, to);
    let segments = lineCache.get(source);
    if (!segments) {
        segments = { text: source };
        lineCache.set(source, segments);
        cachedCharacters += source.length;
        // Keep the current long line, but bound retained unrelated source.
        while (lineCache.size > 1 && (lineCache.size > 64 || cachedCharacters > 2_000_000)) {
            const oldest = lineCache.keys().next().value!;
            cachedCharacters -= oldest.length;
            lineCache.delete(oldest);
        }
    }
    currentLine = { doc: text, from, to, segments };
    return currentLine;
}

function upperBound(boundaries: number[], offset: number): number {
    let low = 0, high = boundaries.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (boundaries[mid] <= offset) low = mid + 1;
        else high = mid;
    }
    return low;
}

function containing(text: string, offset: number, granularity: "grapheme" | "word") {
    const line = lineAt(text, offset);
    const local = offset - line.from;
    const cache = line.segments;
    const segmenter = granularity === "grapheme" ? graphemeSegmenter : wordSegmenter;
    if (segmenter) {
        const segments = granularity === "grapheme"
            ? cache.graphemes ??= segmenter.segment(cache.text)
            : cache.words ??= segmenter.segment(cache.text);
        const segment = segments.containing(local)!;
        return { from: line.from + segment.index, to: line.from + segment.index + segment.segment.length };
    }
    if (granularity === "grapheme") {
        const boundaries = cache.fallbackGraphemes ??= readGraphemeBoundaries(cache.text);
        const index = upperBound(boundaries, local);
        return { from: line.from + boundaries[index - 1], to: line.from + boundaries[index] };
    }
    const segments = cache.fallbackWords ??= readWordSegments(cache.text);
    let low = 0, high = segments.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (segments[mid].to <= local) low = mid + 1;
        else high = mid;
    }
    const segment = segments[low];
    return { from: line.from + segment.from, to: line.from + segment.to };
}

export function previousGraphemeBoundary(text: string, offset: number): number {
    const cursor = clampOffset(text, offset);
    return cursor === 0 ? 0 : containing(text, cursor - 1, "grapheme").from;
}

export function nextGraphemeBoundary(text: string, offset: number): number {
    const cursor = clampOffset(text, offset);
    return cursor === text.length ? cursor : containing(text, cursor, "grapheme").to;
}

export function previousWordBoundary(text: string, offset: number): number {
    let cursor = clampOffset(text, offset);
    while (cursor > 0) {
        const previous = previousGraphemeBoundary(text, cursor);
        if (!isWhitespace(text.slice(previous, cursor))) break;
        cursor = previous;
    }
    return cursor === 0 ? 0 : containing(text, cursor - 1, "word").from;
}

export function nextWordBoundary(text: string, offset: number): number {
    let cursor = clampOffset(text, offset);
    while (cursor < text.length) {
        const next = nextGraphemeBoundary(text, cursor);
        if (!isWhitespace(text.slice(cursor, next))) break;
        cursor = next;
    }
    if (cursor === text.length) return cursor;
    let boundary = containing(text, cursor, "word").to;
    while (boundary < text.length) {
        const next = nextGraphemeBoundary(text, boundary);
        if (!isHorizontalWhitespace(text.slice(boundary, next))) break;
        boundary = next;
    }
    return boundary;
}

export function previousLineBoundary(text: string, offset: number): number {
    const cursor = clampOffset(text, offset);
    return cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1;
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
