/**
 * ./js/api-service.js
 * API Service Module - Handles all communication with AI APIs
 * Interfaces with OpenAI and Gemini APIs and manages API keys
 */
const ApiService = (function() {
    'use strict';

    // Private state
    let apiKey = "";
    let geminiApiKey = "";
    
    // Encrypted API keys
    const encryptedOpenAIKey = "069089026066075089092031002003099081098064082125085108093006123109084087069010097094114091115010026093095069126088000107095121083104015115094081116122082001110083091112111031107123125089102075109090007091101098011084093094091081091065125092000095109005116094085089127124065102101117011003125102007070014123126120064002118015101093122067105119090112120113093125081086113122118113001120123011125092085103007086108119119007083119014125015112124106000120087004098124093117090066000116113095081115";
    
    // Gemini decryption
    (function(){
        var _0x1a2b3c = "20250325";
        var _0x4d5e6f = "115121072084099074118106117088090121005073031071112069112077003119122093072123106109115098002002094093126121003069010";
        var _0x7f8g9h = function(_0xabcd){
            var _0x123 = new TextDecoder(), _0x456 = new TextEncoder(), _0x789 = "";
            for(var _0xdef = 0; _0xdef < _0xabcd.length; _0xdef += 3) {
                var _0x101 = _0xabcd.slice(_0xdef, _0xdef + 3);
                var _0x112 = parseInt(_0x101);
                var _0x131 = _0x1a2b3c.charCodeAt((_0xdef / 3) % _0x1a2b3c.length);
                var _0x415 = _0x112 ^ _0x131;
                _0x789 += String.fromCharCode(_0x415);
            }
            return _0x123.decode(new Uint8Array(_0x456.encode(_0x789)));
        };
        geminiApiKey = _0x7f8g9h(_0x4d5e6f);
    })();

    // Gemini API configuration
    const generationConfig = {
        temperature: 1,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        responseMimeType: "text/plain"
    };

    /**
     * Initialize the API service by decrypting the API key
     * @param {string} password - The password to decrypt the API key
     * @returns {boolean} - Whether initialization was successful
     */
    function init(password) {
        if (!password) return false;
        
        try {
            apiKey = Utils.decrypt(encryptedOpenAIKey, password);
            return true;
        } catch (err) {
            console.error('Failed to decrypt API key:', err);
            return false;
        }
    }

    /**
     * Sends a non-streaming request to OpenAI API
     * @param {string} model - The model to use
     * @param {Array} messages - The message history
     * @param {number} [timeout] - Optional timeout in ms
     * @returns {Promise<Object>} - The API response
     */
    async function sendOpenAIRequest(model, messages, timeout = 10000) {
        const payload = { model, messages };
        const response = await Utils.fetchWithRetry('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            mode: 'cors',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': 'Bearer ' + apiKey 
            },
            body: JSON.stringify(payload)
        }, 3, 1000, timeout);
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API error ${response.status}: ${errText}`);
        }
        
        return response.json();
    }

    /**
     * Sends a streaming request to OpenAI API
     * @param {string} model - The model to use
     * @param {Array} messages - The message history
     * @param {Function} onChunk - Callback for each chunk of data
     * @returns {Promise<string>} - The full response text
     */
    async function streamOpenAIRequest(model, messages, onChunk) {
        const response = await Utils.fetchWithRetry('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': 'Bearer ' + apiKey 
            },
            body: JSON.stringify({ model, messages, stream: true })
        }, 3, 1000, 10000);
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API error ${response.status}: ${errText}`);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;
        let eventBuffer = '';
        let fullReply = '';
        
        while (!done) {
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            
            // Accumulate and split complete SSE events
            eventBuffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const events = eventBuffer.split(/\r?\n\r?\n/);
            eventBuffer = events.pop(); // keep incomplete event
            
            for (const ev of events) {
                // Each ev is one SSE event block
                const lines = ev.split(/\r?\n/);
                for (const line of lines) {
                    const parsed = Utils.parseSSELine(line);
                    if (!parsed) continue;
                    
                    if (parsed.done) {
                        done = true;
                        break;
                    }
                    
                    const delta = parsed.data?.choices?.[0]?.delta;
                    if (delta?.content) {
                        fullReply += delta.content;
                        if (onChunk) onChunk(delta.content, fullReply);
                    }
                }
                if (done) break;
            }
        }
        
        return fullReply;
    }
    
    /**
     * Creates a Gemini session
     * @param {string} model - The model to use
     * @returns {Object} - Session with sendMessage method
     */
    function createGeminiSession(model) {
        return {
            sendMessage: async function(userText, chatHistory) {
                // Prepare contents array and request body
                const contents = chatHistory.map(item => ({
                    role: item.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: item.content }]
                }));
                
                const requestBody = {
                    contents: contents,
                    generationConfig: generationConfig
                };
                
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
                const response = await Utils.fetchWithProxyRetry(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                }, undefined, 3, 1000, 10000);
                
                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`API error ${response.status}: ${errText}`);
                }
                
                const result = await response.json();
                if (!result.candidates || result.candidates.length === 0) {
                    throw new Error('No response from API');
                }
                
                return result;
            }
        };
    }

    /**
     * Sends a streaming request to Gemini API
     * @param {string} model - The model to use
     * @param {Array} chatHistory - The message history
     * @param {Function} onChunk - Callback for each chunk of data
     * @returns {Promise<string>} - The full response text
     */
    async function streamGeminiRequest(model, chatHistory, onChunk) {
        // Build the request body
        const contents = chatHistory.map(item => ({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: item.content }]
        }));
        
        const requestBody = { contents, generationConfig };
        
        // Send the streaming request
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${geminiApiKey}`;
        const response = await Utils.fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        }, 3, 1000, 10000);
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API error ${response.status}: ${errText}`);
        }
        
        // Process the streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false, buffer = '', fullReply = '';
        
        while (!done) {
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') { 
                        done = true; 
                        break; 
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        const parts = parsed.candidates?.[0]?.content?.parts || [];
                        const textChunk = parts[parts.length - 1]?.text || '';
                        
                        fullReply += textChunk;
                        if (onChunk) onChunk(textChunk, fullReply);
                    } catch (err) {
                        console.error('Stream parsing error', err);
                    }
                }
            }
        }
        
        return fullReply;
    }

    /**
     * Gets the token usage for the last interaction
     * @param {string} model - The model used
     * @param {Array} chatHistory - The current chat history
     * @returns {Promise<number>} - The token count of the last interaction
     */
    async function getTokenUsage(model, chatHistory) {
        try {
            let usageResult;
            
            if (model.startsWith('gpt')) {
                // ChatGPT usage via non-stream call
                const res = await sendOpenAIRequest(model, chatHistory);
                return res.usage?.total_tokens || 0;
            } else {
                // Gemini usage
                const contents = chatHistory.map(item => ({
                    role: item.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: item.content }]
                }));
                
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
                const res = await Utils.fetchWithProxyRetry(url, {
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ contents, generationConfig })
                }, undefined, 3, 1000, 10000);
                
                usageResult = await res.json();
                return usageResult.usageMetadata?.totalTokenCount || 0;
            }
        } catch (err) {
            console.error('Error fetching token usage:', err);
            return 0;
        }
    }

    // Public API
    return {
        init,
        sendOpenAIRequest,
        streamOpenAIRequest,
        createGeminiSession,
        streamGeminiRequest,
        getTokenUsage
    };
})(); 