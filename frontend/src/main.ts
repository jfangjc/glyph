import "./styles/global.css";
import "katex/dist/katex.min.css";
import "./styles/theme.css";
import "./formats/markdown/markdown.css";
import "./editor/layout.css";
import "./formats/latex/latex-preview.css";
import "./editor/find-replace.css";
import "./editor/document-outline.css";
import "./documents/file-tree.css";
import { getElement } from "./utils/dom";
import { installEditor } from "./editor/editor";
import { installWindowControls } from "./platform/window-controls/window-controls";

const app = getElement<HTMLElement>("app");

installWindowControls();
installEditor(app);
