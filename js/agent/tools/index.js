// index.js
// Exports all tools and provides a selector

import { webSearch } from './web-search.js';
import { readUrl } from './url-reader.js';

/**
 * Runs the specified tool with the given input.
 * @param {string} toolName
 * @param {any} input
 */
export async function runTool(toolName, input) {
    if (toolName === 'webSearch') return await webSearch(input);
    if (toolName === 'readUrl') return await readUrl(input);
    throw new Error('Unknown tool: ' + toolName);
} 