// js/chat-summarization.js
// Summarization logic extracted from chat-controller.js
import { splitIntoBatches } from './utils.js';

export async function summarizeSnippets({
    snippets,
    round = 1,
    UIController,
    SettingsController,
    ApiService,
    readSnippets,
    synthesizeFinalAnswer
}) {
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
        readSnippets.length = 0;
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
            await summarizeSnippets({
                snippets: batchSummaries,
                round: round + 1,
                UIController,
                SettingsController,
                ApiService,
                readSnippets,
                synthesizeFinalAnswer
            });
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
    readSnippets.length = 0;
}

export async function synthesizeFinalAnswer(summaries, { originalUserQuestion, SettingsController, UIController, ApiService, toolWorkflowActiveRef }) {
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
        if (toolWorkflowActiveRef) toolWorkflowActiveRef.value = false;
    } catch (err) {
        UIController.addMessage('ai', `Final answer synthesis failed. Error: ${err && err.message ? err.message : err}`);
        if (toolWorkflowActiveRef) toolWorkflowActiveRef.value = false;
    }
} 