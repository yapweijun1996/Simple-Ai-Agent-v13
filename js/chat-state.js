// js/chat-state.js
// Chat state management module (encapsulated)

let _chatHistory = [];
let _totalTokens = 0;
let _settings = { streaming: false, enableCoT: false, showThinking: true };

function getChatHistory() {
    return [..._chatHistory];
}
function setChatHistory(history) {
    _chatHistory = Array.isArray(history) ? [...history] : [];
}
function addChatMessage(msg) {
    _chatHistory.push(msg);
}

function getTotalTokens() {
    return _totalTokens;
}
function setTotalTokens(tokens) {
    _totalTokens = tokens;
}
function incrementTotalTokens(delta) {
    _totalTokens += delta;
}

function getSettings() {
    return { ..._settings };
}
function setSettings(newSettings) {
    _settings = { ..._settings, ...newSettings };
}

export {
    getChatHistory, setChatHistory, addChatMessage,
    getTotalTokens, setTotalTokens, incrementTotalTokens,
    getSettings, setSettings
}; 