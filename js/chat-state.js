// js/chat-state.js
// Chat state management module

let chatHistory = [];
let totalTokens = 0;
let settings = { streaming: false, enableCoT: false, showThinking: true };

function getChatHistory() {
    return [...chatHistory];
}

function getTotalTokens() {
    return totalTokens;
}

function updateSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    console.log('Chat settings updated:', settings);
}

export { chatHistory, totalTokens, settings, getChatHistory, getTotalTokens, updateSettings }; 