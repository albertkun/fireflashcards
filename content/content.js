// Content script: prompt user for translation when background asks
/* global browser */

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg?.type === 'prompt-translation') {
    const translation = window.prompt(`Translate:\n${msg.word}`, '');
    return { ok: true, translation: translation || '' };
  }
});
