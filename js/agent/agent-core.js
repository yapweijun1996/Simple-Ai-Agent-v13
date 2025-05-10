// agent-core.js
// Central workflow engine for the AI agent

import { getModelAdapter } from './model-adapters/index.js';
import { runTool } from './tools/index.js';

/**
 * Handles a user message by orchestrating tool use and model reasoning.
 * @param {string} message - The user's message
 * @param {object} settings - Current settings (model, options, etc.)
 * @param {object} state - App state (history, etc.)
 * @returns {Promise<object>} - Reasoning steps and final answer
 */
export async function handleUserMessage(message, settings, state) {
    // 1. Select model adapter
    const modelName = settings.selectedModel;
    const adapter = getModelAdapter(modelName);
    // 2. Prepare input/context
    const input = { message, model: modelName };
    const context = { chatHistory: state.chatHistory };
    // 3. Call model adapter
    const result = await adapter.runModel(input, context);
    // 4. Return reasoning steps and final answer
    return {
        reasoningSteps: [
            { type: 'model', model: modelName, output: result.output }
        ],
        finalAnswer: result.output
    };
}

// Helper: Chain of Thought prompt enhancer
function enhanceWithCoT(message) {
    return `${message}\n\nI'd like you to use Chain of Thought reasoning. Please think step-by-step before providing your final answer. Format your response like this:\nThinking: [detailed reasoning process, exploring different angles and considerations]\nAnswer: [your final, concise answer based on the reasoning above]`;
} 