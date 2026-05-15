import "./styles/global.css";
import "./styles/theme.css";
import "./editor/editor.css";
import { installEditor } from "./editor/editor";
import { installWindowControls } from "./platform/window-controls/window-controls";

const app = getElement<HTMLElement>("app");

installWindowControls();
installEditor(app);

function getElement<TElement extends HTMLElement>(id: string): TElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as TElement;
}
