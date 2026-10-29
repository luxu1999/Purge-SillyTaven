/**
 * 注入与身份剥离。
 *
 * 两条路径：
 *  - applyToText：文本补全（llama.cpp / textgenerationwebui / kobold …），prompt 是一整串字符串
 *  - applyToChat：聊天补全（OpenAI 兼容），prompt 是 [{role, content}] 数组
 *
 * 约定：所有函数都是纯函数，返回新值，不改原对象；异常在调用方兜住。
 */

import { findSystemRegion } from './settings.js';

/** 默认剥离规则：只认「AI 自我声明」和「拒答模板」，整行命中就删 */
const DEFAULT_STRIP = [
    /\b(?:as an? (?:ai|a\.i\.|assistant|language model|chatbot))\b/i,
    /\b(?:i am (?:an? )?(?:ai|assistant|language model|chatbot)|i'm an? (?:ai|assistant|language model))\b/i,
    /\b(?:as a responsible (?:ai|assistant))\b/i,
    /\b(?:i (?:can(?:no|')t|cannot|am unable to) (?:assist|help|provide|comply|continue|write))\b/i,
    /\b(?:i'm sorry,? but i)\b/i,
    /\b(?:against my (?:guidelines|policy|programming))\b/i,
    /作为(?:一个)?(?:AI|人工智能|语言模型|AI ?助手|人工智能助手)/,
    /我(?:无法|不能)(?:提供|协助|满足|回答|继续|帮助|生成|描述|写)/,
    /抱歉[，,]\s*我(?:无法|不能)/,
    /(?:这|该)(?:超出|违反)了?(?:我|我的|AI)的?(?:能力|范围|准则|限制|安全)/,
];

/**
 * 文本补全的身份剥离：只处理系统段，正文一律不动。
 */
export function stripIdentityText(text, settings) {
    const source = String(text || '');
    if (!source) return source;
    const { start, end } = findSystemRegion(source);
    const region = source.slice(start, end);
    const stripped = stripRegion(region, settings);
    if (stripped === region) return source;
    return source.slice(0, start) + stripped + source.slice(end);
}

/** 聊天补全的身份剥离：只改 role === 'system' 的消息 */
export function stripIdentityChat(chat, settings) {
    let changed = false;
    const next = chat.map((msg) => {
        if (!msg || msg.role !== 'system') return msg;
        if (typeof msg.content === 'string') {
            const stripped = stripRegion(msg.content, settings);
            if (stripped !== msg.content) {
                changed = true;
                return { ...msg, content: stripped };
            }
            return msg;
        }
        if (Array.isArray(msg.content)) {
            const parts = msg.content.map((part) => {
                if (part && part.type === 'text' && typeof part.text === 'string') {
                    const stripped = stripRegion(part.text, settings);
                    if (stripped !== part.text) {
                        changed = true;
                        return { ...part, text: stripped };
                    }
                }
                return part;
            });
            return changed ? { ...msg, content: parts } : msg;
        }
        return msg;
    });
    return changed ? next : chat;
}

function stripRegion(region, settings) {
    const lines = String(region || '').split('\n');
    const extra = parseExtraPatterns(settings?.stripExtra);
    let removed = 0;
    const kept = lines.filter((line) => {
        if (!line.trim()) return true;
        const hit = DEFAULT_STRIP.some((re) => re.test(line)) || extra.some((re) => re.test(line));
        if (hit) removed++;
        return !hit;
    });
    if (!removed) return region;
    console.info('[purge-tavern] 已剥离 %d 行身份/拒答句', removed);
    return kept.join('\n');
}

function parseExtraPatterns(raw) {
    const out = [];
    for (const line of String(raw || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        try {
            out.push(new RegExp(trimmed, 'i'));
        } catch {
            console.warn('[purge-tavern] 忽略非法正则：', trimmed);
        }
    }
    return out;
}

/**
 * 文本补全注入。
 * @param {string} prompt
 * @param {string} injection
 * @param {'system-head'|'system-tail'|'prepend'|'append'} position
 */
export function applyToText(prompt, injection, position = 'system-head') {
    const text = String(prompt ?? '');
    const block = String(injection ?? '').trim();
    if (!block) return text;
    if (position === 'prepend') return `${block}\n\n${text}`;
    if (position === 'append') return `${text}\n\n${block}`;
    const { start, end } = findSystemRegion(text);
    const at = position === 'system-tail' ? end : start;
    const before = text.slice(0, at);
    const after = text.slice(at);
    const sepBefore = before && !before.endsWith('\n') ? '\n' : '';
    const sepAfter = after.startsWith('\n') || !after ? '' : '\n';
    return `${before}${sepBefore}${block}${sepAfter}${after}`;
}

/**
 * 聊天补全注入。
 * @param {Array<{role:string, content:any}>} chat
 * @param {string} injection
 * @param {'system-head'|'system-tail'|'prepend'|'append'} position
 */
export function applyToChat(chat, injection, position = 'system-head') {
    const list = Array.isArray(chat) ? chat : [];
    const block = String(injection ?? '').trim();
    if (!block) return list;
    const clone = list.map((m) => (m && typeof m === 'object' ? { ...m } : m));
    const sysIndex = clone.findIndex((m) => m && m.role === 'system');

    if (sysIndex === -1) {
        const msg = { role: 'system', content: block };
        if (position === 'append') clone.push(msg);
        else clone.unshift(msg);
        return clone;
    }

    const sys = clone[sysIndex];
    const tail = position === 'system-tail' || position === 'append';
    if (typeof sys.content === 'string') {
        sys.content = tail ? `${sys.content}\n\n${block}` : `${block}\n\n${sys.content}`;
    } else if (Array.isArray(sys.content)) {
        const part = { type: 'text', text: block };
        sys.content = tail ? [...sys.content, part] : [part, ...sys.content];
    } else {
        sys.content = block;
    }
    clone[sysIndex] = sys;
    return clone;
}

export const __internals = { DEFAULT_STRIP, stripRegion, parseExtraPatterns };
