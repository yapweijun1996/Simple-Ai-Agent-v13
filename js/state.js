// state.js
// Centralized app state management

const state = {
    currentModel: 'gpt-4.1-mini',
    chatHistory: [],
    settings: {},
};

export function getState() {
    return state;
}

export function setCurrentModel(model) {
    state.currentModel = model;
}

export function addMessageToHistory(message) {
    state.chatHistory.push(message);
}

export function setSettings(settings) {
    state.settings = settings;
} 