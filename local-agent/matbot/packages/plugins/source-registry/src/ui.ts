import { createFeature } from './ui-module.js';
export const uiContribution = { ...{
        "title": "Sources",
        "slot": "architecture",
        "view": "sources",
        "fragments": [
            {
                "id": "architecture-panel-sources",
                "html": "<section id=\"architecture-panel-sources\" class=\"architecture-panel active\" data-architecture-panel=\"sources\" role=\"tabpanel\" aria-labelledby=\"architecture-tab-sources\">\n          <div class=\"architecture-toolbar\">\n            <div id=\"architecture-source-status\" class=\"architecture-status\" role=\"status\"></div>\n            <div class=\"architecture-actions\">\n              <button id=\"architecture-source-refresh\" type=\"button\">Refresh</button>\n            </div>\n          </div>\n          <div id=\"architecture-source-health-summary\" class=\"source-health-summary\" aria-label=\"Source health counts\"></div>\n          <div class=\"architecture-grid\">\n            <div id=\"architecture-source-list\" class=\"architecture-list\" aria-label=\"Sources\"></div>\n            <div id=\"architecture-source-detail\" class=\"architecture-detail\" aria-live=\"polite\"></div>\n          </div>\n          <div id=\"architecture-source-health-modal\" class=\"architecture-health-modal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"architecture-source-health-modal-title\" hidden>\n            <div class=\"architecture-health-modal-header\">\n              <h3 id=\"architecture-source-health-modal-title\">Source health report</h3>\n              <button id=\"architecture-source-health-modal-close\" type=\"button\">Close</button>\n            </div>\n            <div id=\"architecture-source-health-modal-content\"></div>\n          </div>\n        </section>"
            }
        ]
    }, slot: 'architecture' as const, moduleSource: 'export const createFeature = ' + createFeature.toString() };
