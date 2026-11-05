# Adding markup formats

Glyph stores document source as the canonical model. Each format supplies capabilities around that source: indexing, rendering, editing transactions, clipboard behavior and an optional compiled preview. Opening, saving, history and selection remain shared.

## Current support

| Format | Adapter | Editing | Preview |
| --- | --- | --- | --- |
| Markdown | `formats/markdown/document.ts` | Live Preview and literal source | Print to PDF |
| LaTeX | `formats/latex/document.ts` | Highlighted source | Compiled PDF |
| Org mode | `formats/org/document.ts` | Literal source | Future adapter work |
| Typst | `formats/typst/document.ts` | Literal source | Future adapter work |
| Plain text / unknown extension | `formats/source/document.ts` | Literal source | None |

Org and Typst have dedicated factories and can be created from the command menu. Their syntax remains intact while their language-specific capabilities are developed.

## Registration

1. Add or update the format's entry in `frontend/src/formats/catalog.json`. It owns the ID, display label, extensions, default filename and filename editing policy.
2. Implement a factory in `frontend/src/formats/<language>/document.ts`. A `FormatAdapter` receives a `DocumentFormatDescriptor` and returns a `DocumentFormat`.
3. Register the factory under the entry's `adapter` key in `frontend/src/formats/registry.ts`.

`createFormatRegistry` validates registrations and builds ID and extension lookups. An entry without an adapter uses literal source editing. A declared adapter must exist; missing adapters and duplicate IDs/extensions fail at startup. Unknown file extensions use the registered plain-text fallback. New-document commands and file filters come from this same catalog.

The Go launch service reads catalog metadata to generate native file associations. Frontend adapter names require no corresponding Go allowlist entry.

## Build capabilities progressively

Start with `createSourceDocumentFormat(descriptor)`. Its single source block covers the entire document, preserving Unicode, whitespace and punctuation. The helper accepts optional rendering, editing, clipboard, projection and preview capabilities. Source-only adapters can implement Enter, indentation, paste and deletion transactions through `editing`.

For highlighting, supply `render.renderPlainTextContent` and a `plainTextHighlightPolicy`. LaTeX is an existing example. Highlighted HTML must escape source text, preserve its text content and keep source offsets valid.

For a structured live view, return a `DocumentFormat` with `livePreview: true`, a language-specific `index.build`, and matching rendering/editing capabilities. The shared source-mode command and view controls then become available. Literal source view bypasses the structured format's editing rules and preserves the same document and history.

`BlockIndexBuilder` receives source plus optional previous-index/change information. Offsets are JavaScript UTF-16 string offsets. Each block needs stable identity and accurate source/content ranges. Existing heading block types also feed the shared document outline. Adding a new visual block type requires updating the block model and projection/rendering support together.

Formats that build document-wide references or metadata can supply `render.readRenderContext`. That context refreshes on edits by default and may contain non-JSON data. A format may implement `render.shouldRefreshRenderContext` after its invalidation rules are established, and `readRenderContextKey` to opt into caching. Cache keys are scoped to the renderer. Markdown's punctuation-based invalidation and JSON cache key belong to its adapter.

Markdown's token toolbar, rich clipboard and pending-image workflow still contain Markdown-specific behavior. A future Org rich view should add its own interaction and clipboard handling around the shared transaction model. Source-only editing already works independently of those affordances.

## Compiled previews

An adapter can supply a `DocumentPreviewBehavior` with `kind: "pdf"`. It gets the shared source/PDF/split layout, pane resizing, narrow-window fallback and view commands.

The preview controller calls `sync(context)` as document metadata changes. Context includes the document session, path, saving state and dirty state. It calls `deactivate(oldContext)` when the behavior or session changes, and `onSaved(context)` only for the current preview owner. `compile(saveDocument)` enables the shared Save & Compile command.

Keep request IDs or cancellation state inside the preview implementation. Deactivation must invalidate outstanding work so a late compilation cannot replace another document's preview. Treat source-save errors and compilation errors separately; retain a valid older preview when compilation fails.

For Typst, add a native Typst compilation service and connect its PDF result to this interface. The existing `ReadSiblingPdfPreview` service invokes TeX compilers and belongs to LaTeX. The shared pane and lifecycle are ready for another compiler; compiler discovery, diagnostics, dependency tracking and actual Typst rendering remain language implementation work.

## Verification

Run `npm run typecheck` and `npm run build` in `frontend`.
