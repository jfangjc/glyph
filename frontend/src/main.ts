import "./global.css";
import "./editor/editor.css";
import { installEditor } from "./editor/editor";
import { installWindowsPlatform } from "./platform/windows/windows";

const app = getElement<HTMLElement>("app");

installWindowsPlatform();
installEditor(app);

function getElement<TElement extends HTMLElement>(id: string): TElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as TElement;
}
