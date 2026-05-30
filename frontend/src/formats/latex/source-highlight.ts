import { escapeHtml } from "../../utils/text";

const latexKeywordCommands = new Set([
    "author",
    "begin",
    "bibliographystyle",
    "caption",
    "chapter",
    "cite",
    "date",
    "documentclass",
    "emph",
    "end",
    "footnote",
    "frac",
    "include",
    "includegraphics",
    "input",
    "item",
    "label",
    "maketitle",
    "newcommand",
    "paragraph",
    "part",
    "ref",
    "renewcommand",
    "section",
    "subparagraph",
    "subsection",
    "subsubsection",
    "tableofcontents",
    "textbf",
    "textit",
    "title",
    "usepackage",
]);

export function renderLatexSourceHtml(text: string): string {
    let html = "";
    let index = 0;

    while (index < text.length) {
        const character = text[index];

        if (character === "%" && !isEscaped(text, index)) {
            const end = findLineEnd(text, index);
            html += wrapLatexSourceToken("comment", text.slice(index, end));
            index = end;
            continue;
        }

        if (character === "\\") {
            const token = readLatexCommandToken(text, index);
            html += wrapLatexCommandToken(token.raw, token.name);
            index = token.end;

            if (token.name === "begin" || token.name === "end") {
                const environment = readLatexEnvironmentName(text, index);
                if (environment) {
                    html += environment.html;
                    index = environment.end;
                }
            }
            continue;
        }

        if (character === "$") {
            const raw = text[index + 1] === "$" ? "$$" : "$";
            html += wrapLatexSourceToken("math-delimiter", raw);
            index += raw.length;
            continue;
        }

        if (isLatexPunctuation(character)) {
            html += wrapLatexSourceToken("punctuation", character);
            index += 1;
            continue;
        }

        const end = findNextLatexSpecialCharacter(text, index + 1);
        html += escapeHtml(text.slice(index, end));
        index = end;
    }

    return html;
}

function readLatexCommandToken(text: string, start: number): { raw: string; name: string; end: number } {
    const nameStart = start + 1;
    let end = nameStart;

    while (end < text.length && /[A-Za-z@]/.test(text[end])) {
        end += 1;
    }

    if (end === nameStart && nameStart < text.length) {
        end += 1;
    }

    return {
        raw: text.slice(start, end),
        name: text.slice(nameStart, end),
        end,
    };
}

function readLatexEnvironmentName(text: string, start: number): { html: string; end: number } | null {
    let index = start;
    let html = "";

    while (index < text.length && /[ \t]/.test(text[index])) {
        html += escapeHtml(text[index]);
        index += 1;
    }

    if (text[index] !== "{") {
        return null;
    }

    const nameStart = index + 1;
    const nameEnd = text.indexOf("}", nameStart);
    if (nameEnd < 0 || text.slice(nameStart, nameEnd).includes("\n")) {
        return null;
    }

    html += wrapLatexSourceToken("punctuation", "{");
    html += wrapLatexSourceToken("environment", text.slice(nameStart, nameEnd));
    html += wrapLatexSourceToken("punctuation", "}");

    return { html, end: nameEnd + 1 };
}

function wrapLatexCommandToken(raw: string, name: string): string {
    if (raw === "\\[" || raw === "\\]" || raw === "\\(" || raw === "\\)") {
        return wrapLatexSourceToken("math-delimiter", raw);
    }

    return wrapLatexSourceToken(latexKeywordCommands.has(name) ? "keyword" : "command", raw);
}

function wrapLatexSourceToken(kind: string, raw: string): string {
    return `<span class="latex-source-${kind}">${escapeHtml(raw)}</span>`;
}

function findLineEnd(text: string, start: number): number {
    const lineEnd = text.indexOf("\n", start);
    return lineEnd < 0 ? text.length : lineEnd;
}

function findNextLatexSpecialCharacter(text: string, start: number): number {
    for (let index = start; index < text.length; index += 1) {
        if (isLatexSpecialCharacter(text[index])) {
            return index;
        }
    }

    return text.length;
}

function isLatexSpecialCharacter(character: string): boolean {
    return character === "\\" || character === "%" || character === "$" || isLatexPunctuation(character);
}

function isLatexPunctuation(character: string): boolean {
    return character === "{" || character === "}" || character === "[" || character === "]" || character === "&";
}

function isEscaped(text: string, index: number): boolean {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
    }

    return slashCount % 2 === 1;
}
