// gpt-adapter.js
// Adapter for GPT models

import ApiService from '../../api-service.js';

/**
 * Runs the GPT model with the given input and context.
 * @param {object} input - The input for the model
 * @param {object} context - Additional context (history, tool results, etc.)
 * @returns {Promise<object>} - Model output and status
 */
export async function runModel(input, context) {
    // input: { message, model }
    // context: { chatHistory }
    const { message, model } = input;
    const { chatHistory } = context;
    // Prepare messages for OpenAI API
    const messages = chatHistory && chatHistory.length ? chatHistory : [
        { role: 'user', content: message }
    ];
    try {
        const result = await ApiService.sendOpenAIRequest(model, messages);
        const reply = result.choices && result.choices[0] && result.choices[0].message.content;
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