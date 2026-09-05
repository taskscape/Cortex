import { createFeature } from './ui-module.js';
export const uiContribution = { ...{
        "panelTitle": "Graph Entities",
        "title": "Context graph",
        "slot": "architecture",
        "view": "graph",
        "fragments": [
            {
                "id": "architecture-panel-graph",
                "html": "<section id=\"architecture-panel-graph\" class=\"architecture-panel\" data-architecture-panel=\"graph\" role=\"tabpanel\" aria-labelledby=\"architecture-tab-graph\" hidden>\n          <form id=\"architecture-graph-form\" class=\"architecture-form\">\n            <label>\n              Search\n              <input id=\"architecture-graph-search\" type=\"search\" value=\"Acme\" autocomplete=\"off\">\n            </label>\n            <label>\n              Source\n              <input id=\"architecture-graph-source\" type=\"text\" value=\"source:playwright-architecture-brief\" autocomplete=\"off\">\n            </label>\n            <div class=\"architecture-form-actions\">\n              <button id=\"architecture-graph-refresh\" type=\"button\">Refresh</button>\n              <button id=\"architecture-graph-retrieve\" class=\"primary\" type=\"submit\">Retrieve</button>\n            </div>\n          </form>\n          <div class=\"architecture-toolbar\">\n            <div id=\"architecture-graph-status\" class=\"architecture-status\" role=\"status\"></div>\n          </div>\n          <div class=\"architecture-grid\">\n            <div id=\"architecture-graph-list\" class=\"architecture-list\" aria-label=\"Graph entities\"></div>\n            <div id=\"architecture-graph-detail\" class=\"architecture-detail\" aria-live=\"polite\"></div>\n          </div>\n        </section>"
            }
        ]
    }, slot: 'architecture' as const, moduleSource: 'export const createFeature = ' + createFeature.toString() };
