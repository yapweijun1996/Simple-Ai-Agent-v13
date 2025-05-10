/**
 * ./js/chat-controller.js
 * Chat Controller Module - Manages chat history and message handling
 * Coordinates between UI and API service for sending/receiving messages
 */
const ChatController = (function() {
    'use strict';

    // Private state
    let chatHistory = [];
    let totalTokens = 0;
    let settings = { streaming: false, enableCoT: false, showThinking: true };
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
    let allSearchUrls = new Set();

    // Add helper to robustly extract JSON tool calls (handles markdown fences)
    function extractToolCall(text) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (err) {
            console.warn('Tool JSON parse error:', err, 'from', jsonMatch[0]);
            return null;
        }
    }

    const cotPreamble = `**Chain of Thought Instructions:**
1.  **Understand:** Briefly rephrase the core problem or question.
2.  **Deconstruct:** Break the problem down into smaller, logical steps needed to reach the solution.
3.  **Execute & Explain:** Work through each step sequentially. Show your reasoning, calculations, or data analysis for each step clearly.
4.  **Synthesize:** Combine the findings from the previous steps to formulate the final conclusion.
5.  **Final Answer:** State the final answer clearly and concisely, prefixed exactly with "\nFinal Answer:".

**Important:** After each tool call, you must reason with the results before making another tool call. Do NOT output multiple tool calls in a row. If you need to use another tool, first explain what you learned from the previous tool result, then decide if another tool call is needed.

Begin Reasoning Now:
`;

    // Helper: Assess search result quality using AI
    async function assessSearchQuality(results, userQuery) {
        const prompt = `Given these search results for the query: "${userQuery}", are they relevant and likely to answer the question? Reply YES or NO and a brief reason.\n\n${results.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join('\n')}`;
        const selectedModel = SettingsController.getSettings().selectedModel;
        let aiReply = '';
        if (selectedModel.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                { role: 'system', content: 'You are an assistant that assesses search result quality.' },
                { role: 'user', content: prompt }
            ]);
            aiReply = res.choices[0].message.content.trim().toLowerCase();
        }
        return aiReply.startsWith('yes');
    }

    // Helper: Get a refined query from AI
    async function getRefinedQuery(results, userQuery) {
        const prompt = `The search results for "${userQuery}" were not relevant. Suggest a better search query to find more relevant information.`;
        const selectedModel = SettingsController.getSettings().selectedModel;
        let aiReply = '';
        if (selectedModel.startsWith('gpt')) {
            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                { role: 'system', content: 'You are an assistant that helps refine search queries.' },
                { role: 'user', content: prompt }
            ]);
            aiReply = res.choices[0].message.content.trim();
        }
        return aiReply;
    }

    // Tool handler registry
    const toolHandlers = {
        web_search: async function(args) {
            let query = args.query;
            if (!query || typeof query !== 'string' || !query.trim()) {
                // Try to recover: use originalUserQuestion or last user message
                if (typeof originalUserQuestion === 'string' && originalUserQuestion.trim()) {
                    query = originalUserQuestion;
                    console.log('web_search: Recovered query from originalUserQuestion:', query);
                } else if (chatHistory && chatHistory.length) {
                    // Find last user message
                    for (let i = chatHistory.length - 1; i >= 0; i--) {
                        if (chatHistory[i].role === 'user' && chatHistory[i].content && chatHistory[i].content.trim()) {
                            query = chatHistory[i].content;
                            console.log('web_search: Recovered query from chatHistory:', query);
                            break;
                        }
                    }
                }
            }
            if (!query || typeof query !== 'string' || !query.trim()) {
                console.warn('web_search: Could not recover a valid query. Aborting web search. Args:', args);
                UIController.addMessage('ai', 'Error: No valid search query could be determined. Please rephrase your question.');
                return;
            }
            const engine = args.engine || 'duckduckgo';
            let results = [];
            let retries = 0;
            const maxRetries = 2;
            let allResults = [];
            allSearchUrls = new Set(); // Reset for this search session
            let searchFailed = false;

            while (retries <= maxRetries) {
                UIController.showSpinner(`Searching (${engine}) for "${query}"...`);
                UIController.showStatus(`Searching (${engine}) for "${query}"...`);
                try {
                    results = await ToolsService.webSearch(query, (result) => {
                        if (result.url) allSearchUrls.add(result.url);
                        UIController.addSearchResult(result, (url) => {
                            processToolCall({ tool: 'read_url', arguments: { url, start: 0, length: 1122 } });
                        });
                    }, engine);
                } catch (err) {
                    UIController.addMessage('ai', `Web search failed for "${query}": ${err.message || err}`);
                    searchFailed = true;
                    break;
                }

                allResults = allResults.concat(results);

                if (!results.length) {
                    UIController.addMessage('ai', `No search results found for "${query}".`);
                    break;
                }

                // Assess quality
                const isGood = await assessSearchQuality(results, query);
                if (isGood) {
                    break;
                } else if (retries < maxRetries) {
                    query = await getRefinedQuery(results, query);
                    retries++;
                    continue;
                } else {
                    UIController.addMessage('ai', `Search results for "${args.query}" were not relevant after ${maxRetries+1} attempts.`);
                    break;
                }
            }

            if (allSearchUrls.size > 0) {
                UIController.addMessage('ai', `Collected the following URLs for further reading:\n${[...allSearchUrls].join('\n')}`);
            }

            lastSearchResults = allResults;
            UIController.hideSpinner();
            UIController.clearStatus();

            // Fallback: If search failed, let the AI try to answer with what it knows
            if (searchFailed || !allResults.length) {
                UIController.addMessage('ai', 'Web search failed. I will try to answer your question based on the information I already have.');
                const selectedModel = SettingsController.getSettings().selectedModel;
                let contextMessage = '';
                if (readSnippets && readSnippets.length) {
                    try {
                        UIController.showSpinner('Summarizing retrieved information before answering...');
                        let summary = '';
                        const userQuestion = query;
                        if (selectedModel.startsWith('gpt')) {
                            const prompt = `Given the following information retrieved from the web, extract and summarize all facts and details that are most relevant to answering this question. Present the information concisely, preferably in bullet points or a table if appropriate.\n\nQuestion: ${userQuestion}\n\nInformation:\n${readSnippets.join('\n---\n')}\n\nPlease provide a concise, fact-focused summary that will help answer the question above.`;
                            const res = await ApiService.sendOpenAIRequest(selectedModel, [
                                { role: 'system', content: 'You are an assistant that summarizes information for later use.' },
                                { role: 'user', content: prompt }
                            ]);
                            summary = res.choices[0].message.content.trim();
                        } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                            const session = ApiService.createGeminiSession(selectedModel);
                            const prompt = `Given the following information retrieved from the web, extract and summarize all facts and details that are most relevant to answering this question. Present the information concisely, preferably in bullet points or a table if appropriate.\n\nQuestion: ${userQuestion}\n\nInformation:\n${readSnippets.join('\n---\n')}\n\nPlease provide a concise, fact-focused summary that will help answer the question above.`;
                            const chatHistory = [
                                { role: 'system', content: 'You are an assistant that summarizes information for later use.' },
                                { role: 'user', content: prompt }
                            ];
                            const result = await session.sendMessage(prompt, chatHistory);
                            const candidate = result.candidates[0];
                            if (candidate.content.parts) {
                                summary = candidate.content.parts.map(p => p.text).join(' ').trim();
                            } else if (candidate.content.text) {
                                summary = candidate.content.text.trim();
                            }
                        }
                        UIController.hideSpinner();
                        contextMessage = `Here is a summary of what I was able to retrieve before the error:\n${summary}\n\n`;
                    } catch (err) {
                        UIController.hideSpinner();
                        contextMessage = `Here is what I was able to retrieve before the error:\n${readSnippets.join('\n---\n')}\n\n`;
                    }
                }
                let urlsMessage = '';
                if (allSearchUrls && allSearchUrls.size) {
                    urlsMessage = `You may also find more details at these links:\n${[...allSearchUrls].join('\n')}\n\n`;
                }
                const fallbackPrompt =
`I'm unable to access live web results right now due to technical issues with all search tools.\n\n${contextMessage}${urlsMessage}Based on the information above and my own knowledge, here is my best attempt to answer your question:\n\nQuestion: ${query}\n\nPlease answer the user's question using the summary above. If you cannot find the answer, say so. If you need more up-to-date or detailed information, you may want to check the links above directly or try again later.`;
                if (selectedModel.startsWith('gpt')) {
                    await handleOpenAIMessage(selectedModel, fallbackPrompt);
                } else {
                    await handleGeminiMessage(selectedModel, fallbackPrompt);
                }
                return;
            }

            await suggestResultsToRead(allResults, query);
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
                const plainTextSnippet = `Read content from ${args.url}:\n${snippet}${hasMore ? '...' : ''}`;
                chatHistory.push({ role: 'assistant', content: plainTextSnippet });
                // Collect snippets for summarization
                readSnippets.push(snippet);
                if (readSnippets.length >= 2) {
                    UIController.addSummarizeButton(() => summarizeSnippets());
                }
            } catch (err) {
                UIController.hideSpinner();
                UIController.addMessage('ai', `Read URL failed: ${err.message}`);
                chatHistory.push({ role: 'assistant', content: `Read URL failed: ${err.message}` });
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
                chatHistory.push({ role: 'assistant', content: text });
            } catch (err) {
                UIController.clearStatus();
                UIController.addMessage('ai', `Instant answer failed: ${err.message}`);
                chatHistory.push({ role: 'assistant', content: `Instant answer failed: ${err.message}` });
            }
            UIController.clearStatus();
        }
    };

    /**
     * Initializes the chat controller
     * @param {Object} initialSettings - Initial settings for the chat
     */
    function init(initialSettings) {
        // Reset and seed chatHistory with system tool instructions
        chatHistory = [{
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
        }];
        if (initialSettings) {
            settings = { ...settings, ...initialSettings };
        }
        
        // Set up event handlers through UI controller
        UIController.setupEventHandlers(sendMessage, clearChat);
    }

    /**
     * Updates the settings
     * @param {Object} newSettings - The new settings
     */
    function updateSettings(newSettings) {
        settings = { ...settings, ...newSettings };
        console.log('Chat settings updated:', settings);
    }

    /**
     * Clears the chat history and resets token count
     */
    function clearChat() {
        chatHistory = [];
        totalTokens = 0;
        Utils.updateTokenDisplay(0);
    }

    /**
     * Gets the current settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return { ...settings };
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
        if (!settings.enableCoT || !processed.hasStructuredResponse) {
            return processed.answer;
        }

        // If showThinking is enabled, show both thinking and answer
        if (settings.showThinking) {
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
        const enhancedMessage = settings.enableCoT ? enhanceWithCoT(message) : message;
        
        // Get the selected model from SettingsController
        const currentSettings = SettingsController.getSettings();
        const selectedModel = currentSettings.selectedModel;
        
        try {
            if (selectedModel.startsWith('gpt')) {
                // For OpenAI, add enhanced message to chat history before sending to include the CoT prompt.
                chatHistory.push({ role: 'user', content: enhancedMessage });
                console.log("Sent enhanced message to GPT:", enhancedMessage);
                await handleOpenAIMessage(selectedModel, enhancedMessage);
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                // For Gemini, ensure chat history starts with user message if empty
                if (chatHistory.length === 0) {
                    chatHistory.push({ role: 'user', content: '' });
                }
                await handleGeminiMessage(selectedModel, enhancedMessage);
            }
        } catch (error) {
            console.error('Error sending message:', error);
            UIController.addMessage('ai', 'Error: ' + error.message);
        } finally {
            // Update token usage display
            Utils.updateTokenDisplay(totalTokens);
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
        if (settings.streaming) {
            // Show status for streaming response
            UIController.showStatus('Streaming response...');
            // Streaming approach
            const aiMsgElement = UIController.createEmptyAIMessage();
            let streamedResponse = '';
            
            try {
                // Start thinking indicator if CoT is enabled
                if (settings.enableCoT) {
                    isThinking = true;
                    UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
                }
                
                // Process streaming response
                const fullReply = await ApiService.streamOpenAIRequest(
                    model, 
                    chatHistory,
                    (chunk, fullText) => {
                        streamedResponse = fullText;
                        
                        if (settings.enableCoT) {
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
                if (settings.enableCoT) {
                    const processed = processCoTResponse(fullReply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Update UI with appropriate content based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.updateMessageContent(aiMsgElement, displayText);
                    
                    // Add full response to chat history
                    chatHistory.push({ role: 'assistant', content: fullReply });
                } else {
                    // Add to chat history after completed
                    chatHistory.push({ role: 'assistant', content: fullReply });
                }
                
                // Get token usage
                const tokenCount = await ApiService.getTokenUsage(model, chatHistory);
                if (tokenCount) {
                    totalTokens += tokenCount;
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
                const result = await ApiService.sendOpenAIRequest(model, chatHistory);
                
                if (result.error) {
                    throw new Error(result.error.message);
                }
                
                // Update token usage
                if (result.usage && result.usage.total_tokens) {
                    totalTokens += result.usage.total_tokens;
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
                
                if (settings.enableCoT) {
                    const processed = processCoTResponse(reply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Add the full response to chat history
                    chatHistory.push({ role: 'assistant', content: reply });
                    
                    // Show appropriate content in the UI based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.addMessage('ai', displayText);
                } else {
                    chatHistory.push({ role: 'assistant', content: reply });
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
        chatHistory.push({ role: 'user', content: message });
        
        if (settings.streaming) {
            // Streaming approach
            const aiMsgElement = UIController.createEmptyAIMessage();
            let streamedResponse = '';
            
            try {
                // Start thinking indicator if CoT is enabled
                if (settings.enableCoT) {
                    isThinking = true;
                    UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
                }
                
                // Process streaming response
                const fullReply = await ApiService.streamGeminiRequest(
                    model,
                    chatHistory,
                    (chunk, fullText) => {
                        streamedResponse = fullText;
                        
                        if (settings.enableCoT) {
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
                if (settings.enableCoT) {
                    const processed = processCoTResponse(fullReply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Update UI with appropriate content based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.updateMessageContent(aiMsgElement, displayText);
                    
                    // Add full response to chat history
                    chatHistory.push({ role: 'assistant', content: fullReply });
                } else {
                    // Add to chat history after completed
                    chatHistory.push({ role: 'assistant', content: fullReply });
                }
                
                // Get token usage
                const tokenCount = await ApiService.getTokenUsage(model, chatHistory);
                if (tokenCount) {
                    totalTokens += tokenCount;
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
                const result = await session.sendMessage(message, chatHistory);
                
                // Update token usage if available
                if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                    totalTokens += result.usageMetadata.totalTokenCount;
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
                
                if (settings.enableCoT) {
                    const processed = processCoTResponse(textResponse);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Add the full response to chat history
                    chatHistory.push({ role: 'assistant', content: textResponse });
                    
                    // Show appropriate content in the UI based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.addMessage('ai', displayText);
                } else {
                    chatHistory.push({ role: 'assistant', content: textResponse });
                    UIController.addMessage('ai', textResponse);
                }
            } catch (err) {
                throw err;
            }
        }
    }

    // Enhanced processToolCall using registry and validation
    async function processToolCall(call) {
        // Debug log for all tool calls
        console.log('processToolCall:', call);
        if (!toolWorkflowActive) return;
        const { tool, arguments: args, skipContinue } = call;
        // Guard: If web_search and query is missing/empty, do not proceed
        if (tool === 'web_search') {
            let q = args && args.query;
            if (!q || typeof q !== 'string' || !q.trim()) {
                console.warn('processToolCall: web_search called with empty query. Skipping tool call. Call:', call);
                UIController.addMessage('ai', 'Error: Web search tool was called with an empty query. Please rephrase your question.');
                return;
            }
        }
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
            const lastEntry = chatHistory[chatHistory.length - 1];
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
                // Use the last user question if message is empty
                let nextMessage = originalUserQuestion;
                if (!nextMessage) {
                    // Fallback: try to get the last user message from chatHistory
                    const lastUser = [...chatHistory].reverse().find(m => m.role === 'user');
                    nextMessage = lastUser ? lastUser.content : '';
                }
                if (selectedModel.startsWith('gpt')) {
                    await handleOpenAIMessage(selectedModel, nextMessage);
                } else {
                    await handleGeminiMessage(selectedModel, nextMessage);
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
        return [...chatHistory];
    }

    /**
     * Gets the total tokens used
     * @returns {number} - The total tokens used
     */
    function getTotalTokens() {
        return totalTokens;
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
                const lastEntry = chatHistory[chatHistory.length - 1];
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
            await summarizeSnippets();
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

    // Helper: Split array of strings into batches where each batch's total length <= maxLen
    function splitIntoBatches(snippets, maxLen) {
        const batches = [];
        let currentBatch = [];
        let currentLen = 0;
        for (const snippet of snippets) {
            if (currentLen + snippet.length > maxLen && currentBatch.length) {
                batches.push(currentBatch);
                currentBatch = [];
                currentLen = 0;
            }
            currentBatch.push(snippet);
            currentLen += snippet.length;
        }
        if (currentBatch.length) {
            batches.push(currentBatch);
        }
        return batches;
    }

    // Summarization logic (recursive, context-aware)
    async function summarizeSnippets(snippets = null, round = 1) {
        if (!snippets) snippets = readSnippets;
        if (!snippets.length) return;
        const selectedModel = SettingsController.getSettings().selectedModel;
        const MAX_PROMPT_LENGTH = 5857; // chars, safe for most models
        const SUMMARIZATION_TIMEOUT = 88000; // 88 seconds
        // If only one snippet, just summarize it directly
        if (snippets.length === 1) {
            const prompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${snippets[0]}`;
            let aiReply = '';
            UIController.showSpinner(`Round ${round}: Summarizing information...`);
            UIController.showStatus(`Round ${round}: Summarizing information...`);
            try {
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: prompt }
                    ], SUMMARIZATION_TIMEOUT);
                    aiReply = res.choices[0].message.content.trim();
                } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                    const session = ApiService.createGeminiSession(selectedModel);
                    const chatHistory = [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
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
                if (aiReply) {
                    UIController.addMessage('ai', `Summary:\n${aiReply}`);
                }
            } catch (err) {
                UIController.addMessage('ai', `Summarization failed. Error: ${err && err.message ? err.message : err}`);
            }
            UIController.hideSpinner();
            UIController.clearStatus();
            readSnippets = [];
            // Prompt for final answer after summary
            await synthesizeFinalAnswer(aiReply);
            return;
        }
        // Otherwise, split into batches
        const batches = splitIntoBatches(snippets, MAX_PROMPT_LENGTH);
        let batchSummaries = [];
        const totalBatches = batches.length;
        try {
            for (let i = 0; i < totalBatches; i++) {
                const batch = batches[i];
                UIController.showSpinner(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`);
                UIController.showStatus(`Round ${round}: Summarizing batch ${i + 1} of ${totalBatches}...`);
                const batchPrompt = `Summarize the following information extracted from web pages (be as concise as possible):\n\n${batch.join('\n---\n')}`;
                let batchReply = '';
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: batchPrompt }
                    ], SUMMARIZATION_TIMEOUT);
                    batchReply = res.choices[0].message.content.trim();
                } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                    const session = ApiService.createGeminiSession(selectedModel);
                    const chatHistory = [
                        { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources.' },
                        { role: 'user', content: batchPrompt }
                    ];
                    const result = await session.sendMessage(batchPrompt, chatHistory);
                    const candidate = result.candidates[0];
                    if (candidate.content.parts) {
                        batchReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                    } else if (candidate.content.text) {
                        batchReply = candidate.content.text.trim();
                    }
                }
                batchSummaries.push(batchReply);
            }
            // If the combined summaries are still too long, recursively summarize
            const combined = batchSummaries.join('\n---\n');
            if (combined.length > MAX_PROMPT_LENGTH) {
                UIController.showSpinner(`Round ${round + 1}: Combining summaries...`);
                UIController.showStatus(`Round ${round + 1}: Combining summaries...`);
                await summarizeSnippets(batchSummaries, round + 1);
            } else {
                UIController.showSpinner(`Round ${round}: Finalizing summary...`);
                UIController.showStatus(`Round ${round}: Finalizing summary...`);
                UIController.addMessage('ai', `Summary:\n${combined}`);
                // Prompt for final answer after all summaries
                await synthesizeFinalAnswer(combined);
            }
        } catch (err) {
            UIController.addMessage('ai', `Summarization failed. Error: ${err && err.message ? err.message : err}`);
        }
        UIController.hideSpinner();
        UIController.clearStatus();
        readSnippets = [];
    }

    // Add synthesizeFinalAnswer helper
    async function synthesizeFinalAnswer(summaries) {
        if (!summaries || !originalUserQuestion) return;
        const selectedModel = SettingsController.getSettings().selectedModel;
        const prompt = `Based on the following summaries, provide a final, concise answer to the original question.\n\nSummaries:\n${summaries}\n\nOriginal question: ${originalUserQuestion}`;
        try {
            let finalAnswer = '';
            if (selectedModel.startsWith('gpt')) {
                const res = await ApiService.sendOpenAIRequest(selectedModel, [
                    { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
                    { role: 'user', content: prompt }
                ]);
                finalAnswer = res.choices[0].message.content.trim();
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                const session = ApiService.createGeminiSession(selectedModel);
                const chatHistory = [
                    { role: 'system', content: 'You are an assistant that synthesizes information from multiple sources and provides a final answer.' },
                    { role: 'user', content: prompt }
                ];
                const result = await session.sendMessage(prompt, chatHistory);
                const candidate = result.candidates[0];
                if (candidate.content.parts) {
                    finalAnswer = candidate.content.parts.map(p => p.text).join(' ').trim();
                } else if (candidate.content.text) {
                    finalAnswer = candidate.content.text.trim();
                }
            }
            if (finalAnswer) {
                UIController.addMessage('ai', `Final Answer:\n${finalAnswer}`);
            }
            // Stop tool workflow after final answer
            toolWorkflowActive = false;
        } catch (err) {
            UIController.addMessage('ai', `Final answer synthesis failed. Error: ${err && err.message ? err.message : err}`);
            toolWorkflowActive = false;
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