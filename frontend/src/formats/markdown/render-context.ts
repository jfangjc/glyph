import { headingTypes, type BlockType, type ParsedBlock } from "../../editor/blocks/model";
import { escapeHtml } from "../../utils/text";
import type { DocumentRenderContext } from "../types";
import { normalizeReferenceLabel } from "./references";
import { renderInlineMarkdown } from "./inline";
import {
    parseFootnoteDefinitionSource,
    readFootnoteReferenceLabels,
    readMarkdownReferences,
    stripMarkdownInlineSource,
} from "./parse";
import { renderDefinitionListBlock } from "./definition-list";

type MarkdownRenderData = {
    headingIds: string[];
    footnotes: {
        definitions: Record<string, { label: string; text: string }>;
        numbers: Record<string, number>;
        order: string[];
        referenceIds: Record<string, string[]>;
        renderCursors?: Record<string, number>;
    };
};

export function readMarkdownRenderContext(blocks: ParsedBlock[]): DocumentRenderContext {
    const references = readMarkdownReferences(blocks);
    const data: MarkdownRenderData = {
        headingIds: readMarkdownHeadingIds(blocks),
        footnotes: readMarkdownFootnotes(blocks),
    };

    return { references, data };
}

export function applyMarkdownRenderContext(blocks: HTMLElement[], context: DocumentRenderContext): void {
    const data = readMarkdownRenderData(context);
    if (!data) {
        return;
    }

    let headingIndex = 0;
    for (const block of blocks) {
        const type = block.dataset.type as BlockType | undefined;
        if (!type || !headingTypes.has(type)) {
            block.removeAttribute("id");
            continue;
        }

        const headingId = data.headingIds[headingIndex];
        headingIndex += 1;
        if (headingId) {
            block.dataset.headingId = headingId;
            if (block.dataset.headingIdExplicit !== "true") {
                block.dataset.headingIdExplicit = "false";
            }
            block.id = headingId;
        } else {
            delete block.dataset.headingId;
            delete block.dataset.headingIdExplicit;
            block.removeAttribute("id");
        }
    }
}

export function renderMarkdownDocumentFooter(context: DocumentRenderContext): string {
    const data = readMarkdownRenderData(context);
    if (!data || data.footnotes.order.length === 0) {
        return "";
    }

    const items = data.footnotes.order
        .map((label) => {
            const definition = data.footnotes.definitions[label];
            const number = data.footnotes.numbers[label];
            if (!definition || !number) {
                return "";
            }

            const encodedLabel = encodeURIComponent(label);
            const referenceId = data.footnotes.referenceIds[label]?.[0] ?? `fnref-${encodedLabel}`;
            return `<li id="fn-${encodedLabel}" class="markdown-footnote-item"><span class="markdown-footnote-body">${renderInlineMarkdown(definition.text, context)}</span> <a class="markdown-footnote-backref" href="#${escapeHtml(referenceId)}" data-href="#${escapeHtml(referenceId)}" aria-label="Back to reference">&#8617;</a></li>`;
        })
        .join("");

    data.footnotes.renderCursors = {};
    return `<section class="markdown-footnotes"><hr><ol>${items}</ol></section>`;
}

export function renderExtendedMarkdownBlock(type: BlockType, text: string, context: DocumentRenderContext): string | null {
    if (type !== "definition-list") {
        return null;
    }

    return renderDefinitionListBlock(text, context);
}

function readMarkdownRenderData(context: DocumentRenderContext): MarkdownRenderData | null {
    const data = context.data;
    if (!data || typeof data !== "object" || !("headingIds" in data) || !("footnotes" in data)) {
        return null;
    }

    return data as MarkdownRenderData;
}

function createMarkdownSlugger(): { slug: (value: string) => string; unique: (value: string) => string } {
    const counts = new Map<string, number>();

    const unique = (base: string): string => {
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        return count === 0 ? base : `${base}-${count}`;
    };

    return {
        slug(value: string): string {
            return unique(slugMarkdownHeading(value));
        },
        unique,
    };
}

function slugMarkdownHeading(value: string): string {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/<[^>]*>/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s+/g, "-");

    return slug || "heading";
}

function readMarkdownHeadingIds(blocks: ParsedBlock[]): string[] {
    const slugger = createMarkdownSlugger();
    const ids: string[] = [];

    for (const block of blocks) {
        if (!headingTypes.has(block.type)) {
            continue;
        }

        const explicitId = block.headingIdExplicit ? normalizeHeadingId(block.headingId) : "";
        if (explicitId) {
            ids.push(slugger.unique(explicitId));
            continue;
        }

        ids.push(slugger.slug(stripMarkdownInlineSource(block.text) || "heading"));
    }

    return ids;
}

function normalizeHeadingId(value: string | undefined): string {
    return (value ?? "").trim().replace(/\s+/g, "-");
}

function readMarkdownFootnotes(blocks: ParsedBlock[]): MarkdownRenderData["footnotes"] {
    const definitions: MarkdownRenderData["footnotes"]["definitions"] = {};
    const numbers: Record<string, number> = {};
    const order: string[] = [];
    const referenceIds: Record<string, string[]> = {};

    for (const block of blocks) {
        if (block.type !== "footnote-definition") {
            continue;
        }

        const definition = parseFootnoteDefinitionSource(block.text);
        if (definition) {
            definitions[definition.normalizedLabel] = { label: definition.label, text: definition.text };
        }
    }

    for (const block of blocks) {
        if (block.type === "footnote-definition" || block.type === "reference" || block.type === "code" || block.type === "source") {
            continue;
        }

        for (const label of readFootnoteReferenceLabels(block.text)) {
            const normalizedLabel = normalizeReferenceLabel(label);
            if (!definitions[normalizedLabel]) {
                continue;
            }

            if (!numbers[normalizedLabel]) {
                numbers[normalizedLabel] = order.length + 1;
                order.push(normalizedLabel);
            }

            const encodedLabel = encodeURIComponent(normalizedLabel);
            const ids = referenceIds[normalizedLabel] ?? [];
            ids.push(ids.length === 0 ? `fnref-${encodedLabel}` : `fnref-${encodedLabel}-${ids.length + 1}`);
            referenceIds[normalizedLabel] = ids;
        }
    }

    return { definitions, numbers, order, referenceIds };
}
