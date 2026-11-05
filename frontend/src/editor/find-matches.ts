export type FindMatch = { from: number; to: number };
export type FindOptions = { caseSensitive: boolean; wholeWord: boolean };

const wordCharacterPattern = /[\p{L}\p{N}\p{M}_]/u;

export function collectMatches(source: string, query: string, options: FindOptions): FindMatch[] {
    if (!query) return [];
    const matches: FindMatch[] = [];
    const pattern = new RegExp(escapeRegExp(query), options.caseSensitive ? "gu" : "giu");
    for (const match of source.matchAll(pattern)) {
        const from = match.index;
        const to = from + match[0].length;
        if (!options.wholeWord || isWholeWord(source, from, to)) {
            matches.push({ from, to });
        }
        if (matches.length >= 10_000) break;
    }
    return matches;
}

export function matchesQueryAt(source: string, match: FindMatch, query: string, options: FindOptions): boolean {
    const candidate = source.slice(match.from, match.to);
    const pattern = new RegExp(`^${escapeRegExp(query)}$`, options.caseSensitive ? "u" : "iu");
    return pattern.test(candidate) && (!options.wholeWord || isWholeWord(source, match.from, match.to));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWholeWord(source: string, from: number, to: number): boolean {
    // Match offsets use UTF-16, but boundaries must inspect complete code points.
    const before = from > 0 ? /.$/us.exec(source.slice(Math.max(0, from - 2), from))?.[0] ?? "" : "";
    const after = to < source.length ? String.fromCodePoint(source.codePointAt(to)!) : "";
    return !wordCharacterPattern.test(before) && !wordCharacterPattern.test(after);
}
