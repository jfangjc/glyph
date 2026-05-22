import "./styles/global.css";
import "katex/dist/katex.min.css";
import "./styles/theme.css";
import "./editor/editor.css";
import { getElement } from "./utils/dom";
import { installEditor } from "./editor/editor";
import { installWindowControls } from "./platform/window-controls/window-controls";

const app = getElement<HTMLElement>("app");

installWindowControls();
installEditor(app);
