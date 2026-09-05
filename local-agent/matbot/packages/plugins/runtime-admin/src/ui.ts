import { createFeature } from './ui-module.js';
export const uiContribution = { ...{
        "title": "Plugins",
        "slot": "architecture",
        "view": "plugins",
        "fragments": [
            {
                "id": "architecture-panel-plugins",
                "html": "<section id=\"architecture-panel-plugins\" class=\"architecture-panel\" data-architecture-panel=\"plugins\" role=\"tabpanel\" aria-labelledby=\"architecture-tab-plugins\" hidden>\n          <div class=\"workflow-ops-section\">\n            <h3>Plugin management</h3>\n            <p>Inspect compatibility, runtime metadata, tools, activation, and removal controls in the Plugins sidebar.</p>\n            <button id=\"architecture-open-plugin-management\" class=\"primary\" type=\"button\">Open plugin management</button>\n          </div>\n        </section>"
            },
            {
                "id": "core-plugin-removal-dialog",
                "html": "<div id=\"core-plugin-removal-dialog\" class=\"architecture-health-modal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"core-plugin-removal-title\" hidden>\n    <div class=\"architecture-health-modal-header\">\n      <h2 id=\"core-plugin-removal-title\">Core plugin removal</h2>\n      <button id=\"core-plugin-removal-close\" type=\"button\">Close</button>\n    </div>\n    <p id=\"core-plugin-removal-message\"></p>\n    <p class=\"architecture-muted\">Core plugins are required by the active workspace and cannot be removed while it is running.</p>\n    <div class=\"architecture-card-actions\">\n      <button id=\"core-plugin-removal-cancel\" type=\"button\">Keep plugin</button>\n      <button id=\"core-plugin-removal-confirm\" class=\"danger\" type=\"button\" disabled>Remove core plugin</button>\n    </div>\n  </div>"
            }
        ]
    }, slot: 'architecture' as const, moduleSource: 'export const createFeature = ' + createFeature.toString() };
