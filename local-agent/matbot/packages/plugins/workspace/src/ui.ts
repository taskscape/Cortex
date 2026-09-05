import { createFeature } from './ui-module.js';
export const uiContribution = { ...{
        "title": "Files",
        "slot": "sidebar",
        "fragments": [
            {
                "id": "attachment-tray",
                "html": "<div id=\"attachment-tray\" aria-label=\"Files attached to the next message\" hidden></div>"
            }
        ]
    }, slot: 'sidebar' as const, moduleSource: 'export const createFeature = ' + createFeature.toString() };
