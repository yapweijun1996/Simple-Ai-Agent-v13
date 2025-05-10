// gemini-adapter.js
// Adapter for Gemini models

import ApiService from '../../api-service.js';

/**
 * Runs the Gemini model with the given input and context.
 * @param {object} input - The input for the model
 * @param {object} context - Additional context (history, tool results, etc.)
 * @returns {Promise<object>} - Model output and status
 */
export async function runModel(input, context) {
    // input: { message, model }
    // context: { chatHistory }
    const { message, model } = input;
    const { chatHistory } = context;
    try {
        const session = ApiService.createGeminiSession(model);
        const result = await session.sendMessage(message, chatHistory || [{ role: 'user', content: message }]);
        const candidate = result.candidates && result.candidates[0];
        let reply = '';
        if (candidate && candidate.content && candidate.content.parts) {
            reply = candidate.content.parts.map(p => p.text).join(' ');
        } else if (candidate && candidate.content && candidate.content.text) {
            reply = candidate.content.text;
        }
        return {
            output: reply || null,
            isFinal: true
        };
    } catch (err) {
        return {
            output: 'Error: ' + err.message,
            isFinal: true
        };
    }
} 