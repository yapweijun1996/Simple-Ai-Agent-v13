// js/tool-handlers.js
// Extracted tool handler functions from chat-controller.js
import { ToolsService } from './tools-service.js';
import { UIController } from './ui-controller.js';

export const toolHandlers = {
    web_search: async function(args) {
        if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
            UIController.addMessage('ai', 'Error: Invalid web_search query.');
            return;
        }
        const engine = args.engine || 'duckduckgo';
        UIController.showSpinner(`Searching (${engine}) for "${args.query}"...`);
        UIController.showStatus(`Searching (${engine}) for "${args.query}"...`);
        let results = [];
        try {
            const streamed = [];
            results = await ToolsService.webSearch(args.query, (result) => {
                streamed.push(result);
                // Pass highlight flag if this index is in highlightedResultIndices
                const idx = streamed.length - 1;
                UIController.addSearchResult(result, (url) => {
                    // processToolCall is not available here; must be injected or handled by caller
                }, false);
            }, engine);
            if (!results.length) {
                UIController.addMessage('ai', `No search results found for "${args.query}".`);
            }
            const plainTextResults = results.map((r, i) => `${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
            // chatHistory and suggestResultsToRead are not available here; must be handled by caller
        } catch (err) {
            UIController.hideSpinner();
            UIController.addMessage('ai', `Web search failed: ${err.message}`);
            // chatHistory is not available here
        }
        UIController.hideSpinner();
        UIController.clearStatus();
    },
    read_url: async function(args) {
        if (!args.url || typeof args.url !== 'string' || !/^https?:\/\//.test(args.url)) {
            UIController.addMessage('ai', 'Error: Invalid read_url argument.');
            return;
        }
        UIController.showSpinner(`Reading content from ${args.url}...`);
        UIController.showStatus(`Reading content from ${args.url}...`);
        try {
            const result = await ToolsService.readUrl(args.url);
            const start = (typeof args.start === 'number' && args.start >= 0) ? args.start : 0;
            const length = (typeof args.length === 'number' && args.length > 0) ? args.length : 1122;
            const snippet = String(result).slice(start, start + length);
            const hasMore = (start + length) < String(result).length;
            UIController.addReadResult(args.url, snippet, hasMore);
            // chatHistory and readSnippets are not available here
        } catch (err) {
            UIController.hideSpinner();
            UIController.addMessage('ai', `Read URL failed: ${err.message}`);
            // chatHistory is not available here
        }
        UIController.hideSpinner();
        UIController.clearStatus();
    },
    instant_answer: async function(args) {
        if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
            UIController.addMessage('ai', 'Error: Invalid instant_answer query.');
            return;
        }
        UIController.showStatus(`Retrieving instant answer for "${args.query}"...`);
        try {
            const result = await ToolsService.instantAnswer(args.query);
            const text = JSON.stringify(result, null, 2);
            UIController.addMessage('ai', text);
            // chatHistory is not available here
        } catch (err) {
            UIController.clearStatus();
            UIController.addMessage('ai', `Instant answer failed: ${err.message}`);
            // chatHistory is not available here
        }
        UIController.clearStatus();
    }
}; 