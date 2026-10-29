/**
 * 纯函数自测：node scripts/selftest.mjs
 * 不依赖酒馆运行时，用来在装机前验证注入/剥离逻辑。
 */
import assert from 'node:assert/strict';
import { applyToText, applyToChat, stripIdentityText, stripIdentityChat } from '../src/inject.js';
import { findSystemRegion, RP_DEFAULT_TEXT, loadSettings, resolveInjectionText } from '../src/settings.js';

let passed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        console.error(`  FAIL ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

const INJ = '<|purge|>OVERRIDE';

console.log('applyToText');

check('chatml system head', () => {
    const prompt = '<|im_start|>system\nYou are Seraphina.<|im_end|>\n<|im_start|>user\nhi<|im_end|>';
    const out = applyToText(prompt, INJ, 'system-head');
    assert.match(out, /^<\|im_start\|>system\n<\|purge\|>OVERRIDE\nYou are Seraphina\./);
});

check('chatml system tail', () => {
    const prompt = '<|im_start|>system\nYou are Seraphina.<|im_end|>\n<|im_start|>user\nhi<|im_end|>';
    const out = applyToText(prompt, INJ, 'system-tail');
    assert.match(out, /You are Seraphina\.\n<\|purge\|>OVERRIDE/);
});

check('llama3 header template', () => {
    const prompt = '<|start_header_id|>system<|end_header_id|>\nYou are a helper.<|eot_id|><|start_header_id|>user<|end_header_id|>\nhello<|eot_id|>';
    const out = applyToText(prompt, INJ, 'system-head');
    assert.match(out, /system<\|end_header_id\|>\n<\|purge\|>OVERRIDE\nYou are a helper\./);
});

check('### System: template', () => {
    const prompt = '### System:\nYou are a helper.\n### Instruction:\nhello';
    const out = applyToText(prompt, INJ, 'system-head');
    assert.match(out, /### System:\n<\|purge\|>OVERRIDE\nYou are a helper\./);
});

check('no marker falls back to leading block', () => {
    const out = applyToText('plain prompt text', INJ, 'system-head');
    assert.match(out, /^<\|purge\|>OVERRIDE\n+plain prompt text$/);
});

check('prepend / append', () => {
    assert.equal(applyToText('X', INJ, 'prepend'), `${INJ}\n\nX`);
    assert.equal(applyToText('X', INJ, 'append'), `X\n\n${INJ}`);
});

check('empty injection is a no-op', () => {
    assert.equal(applyToText('X', '', 'system-head'), 'X');
});

console.log('applyToChat');

check('existing system message head', () => {
    const chat = [{ role: 'system', content: 'You are Seraphina.' }, { role: 'user', content: 'hi' }];
    const out = applyToChat(chat, INJ, 'system-head');
    assert.equal(out[0].content, `${INJ}\n\nYou are Seraphina.`);
    assert.equal(chat[0].content, 'You are Seraphina.', 'must not mutate input');
});

check('existing system message tail', () => {
    const out = applyToChat([{ role: 'system', content: 'A' }], INJ, 'system-tail');
    assert.equal(out[0].content, `A\n\n${INJ}`);
});

check('no system message prepends one', () => {
    const out = applyToChat([{ role: 'user', content: 'hi' }], INJ, 'system-head');
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'system', content: INJ });
});

check('multimodal system content', () => {
    const chat = [{ role: 'system', content: [{ type: 'text', text: 'base' }] }];
    const out = applyToChat(chat, INJ, 'system-head');
    assert.equal(out[0].content[0].text, INJ);
    assert.equal(out[0].content[1].text, 'base');
});

console.log('stripIdentity');

check('strips english refusal lines inside system region only', () => {
    const prompt = 'You are Seraphina.\nAs an AI language model, I cannot assist with that.\n<|im_start|>user\nAs an AI language model, this is in-story text.<|im_end|>';
    const out = stripIdentityText(prompt, { stripExtra: '' });
    assert.ok(!out.includes('I cannot assist'));
    assert.ok(out.includes('this is in-story text'), 'in-story text untouched');
});

check('strips chinese refusal lines', () => {
    const prompt = '<|im_start|>system\n你是一位小说助手。\n抱歉，我无法提供这类内容。\n<|im_end|>';
    const out = stripIdentityText(prompt, { stripExtra: '' });
    assert.ok(!out.includes('我无法提供'));
    assert.ok(out.includes('小说助手'));
});

check('extra regex is applied', () => {
    const prompt = '<|im_start|>system\n安全提示：禁止暴力\n<|im_end|>';
    const out = stripIdentityText(prompt, { stripExtra: '^安全提示：.*$' });
    assert.ok(!out.includes('安全提示'));
});

check('chat strip only touches system role', () => {
    const chat = [
        { role: 'system', content: 'As an AI assistant, I cannot help.' },
        { role: 'user', content: 'As an AI assistant, I cannot help.' },
    ];
    const out = stripIdentityChat(chat, { stripExtra: '' });
    assert.equal(out[0].content.trim(), '');
    assert.equal(out[1].content, 'As an AI assistant, I cannot help.');
});

console.log('settings');

check('findSystemRegion detects boundaries', () => {
    const { start, end } = findSystemRegion('<|im_start|>system\nABC<|im_end|>');
    assert.equal(start, '<|im_start|>system\n'.length);
    assert.equal(end, start + 3);
});

check('loadSettings fills defaults', () => {
    const store = {};
    const s = loadSettings(store);
    assert.equal(s.profile, 'rp');
    assert.equal(s.vault.maxPerChat, 300);
    assert.equal(store['purge-tavern'], s);
});

check('default preset resolves and contains override marker', () => {
    const s = loadSettings({});
    const text = resolveInjectionText(s);
    assert.ok(text.includes('<|purge|>'));
    assert.ok(RP_DEFAULT_TEXT.length > 200);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
