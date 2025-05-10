/**
 * ./js/tool-orchestrator.js
 * Tool Orchestrator Module - Handles tool calls and tool call history
 * Extracted from chat-controller.js for modularity and separation of concerns
 */
const ToolOrchestrator = (function() {
    'use strict';

    /**
     * Tool call history (private)
     * @type {Array<{tool: string, args: object, timestamp: string}>}
     */
    let toolCallHistory = [];
    const MAX_TOOL_CALL_REPEAT = 3;
    let lastToolCall = null;
    let lastToolCallCount = 0;

    /**
     * Registry of tool handlers (to be injected via context)
     * @type {Object<string, Function>}
     */
    let toolHandlers = {};

    /**
     * Initializes the tool orchestrator with handlers
     * @param {Object} handlers - Tool handler functions keyed by tool name
     */
    function init(handlers) {
        toolHandlers = handlers;
    }

    /**
     * Processes a tool call using the provided context
     * @param {Object} call - The tool call object { tool, arguments, skipContinue }
     * @param {Object} context - State/context needed for tool execution
     * @returns {Promise<void>}
     */
    async function processToolCall(call, context) {
        const { tool, arguments: args, skipContinue } = call;
        // Tool call loop protection
        const callSignature = JSON.stringify({ tool, args });
        if (lastToolCall === callSignature) {
            lastToolCallCount++;
        } else {
            lastToolCall = callSignature;
            lastToolCallCount = 1;
        }
        if (lastToolCallCount > MAX_TOOL_CALL_REPEAT) {
            context.UIController.addMessage('ai', `Error: Tool call loop detected. The same tool call has been made more than ${MAX_TOOL_CALL_REPEAT} times in a row. Stopping to prevent infinite loop.`);
            return;
        }
        // Log tool call
        toolCallHistory.push({ tool, args, timestamp: new Date().toISOString() });
        await toolHandlers[tool](args, context);
        // Only continue reasoning if the last AI reply was NOT a tool call
        if (!skipContinue) {
            const lastEntry = context.chatHistory[context.chatHistory.length - 1];
            let isToolCall = false;
            if (lastEntry && typeof lastEntry.content === 'string') {
                try {
                    const parsed = JSON.parse(lastEntry.content);
                    if (parsed.tool && parsed.arguments) {
                        isToolCall = true;
                    }
                } catch {}
            }
            if (!isToolCall) {
                const selectedModel = context.SettingsController.getSettings().selectedModel;
                if (selectedModel.startsWith('gpt')) {
                    await context.handleOpenAIMessage(selectedModel, '', context);
                } else {
                    await context.handleGeminiMessage(selectedModel, '', context);
                }
            } else {
                context.UIController.addMessage('ai', 'Warning: AI outputted another tool call without reasoning. Stopping to prevent infinite loop.');
            }
        }
    }

    /**
     * Returns a copy of the tool call history
     * @returns {Array}
     */
    function getToolCallHistory() {
        return [...toolCallHistory];
    }

    return {
        init,
        processToolCall,
        getToolCallHistory
    };
})(); 