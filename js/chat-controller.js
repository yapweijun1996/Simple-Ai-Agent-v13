/**
 * ./js/chat-controller.js
 * Chat Controller Module - Manages chat history and message handling
 * Coordinates between UI and API service for sending/receiving messages
 */
import { createToolHandlers } from './tool-handlers.js';
import { extractToolCall, splitIntoBatches } from './utils.js';
import {
    getChatHistory, setChatHistory, addChatMessage,
    getTotalTokens, setTotalTokens, incrementTotalTokens,
    getSettings, setSettings
} from './chat-state.js';
import { summarizeSnippets, synthesizeFinalAnswer } from './chat-summarization.js';
import { UIController } from './ui-controller.js';
import { ToolsService } from './tools-service.js';

const ChatController = (function() {
    'use strict';

    // Private state
    let isThinking = false;
    let lastThinkingContent = '';
    let lastAnswerContent = '';
    let readSnippets = [];
    let lastToolCall = null;
    let lastToolCallCount = 0;
    const MAX_TOOL_CALL_REPEAT = 3;
    let lastSearchResults = [];
    let autoReadInProgress = false;
    let toolCallHistory = [];
    let highlightedResultIndices = new Set();
    // Add a cache for read_url results
    const readCache = new Map();
    // Store the original user question for use in final answer synthesis
    let originalUserQuestion = '';
    // Add a flag to control tool workflow
    let toolWorkflowActive = true;

    const cotPreamble = `**Chain of Thought Instructions:**
1.  **Understand:** Briefly rephrase the core problem or question.
2.  **Deconstruct:** Break the problem down into smaller, logical steps needed to reach the solution.
3.  **Execute & Explain:** Work through each step sequentially. Show your reasoning, calculations, or data analysis for each step clearly.
4.  **Synthesize:** Combine the findings from the previous steps to formulate the final conclusion.
5.  **Final Answer:** State the final answer clearly and concisely, prefixed exactly with "\nFinal Answer:".

**Important:** After each tool call, you must reason with the results before making another tool call. Do NOT output multiple tool calls in a row. If you need to use another tool, first explain what you learned from the previous tool result, then decide if another tool call is needed.

Begin Reasoning Now:
`;

    /**
     * Initializes the chat controller
     * @param {Object} initialSettings - Initial settings for the chat
     */
    function init(initialSettings) {
        // Reset and seed chatHistory with system tool instructions
        setChatHistory([{
            role: 'system',
            content: `You are an AI assistant with access to three external tools. You MUST use these tools to answer any question that requires up-to-date facts, statistics, or detailed content. Do NOT attempt to answer such questions from your own knowledge. The tools are:

1. web_search(query) → returns a JSON array of search results [{title, url, snippet}, …]
2. read_url(url[, start, length]) → returns the text content of a web page from position 'start' (default 0) up to 'length' characters (default 1122)
3. instant_answer(query) → returns a JSON object from DuckDuckGo's Instant Answer API for quick facts, definitions, and summaries (no proxies needed)

**INSTRUCTIONS:**
- If you need information from the web, you MUST output a tool call as a single JSON object, and NOTHING else. Do NOT include any explanation, markdown, or extra text.
- After receiving a tool result, reason step by step (Chain of Thought) and decide if you need to call another tool. If so, output another tool call JSON. Only provide your final answer after all necessary tool calls are complete.
- If you need to read a web page, use read_url. If the snippet ends with an ellipsis ("..."), always determine if fetching more text will improve your answer. If so, output another read_url tool call with the same url, start at your previous offset, and length set to 5000. Repeat until you have enough content.
- If you do NOT know the answer, or are unsure, ALWAYS call a tool first.
- When calling a tool, output EXACTLY a JSON object and nothing else, in this format:
  {"tool":"web_search","arguments":{"query":"your query"}}
  {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}
  {"tool":"instant_answer","arguments":{"query":"your query"}}
- Do NOT output any other text, markdown, or explanation with the tool call JSON.
- After receiving the tool result, continue reasoning step by step and then provide your answer.

**EXAMPLES:**
Q: What is the latest news about OpenAI?
A: {"tool":"web_search","arguments":{"query":"latest news about OpenAI"}}

Q: Read the content of https://example.com and summarize it.
A: {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}

Q: What is the capital of France?
A: {"tool":"instant_answer","arguments":{"query":"capital of France"}}

If you understand, follow these instructions for every relevant question. Do NOT answer from your own knowledge if a tool call is needed. Wait for the tool result before continuing.`,
        }]);
        if (initialSettings) {
            setSettings({ ...getSettings(), ...initialSettings });
        }
        
        // Set up event handlers through UI controller
        UIController.setupEventHandlers(sendMessage, clearChat);

        // Create toolHandlers with dependencies
        const toolHandlers = createToolHandlers({ UIController, ToolsService, processToolCall });
    }

    /**
     * Updates the settings
     * @param {Object} newSettings - The new settings
     */
    function updateSettings(newSettings) {
        setSettings({ ...getSettings(), ...newSettings });
        console.log('Chat settings updated:', getSettings());
    }

    /**
     * Clears the chat history and resets token count
     */
    function clearChat() {
        setChatHistory([]);
        setTotalTokens(0);
        Utils.updateTokenDisplay(0);
    }

    /**
     * Gets the current settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return getSettings();
    }

    /**
     * Generates Chain of Thought prompting instructions
     * @param {string} message - The user message
     * @returns {string} - The CoT enhanced message
     */
    function enhanceWithCoT(message) {
        return `${message}\n\nI'd like you to use Chain of Thought reasoning. Please think step-by-step before providing your final answer. Format your response like this:
Thinking: [detailed reasoning process, exploring different angles and considerations]
Answer: [your final, concise answer based on the reasoning above]`;
    }

    /**
     * Processes the AI response to extract thinking and answer parts
     * @param {string} response - The raw AI response
     * @returns {Object} - Object with thinking and answer components
     */
    function processCoTResponse(response) {
        console.log("processCoTResponse received:", response);
        // Check if response follows the Thinking/Answer format
        const thinkingMatch = response.match(/Thinking:(.*?)(?=Answer:|$)/s);
        const answerMatch = response.match(/Answer:(.*?)$/s);
        console.log("processCoTResponse: thinkingMatch", thinkingMatch, "answerMatch", answerMatch);
        
        if (thinkingMatch && answerMatch) {
            const thinking = thinkingMatch[1].trim();
            const answer = answerMatch[1].trim();
            
            // Update the last known content
            lastThinkingContent = thinking;
            lastAnswerContent = answer;
            
            return {
                thinking: thinking,
                answer: answer,
                hasStructuredResponse: true
            };
        } else if (response.startsWith('Thinking:') && !response.includes('Answer:')) {
            // Partial thinking (no answer yet)
            const thinking = response.replace(/^Thinking:/, '').trim();
            lastThinkingContent = thinking;
            
            return {
                thinking: thinking,
                answer: lastAnswerContent,
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        } else if (response.includes('Thinking:') && !thinkingMatch) {
            // Malformed response (partial reasoning)
            const thinking = response.replace(/^.*?Thinking:/s, 'Thinking:');
            
            return {
                thinking: thinking.replace(/^Thinking:/, '').trim(),
                answer: '',
                hasStructuredResponse: false,
                partial: true
            };
        }
        
        // If not properly formatted, return the whole response as the answer
        return {
            thinking: '',
            answer: response,
            hasStructuredResponse: false
        };
    }
    
    /**
     * Extract and update partial CoT response during streaming
     * @param {string} fullText - The current streamed text
     * @returns {Object} - The processed response object
     */
    function processPartialCoTResponse(fullText) {
        console.log("processPartialCoTResponse received:", fullText);
        if (fullText.includes('Thinking:') && !fullText.includes('Answer:')) {
            // Only thinking so far
            const thinking = fullText.replace(/^.*?Thinking:/s, '').trim();
            
            return {
                thinking: thinking,
                answer: '',
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        } else if (fullText.includes('Thinking:') && fullText.includes('Answer:')) {
            // Both thinking and answer are present
            const thinkingMatch = fullText.match(/Thinking:(.*?)(?=Answer:|$)/s);
            const answerMatch = fullText.match(/Answer:(.*?)$/s);
            
            if (thinkingMatch && answerMatch) {
                return {
                    thinking: thinkingMatch[1].trim(),
                    answer: answerMatch[1].trim(),
                    hasStructuredResponse: true,
                    partial: false
                };
            }
        }
        
        // Default case - treat as normal text
        return {
            thinking: '',
            answer: fullText,
            hasStructuredResponse: false
        };
    }

    /**
     * Formats the response for display based on settings
     * @param {Object} processed - The processed response with thinking and answer
     * @returns {string} - The formatted response for display
     */
    function formatResponseForDisplay(processed) {
        if (!getSettings().enableCoT || !processed.hasStructuredResponse) {
            return processed.answer;
        }

        // If showThinking is enabled, show both thinking and answer
        if (getSettings().showThinking) {
            if (processed.partial && processed.stage === 'thinking') {
                return `Thinking: ${processed.thinking}`;
            } else if (processed.partial) {
                return processed.thinking; // Just the partial thinking
            } else {
                return `Thinking: ${processed.thinking}\n\nAnswer: ${processed.answer}`;
            }
        } else {
            // Otherwise just show the answer (or thinking indicator if answer isn't ready)
            return processed.answer || '🤔 Thinking...';
        }
    }

    /**
     * Sends a message to the AI and handles the response
     */
    async function sendMessage() {
        const message = UIController.getUserInput();
        if (!message) return;
        originalUserQuestion = message;
        toolWorkflowActive = true;
        
        // Show status and disable inputs while awaiting AI
        UIController.showStatus('Sending message...');
        document.getElementById('message-input').disabled = true;
        document.getElementById('send-button').disabled = true;
        
        // Reset the partial response tracking
        lastThinkingContent = '';
        lastAnswerContent = '';
        
        // Add user message to UI
        UIController.addMessage('user', message);
        UIController.clearUserInput();
        
        // Apply CoT formatting if enabled
        const enhancedMessage = getSettings().enableCoT ? enhanceWithCoT(message) : message;
        
        // Get the selected model from SettingsController
        const currentSettings = SettingsController.getSettings();
        const selectedModel = currentSettings.selectedModel;
        
        try {
            if (selectedModel.startsWith('gpt')) {
                // For OpenAI, add enhanced message to chat history before sending to include the CoT prompt.
                addChatMessage({ role: 'user', content: enhancedMessage });
                console.log("Sent enhanced message to GPT:", enhancedMessage);
                await handleOpenAIMessage(selectedModel, enhancedMessage);
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                // For Gemini, ensure chat history starts with user message if empty
                if (getChatHistory().length === 0) {
                    addChatMessage({ role: 'user', content: '' });
                }
                await handleGeminiMessage(selectedModel, enhancedMessage);
            }
        } catch (error) {
            console.error('Error sending message:', error);
            UIController.addMessage('ai', 'Error: ' + error.message);
        } finally {
            // Update token usage display
            Utils.updateTokenDisplay(getTotalTokens());
            // Clear status and re-enable inputs
            UIController.clearStatus();
            document.getElementById('message-input').disabled = false;
            document.getElementById('send-button').disabled = false;
        }
    }

    /**
     * Handles OpenAI message processing
     * @param {string} model - The OpenAI model to use
     * @param {string} message - The user message
     */
    async function handleOpenAIMessage(model, message) {
        if (getSettings().streaming) {
            // Show status for streaming response
            UIController.showStatus('Streaming response...');
            // Streaming approach
            const aiMsgElement = UIController.createEmptyAIMessage();
            let streamedResponse = '';
            
            try {
                // Start thinking indicator if CoT is enabled
                if (getSettings().enableCoT) {
                    isThinking = true;
                    UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
                }
                
                // Process streaming response
                const fullReply = await ApiService.streamOpenAIRequest(
                    model, 
                    getChatHistory(),
                    (chunk, fullText) => {
                        streamedResponse = fullText;
                        
                        if (getSettings().enableCoT) {
                            // Process the streamed response for CoT
                            const processed = processPartialCoTResponse(fullText);
                            
                            // Only show "Thinking..." if we're still waiting
                            if (isThinking && fullText.includes('Answer:')) {
                                isThinking = false;
                            }
                            
                            // Format according to current stage and settings
                            const displayText = formatResponseForDisplay(processed);
                            UIController.updateMessageContent(aiMsgElement, displayText);
                        } else {
                            UIController.updateMessageContent(aiMsgElement, fullText);
                        }
                    }
                );
                
                // Intercept JSON tool call in streaming mode
                const toolCall = extractToolCall(fullReply);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                // Process response for CoT if enabled
                if (getSettings().enableCoT) {
                    const processed = processCoTResponse(fullReply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Update UI with appropriate content based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.updateMessageContent(aiMsgElement, displayText);
                    
                    // Add full response to chat history
                    addChatMessage({ role: 'assistant', content: fullReply });
                } else {
                    // Add to chat history after completed
                    addChatMessage({ role: 'assistant', content: fullReply });
                }
                
                // Get token usage
                const tokenCount = await ApiService.getTokenUsage(model, getChatHistory());
                if (tokenCount) {
                    setTotalTokens(getTotalTokens() + tokenCount);
                }
            } catch (err) {
                UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message);
                throw err;
            } finally {
                isThinking = false;
            }
        } else {
            // Show status for non-streaming response
            UIController.showStatus('Waiting for AI response...');
            // Non-streaming approach
            try {
                const result = await ApiService.sendOpenAIRequest(model, getChatHistory());
                
                if (result.error) {
                    throw new Error(result.error.message);
                }
                
                // Update token usage
                if (result.usage && result.usage.total_tokens) {
                    setTotalTokens(getTotalTokens() + result.usage.total_tokens);
                }
                
                // Process response
                const reply = result.choices[0].message.content;
                console.log("GPT non-streaming reply:", reply);

                // Intercept tool call JSON
                const toolCall = extractToolCall(reply);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                if (getSettings().enableCoT) {
                    const processed = processCoTResponse(reply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Add the full response to chat history
                    addChatMessage({ role: 'assistant', content: reply });
                    
                    // Show appropriate content in the UI based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.addMessage('ai', displayText);
                } else {
                    addChatMessage({ role: 'assistant', content: reply });
                    UIController.addMessage('ai', reply);
                }
            } catch (err) {
                throw err;
            }
        }
    }

    /**
     * Handles Gemini message processing
     * @param {string} model - The Gemini model to use
     * @param {string} message - The user message
     */
    async function handleGeminiMessage(model, message) {
        // Add current message to chat history
        addChatMessage({ role: 'user', content: message });
        
        if (getSettings().streaming) {
            // Streaming approach
            const aiMsgElement = UIController.createEmptyAIMessage();
            let streamedResponse = '';
            
            try {
                // Start thinking indicator if CoT is enabled
                if (getSettings().enableCoT) {
                    isThinking = true;
                    UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
                }
                
                // Process streaming response
                const fullReply = await ApiService.streamGeminiRequest(
                    model,
                    getChatHistory(),
                    (chunk, fullText) => {
                        streamedResponse = fullText;
                        
                        if (getSettings().enableCoT) {
                            // Process the streamed response for CoT
                            const processed = processPartialCoTResponse(fullText);
                            
                            // Only show "Thinking..." if we're still waiting
                            if (isThinking && fullText.includes('Answer:')) {
                                isThinking = false;
                            }
                            
                            // Format according to current stage and settings
                            const displayText = formatResponseForDisplay(processed);
                            UIController.updateMessageContent(aiMsgElement, displayText);
                        } else {
                            UIController.updateMessageContent(aiMsgElement, fullText);
                        }
                    }
                );
                
                // Intercept JSON tool call in streaming mode
                const toolCall = extractToolCall(fullReply);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                // Process response for CoT if enabled
                if (getSettings().enableCoT) {
                    const processed = processCoTResponse(fullReply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Update UI with appropriate content based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.updateMessageContent(aiMsgElement, displayText);
                    
                    // Add full response to chat history
                    addChatMessage({ role: 'assistant', content: fullReply });
                } else {
                    // Add to chat history after completed
                    addChatMessage({ role: 'assistant', content: fullReply });
                }
                
                // Get token usage
                const tokenCount = await ApiService.getTokenUsage(model, getChatHistory());
                if (tokenCount) {
                    setTotalTokens(getTotalTokens() + tokenCount);
                }
            } catch (err) {
                UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message);
                throw err;
            } finally {
                isThinking = false;
            }
        } else {
            // Non-streaming approach
            try {
                const session = ApiService.createGeminiSession(model);
                const result = await session.sendMessage(message, getChatHistory());
                
                // Update token usage if available
                if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                    setTotalTokens(getTotalTokens() + result.usageMetadata.totalTokenCount);
                }
                
                // Process response
                const candidate = result.candidates[0];
                let textResponse = '';
                
                if (candidate.content.parts) {
                    textResponse = candidate.content.parts.map(p => p.text).join(' ');
                } else if (candidate.content.text) {
                    textResponse = candidate.content.text;
                }
                
                // Intercept tool call JSON
                const toolCall = extractToolCall(textResponse);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                if (getSettings().enableCoT) {
                    const processed = processCoTResponse(textResponse);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Add the full response to chat history
                    addChatMessage({ role: 'assistant', content: textResponse });
                    
                    // Show appropriate content in the UI based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.addMessage('ai', displayText);
                } else {
                    addChatMessage({ role: 'assistant', content: textResponse });
                    UIController.addMessage('ai', textResponse);
                }
            } catch (err) {
                throw err;
            }
        }
    }

    // Enhanced processToolCall using registry and validation
    async function processToolCall(call) {
        if (!toolWorkflowActive) return;
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
            UIController.addMessage('ai', `Error: Tool call loop detected. The same tool call has been made more than ${MAX_TOOL_CALL_REPEAT} times in a row. Stopping to prevent infinite loop.`);
            return;
        }
        // Log tool call
        toolCallHistory.push({ tool, args, timestamp: new Date().toISOString() });
        await toolHandlers[tool](args);
        // Only continue reasoning if the last AI reply was NOT a tool call
        if (!skipContinue) {
            const lastEntry = getChatHistory()[getChatHistory().length - 1];
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
                const selectedModel = SettingsController.getSettings().selectedModel;
                if (selectedModel.startsWith('gpt')) {
                    await handleOpenAIMessage(selectedModel, '');
                } else {
                    await handleGeminiMessage(selectedModel, '');
                }
            } else {
                UIController.addMessage('ai', 'Warning: AI outputted another tool call without reasoning. Stopping to prevent infinite loop.');
            }
        }
    }

    /**
     * Gets the current chat history
     * @returns {Array} - The chat history
     */
    function getChatHistory() {
        return [...getChatHistory()];
    }

    /**
     * Gets the total tokens used
     * @returns {number} - The total tokens used
     */
    function getTotalTokens() {
        return getTotalTokens();
    }

    // Helper: AI-driven deep reading for a URL
    async function deepReadUrl(url, maxChunks = 5, chunkSize = 2000, maxTotalLength = 10000) {
        let allChunks = [];
        let start = 0;
        let shouldContinue = true;
        let chunkCount = 0;
        let totalLength = 0;
        while (shouldContinue && chunkCount < maxChunks && totalLength < maxTotalLength) {
            // Check cache first
            const cacheKey = `${url}:${start}:${chunkSize}`;
            let snippet;
            if (readCache.has(cacheKey)) {
                snippet = readCache.get(cacheKey);
            } else {
                await processToolCall({ tool: 'read_url', arguments: { url, start, length: chunkSize }, skipContinue: true });
                // Find the last snippet added to chatHistory
                const lastEntry = getChatHistory()[getChatHistory().length - 1];
                if (lastEntry && typeof lastEntry.content === 'string' && lastEntry.content.startsWith('Read content from')) {
                    snippet = lastEntry.content.split('\n').slice(1).join('\n');
                    readCache.set(cacheKey, snippet);
                } else {
                    snippet = '';
                }
            }
            if (!snippet) break;
            allChunks.push(snippet);
            totalLength += snippet.length;
            // Ask AI if more is needed
            const selectedModel = SettingsController.getSettings().selectedModel;
            let aiReply = '';
            try {
                const prompt = `Given the following snippet from ${url}, do you need more content to answer the user's question? Please reply with \"YES\" or \"NO\" and a brief reason. If YES, estimate how many more characters you need.\n\nSnippet:\n${snippet}`;
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that decides if more content is needed from a web page.' },
                        { role: 'user', content: prompt }
                    ]);
                    aiReply = res.choices[0].message.content.trim().toLowerCase();
                }
            } catch (err) {
                // On error, stop deep reading
                shouldContinue = false;
                break;
            }
            if (aiReply.startsWith('yes') && totalLength < maxTotalLength) {
                start += chunkSize;
                chunkCount++;
                shouldContinue = true;
            } else {
                shouldContinue = false;
            }
        }
        return allChunks;
    }

    // Autonomous follow-up: after AI suggests which results to read, auto-read and summarize
    async function autoReadAndSummarizeFromSuggestion(aiReply) {
        if (autoReadInProgress) return; // Prevent overlap
        if (!lastSearchResults || !Array.isArray(lastSearchResults) || !lastSearchResults.length) return;
        // Parse numbers from AI reply (e.g., "3,5,7,9,10")
        const match = aiReply.match(/([\d, ]+)/);
        if (!match) return;
        const nums = match[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (!nums.length) return;
        // Store highlighted indices (0-based)
        highlightedResultIndices = new Set(nums.map(n => n - 1));
        // Map numbers to URLs (1-based index)
        const urlsToRead = nums.map(n => lastSearchResults[n-1]?.url).filter(Boolean);
        if (!urlsToRead.length) return;
        autoReadInProgress = true;
        try {
            for (let i = 0; i < urlsToRead.length; i++) {
                const url = urlsToRead[i];
                UIController.showSpinner(`Reading ${i + 1} of ${urlsToRead.length} URLs: ${url}...`);
                await deepReadUrl(url, 5, 2000);
            }
            // After all reads, auto-summarize
            await summarizeSnippets(readSnippets);
        } finally {
            autoReadInProgress = false;
        }
    }

    // Suggestion logic: ask AI which results to read
    async function suggestResultsToRead(results, query) {
        if (!results || results.length === 0) return;
        const prompt = `Given these search results for the query: "${query}", which results (by number) are most relevant to read in detail?\n\n${results.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join('\n')}\n\nReply with a comma-separated list of result numbers.`;
        const selectedModel = SettingsController.getSettings().selectedModel;
        let aiReply = '';
        try {
            if (selectedModel.startsWith('gpt')) {
                const res = await ApiService.sendOpenAIRequest(selectedModel, [
                    { role: 'system', content: 'You are an assistant helping to select the most relevant search results.' },
                    { role: 'user', content: prompt }
                ]);
                aiReply = res.choices[0].message.content.trim();
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                const session = ApiService.createGeminiSession(selectedModel);
                const chatHistory = [
                    { role: 'system', content: 'You are an assistant helping to select the most relevant search results.' },
                    { role: 'user', content: prompt }
                ];
                const result = await session.sendMessage(prompt, chatHistory);
                const candidate = result.candidates[0];
                if (candidate.content.parts) {
                    aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                } else if (candidate.content.text) {
                    aiReply = candidate.content.text.trim();
                }
            }
            // Optionally, parse and highlight suggested results
            if (aiReply) {
                UIController.addMessage('ai', `AI suggests reading results: ${aiReply}`);
                // Autonomous follow-up: auto-read and summarize
                await autoReadAndSummarizeFromSuggestion(aiReply);
            }
        } catch (err) {
            // Ignore suggestion errors
        }
    }

    // Public API
    return {
        init,
        updateSettings,
        getSettings,
        sendMessage,
        getChatHistory,
        getTotalTokens,
        clearChat,
        processToolCall,
        getToolCallHistory: () => [...toolCallHistory],
    };
})(); 