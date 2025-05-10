// index.js
// Exports all model adapters and provides a selector

import * as gptAdapter from './gpt-adapter.js';
import * as geminiAdapter from './gemini-adapter.js';
import * as gemmaAdapter from './gemma-adapter.js';

/**
 * Returns the correct model adapter based on the model name.
 * @param {string} modelName
 */
export function getModelAdapter(modelName) {
    if (modelName.startsWith('gpt')) return gptAdapter;
    if (modelName.startsWith('gemini')) return geminiAdapter;
    if (modelName.startsWith('gemma')) return gemmaAdapter;
    throw new Error('Unknown model: ' + modelName);
} 