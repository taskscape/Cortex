import { createFeature } from './ui-module.js';
export const uiContribution = { ...{
        "title": "Workspaces",
        "slot": "sidebar",
        "fragments": [
            {
                "id": "workspace-menu",
                "html": "<div id=\"workspace-menu\">\n      <div id=\"workspace-popover\" role=\"menu\" aria-label=\"Workspace selector\">\n        <div id=\"workspace-list\"></div>\n        <div class=\"workspace-actions\">\n          <button id=\"workspace-new-btn\" class=\"workspace-action\" type=\"button\">+ New workspace</button>\n          <button id=\"workspace-rename-btn\" class=\"workspace-action\" type=\"button\">Rename workspace</button>\n        </div>\n        <div id=\"workspace-status\" role=\"status\" aria-live=\"polite\"></div>\n      </div>\n      <div id=\"workspace-controls\">\n        <button id=\"workspace-toggle-btn\" type=\"button\" aria-haspopup=\"menu\" aria-expanded=\"false\" title=\"Switch workspace\">\n          <span id=\"workspace-avatar\">C</span>\n          <span id=\"workspace-name\">Default</span>\n          <span id=\"workspace-chevron\">⌃</span>\n        </button>\n        <button id=\"workspace-config-btn\" type=\"button\" aria-expanded=\"false\" title=\"Configure workspace RAG\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-settings h-5 w-5 text-muted-foreground\" aria-hidden=\"true\"><path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"></path><circle cx=\"12\" cy=\"12\" r=\"3\"></circle></svg></button>\n      </div>\n    </div>"
            },
            {
                "id": "workspace-delete-dialog",
                "html": "<div id=\"workspace-delete-dialog\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"workspace-delete-title\" aria-hidden=\"true\">\n    <div class=\"workspace-delete-panel\">\n      <h2 id=\"workspace-delete-title\">Delete workspace?</h2>\n      <p id=\"workspace-delete-message\"></p>\n      <div class=\"workspace-delete-actions\">\n        <button id=\"workspace-delete-cancel\" type=\"button\">Cancel</button>\n        <button id=\"workspace-delete-confirm\" class=\"danger\" type=\"button\">Yes</button>\n      </div>\n    </div>\n  </div>"
            }
        ]
    }, slot: 'sidebar' as const, moduleSource: 'export const createFeature = ' + createFeature.toString() };
