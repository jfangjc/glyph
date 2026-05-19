import "./styles/global.css";
import "./styles/theme.css";
import "./editor/editor.css";
import { getElement } from "./editor/dom-utils";
import { installEditor } from "./editor/editor";
import { installWindowControls } from "./platform/window-controls/window-controls";

const app = getElement<HTMLElement>("app");

installWindowControls();
installEditor(app);
