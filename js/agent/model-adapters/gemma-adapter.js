// gemma-adapter.js
// Adapter for Gemma models

import ApiService from '../../api-service.js';

/**
 * Runs the Gemma model with the given input and context.
 * @param {object} input - The input for the model
 * @param {object} context - Additional context (history, tool results, etc.)
 * @returns {Promise<object>} - Model output and status
 */
export async function runModel(input, context) {
    return {
        output: 'Gemma model is not yet implemented in this app.',
        isFinal: true
    };
} 