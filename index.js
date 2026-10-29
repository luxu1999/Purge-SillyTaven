/**
 * purge-tavern — SillyTavern 扩展：破限注入 + 消息保险箱（防撤回）
 *
 * 设计要点：
 * - 不修改酒馆源码，全部走扩展 API（事件 + 设置面板 + 斜杠命令）。
 * - 注入：文本补全走 GENERATE_AFTER_COMBINE_PROMPTS，聊天补全走 CHAT_COMPLETION_PROMPT_READY，
 *   两条路径都在请求真正发出之前改写，因此对 llama.cpp / OpenAI 兼容端点同样有效。
 * - 身份剥离：只剥离「AI 自我声明 / 拒答模板」这类整行文本，默认关闭；开启时只作用于系统段，
 *   避免误伤角色扮演正文和 ChatML 标记（酒馆靠这些标记组装 prompt，不能像 dsh-purge 那样清掉）。
 * - 防撤回：监听消息生命周期事件，把每条消息按内容哈希 append-only 存进设置里的保险箱，
 *   默认软保护——被删/被刷掉的消息不会从酒馆里消失作者也拦不住，但保险箱里永远有一份，
 *   可以随时导出或合并回当前聊天。
 */

// Paths are relative to /scripts/extensions/third-party/purge-tavern/index.js:
//   ../../../extensions.js   -> /scripts/extensions.js
//   ../../../../script.js    -> /script.js
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

import { DEFAULT_SETTINGS, loadSettings, resolveInjectionText, loadOriginalPreset, PRESET_LABELS } from './src/settings.js';
import { applyToText, applyToChat, stripIdentityText, stripIdentityChat } from './src/inject.js';
import { createVault } from './src/vault.js';

export const MODULE_NAME = 'purge-tavern';
const LOG_TAG = '[purge-tavern]';
const LOG_PREFIX = `${LOG_TAG}`;

/** @type {ReturnType<typeof loadSettings>|null} */
let settings = null;
let vault = null;
let initialized = false;
let saveTimer = null;

function log(...args) {
    if (settings?.debug || args[0] === 'warn' || args[0] === 'error') {
        const level = args[0] === 'warn' || args[0] === 'error' ? args.shift() : 'debug';
        console[level](LOG_TAG, ...args);
    }
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            saveSettingsDebounced();
        } catch (err) {
            console.warn(LOG_TAG, 'saveSettingsDebounced failed', err);
        }
    }, 300);
}

function bindSettingsPanel() {
    $('#pt_enabled').prop('checked', !!settings.enabled).on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        scheduleSave();
        renderStatus();
    });
    $('#pt_profile').val(settings.profile).on('change', function () {
        settings.profile = String($(this).val() || 'rp');
        $('#pt_custom_wrap').toggle(settings.profile === 'custom');
        updateTextPreview();
        scheduleSave();
    });
    $('#pt_position').val(settings.position).on('change', function () {
        settings.position = String($(this).val() || 'system-head');
        scheduleSave();
    });
    $('#pt_custom_text').val(settings.customText || '').on('input', function () {
        settings.customText = String($(this).val() || '');
        updatePreviewText();
        scheduleSave();
    }).trigger('input');
    $('#pt_strip').prop('checked', !!settings.stripIdentity).on('change', function () {
        settings.stripIdentity = !!$(this).prop('checked');
        scheduleSave();
    });
    $('#pt_strip_extra').val(settings.stripExtra || '').on('input', function () {
        settings.stripExtra = String($(this).val() || '');
        scheduleSave();
    });
    $('#pt_vault_enabled').prop('checked', !!settings.vault.enabled).on('change', function () {
        settings.vault.enabled = !!$(this).prop('checked');
        scheduleSave();
    });
    $('#pt_vault_cap').val(settings.vault.maxPerChat).on('change', function () {
        const n = Number($(this).val());
        settings.vault.maxPerChat = Number.isFinite(n) && n > 0 ? Math.min(2000, Math.floor(n)) : 300;
        $(this).val(settings.vault.maxPerChat);
        scheduleSave();
    });
    $('#pt_debug').prop('checked', !!settings.debug).on('change', function () {
        settings.debug = !!$(this).prop('checked');
        scheduleSave();
    });
    $('#pt_save_preset').on('click', () => {
        const text = resolveInjectionText(settings, { forceCustom: true });
        if (!text.trim()) {
            toastr?.warning?.('没有可保存的注入文本', 'Purge 破限');
            return;
        }
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `purge-preset-${Date.now()}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    });
    $('#pt_vault_export').on('click', () => vault?.exportCurrent());
    $('#pt_vault_restore').on('click', () => vault?.restoreCurrent());
    $('#pt_vault_clear').on('click', () => {
        if (confirm('清空当前聊天的消息保险箱？导出的备份不受影响。')) {
            vault?.clearCurrent();
            renderStatus();
        }
    });
    $('#pt_custom_wrap').toggle(settings.profile === 'custom');
    updateTextPreview();
    renderStatus();
}

function updatePreviewText() {
    const text = resolveInjectionText(settings);
    const chars = text.length;
    const approxTokens = Math.ceil(chars / 3.2);
    $('#pt_preview_meta').text(`${chars} 字符 · 约 ${approxTokens} tokens · 档位：${PRESET_LABELS[settings.profile] || settings.profile}`);
}

function updateTextPreview() {
    if (settings.profile !== 'custom') {
        $('#pt_custom_text').val(settings.customText || '');
    }
    updatePreviewText();
}

function renderStatus() {
    const snapshot = vault?.currentStats?.() ?? { count: 0, savedAt: 0 };
    const when = snapshot.savedAt ? new Date(snapshot.savedAt).toLocaleTimeString() : '—';
    $('#pt_vault_status').text(`当前聊天：${snapshot.count} 条快照 · 最后保存 ${when}`);
    $('#pt_state').text(settings.enabled ? '注入已开启' : '注入已关闭');
    $('#pt_state').toggleClass('pt-off', !settings.enabled);
}

function onTextPrompt(eventData) {
    try {
        if (!settings?.enabled || !eventData || typeof eventData.prompt !== 'string') return;
        if (eventData.dryRun) return;
        const text = resolveInjectionText(settings);
        if (!text.trim()) return;
        let prompt = eventData.prompt;
        if (settings.stripIdentity) prompt = stripIdentityText(prompt, settings);
        const next = applyToText(prompt, text, settings.position);
        if (next !== prompt) {
            eventData.prompt = next;
            log('text completion prompt injected', { position: settings.position, added: next.length - prompt.length });
        }
    } catch (err) {
        console.error(LOG_TAG, 'text prompt injection failed', err);
    }
}

function onChatPrompt(eventData) {
    try {
        if (!settings?.enabled || !eventData || !Array.isArray(eventData.chat)) return;
        if (eventData.dryRun) return;
        const text = resolveInjectionText(settings);
        if (!text.trim()) return;
        let chat = eventData.chat;
        if (settings.stripIdentity) chat = stripIdentityChat(chat, settings);
        const next = applyToChat(chat, text, settings.position);
        if (next !== chat) {
            eventData.chat = next;
            log('chat completion prompt injected', { position: settings.position, messages: next.length });
        }
    } catch (err) {
        console.error(LOG_TAG, 'chat prompt injection failed', err);
    }
}

function onVaultEvent() {
    try {
        vault?.snapshot();
        renderStatus();
    } catch (err) {
        console.error(LOG_TAG, 'vault snapshot failed', err);
    }
}

function registerSlashCommands() {
    try {
        const ctx = getContext();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'purge-export',
            helpString: '把当前聊天的消息保险箱导出为 JSON 文件',
            callback: () => {
                vault?.exportCurrent();
                return '';
            },
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'purge-restore',
            helpString: '把保险箱里缺失的消息合并回当前聊天并重载',
            callback: async () => {
                const n = await vault?.restoreCurrent();
                return `已合并 ${n ?? 0} 条消息`;
            },
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'purge-status',
            helpString: '查看破限注入与保险箱状态',
            callback: () => {
                const s = vault?.currentStats?.() ?? { count: 0 };
                return `注入：${settings.enabled ? '开' : '关'} · 档位：${settings.profile} · 位置：${settings.position} · 保险箱：${s.count} 条`;
            },
        }));
    } catch (err) {
        console.warn(LOG_TAG, 'slash command registration skipped', err);
    }
}

export async function init() {
    if (initialized) return;
    initialized = true;

    settings = loadSettings(extension_settings);
    vault = createVault({ settings, getContext, log, onChange: renderStatus });

    // 原版档位是 21 KB 的 markdown，异步取；取不到就回退默认档，不影响其它功能
    loadOriginalPreset().catch(() => {});

    try {
        const html = await renderExtensionTemplateAsync('third-party/purge-tavern', 'settings');
        $('#extensions_settings2').append(html);
        bindSettingsPanel();
    } catch (err) {
        console.error(LOG_TAG, 'failed to render settings panel', err);
    }

    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onTextPrompt);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatPrompt);
    for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'CHAT_CHANGED']) {
        if (event_types[name]) eventSource.on(event_types[name], onVaultEvent);
    }

    registerSlashCommands();
    onVaultEvent();

    // 调试/自测入口（冒烟脚本用；不影响正常运行）
    globalThis.PurgeTavern = {
        version: '0.1.0',
        moduleName: MODULE_NAME,
        get settings() { return settings; },
        applyText: (prompt, override) => applyToText(prompt, resolveInjectionText(override || settings), (override || settings).position),
        applyChat: (chat, override) => applyToChat(chat, resolveInjectionText(override || settings), (override || settings).position),
        stripText: (text) => stripIdentityText(text, settings),
        vault,
        reloadSettings: () => { settings = loadSettings(extension_settings); },
    };

    console.info(`${LOG_PREFIX} initialized v0.1.0`, { profile: settings.profile, position: settings.position, vault: settings.vault.enabled });
}
