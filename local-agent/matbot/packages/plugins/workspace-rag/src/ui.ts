import { createFeature } from './ui-module.js';
export const uiContribution = { ...{
        "title": "Workspace RAG",
        "slot": "sidebar",
        "fragments": [
            {
                "id": "workspace-settings-screen",
                "html": "<section id=\"workspace-settings-screen\" aria-label=\"Workspace settings\">\n      <div class=\"workspace-settings-page\">\n        <div class=\"workspace-settings-header\">\n          <div>\n            <div class=\"workspace-settings-eyebrow\">Workspace</div>\n            <h2>Settings</h2>\n          </div>\n        </div>\n        <div class=\"workspace-settings-panel\">\n        <label class=\"workspace-config-label\">\n          Context name\n          <input id=\"workspace-context-name\" type=\"text\" placeholder=\"Workspace context\">\n        </label>\n        <label class=\"workspace-config-label\">\n          Markdown folders\n          <textarea id=\"workspace-rag-paths\" spellcheck=\"false\" placeholder=\"C:\\Projects\\Docs&#10;D:\\Knowledge\\Base\"></textarea>\n        </label>\n        <div id=\"workspace-rag-progress\"><div id=\"workspace-rag-progress-bar\"></div></div>\n        <div id=\"workspace-rag-status\" role=\"status\" aria-live=\"polite\"></div>\n        <div id=\"workspace-rag-current-file\" title=\"\"></div>\n        <div class=\"workspace-config-actions\">\n          <button id=\"workspace-settings-cancel-btn\" type=\"button\">Close</button>\n          <button id=\"workspace-rag-save-btn\" class=\"primary\" type=\"button\">Save</button>\n        </div>\n      </div>\n      </div>\n    </section>"
            }
        ]
    }, slot: 'sidebar' as const, moduleSource: 'export const createFeature = ' + createFeature.toString() };
