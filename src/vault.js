/**
 * 消息保险箱（防撤回）。
 *
 * 思路和 dsh-purge 的 session 快照一样：append-only。每条消息按「内容指纹」存一份，
 * 只增不删；消息被删、被 swipe 覆盖、被编辑、被回退之后，保险箱里仍然留着原始版本。
 *
 * 存储位置：extension_settings['purge-tavern'].vault.data[chatKey]
 *  - 随酒馆的 settings.json 一起落盘，重启/换设备（带 settings）都还在
 *  - 默认每聊天 300 条、最多 20 个聊天，超出时丢最旧的聊天
 */

const LOG_TAG = '[purge-tavern/vault]';

function hashMessage(msg) {
    const name = String(msg?.name ?? '');
    const when = String(msg?.send_date ?? '');
    const role = msg?.is_user ? 'u' : msg?.is_system ? 's' : 'c';
    const body = String(msg?.mes ?? '').slice(0, 600);
    let h = 0x811c9dc5;
    const input = `${name}|${when}|${role}|${body}`;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${role}:${h.toString(16)}:${body.length}`;
}

function toRecord(msg, index) {
    return {
        h: hashMessage(msg),
        i: index,
        name: msg?.name ?? '',
        is_user: !!msg?.is_user,
        is_system: !!msg?.is_system,
        send_date: msg?.send_date ?? '',
        mes: String(msg?.mes ?? ''),
        swipes: Array.isArray(msg?.swipes) ? msg.swipes : undefined,
        swipe_id: msg?.swipe_id,
    };
}

function toMessage(record) {
    const out = {
        name: record.name,
        is_user: record.is_user,
        is_system: record.is_system,
        send_date: record.send_date,
        mes: record.mes,
    };
    if (record.swipes) {
        out.swipes = record.swipes;
        out.swipe_id = record.swipe_id;
    }
    return out;
}

export function createVault({ settings, getContext, log = () => {}, onChange = () => {} }) {
    function store() {
        settings.vault ??= { enabled: true, maxPerChat: 300, maxChats: 20, data: {} };
        settings.vault.data ??= {};
        return settings.vault;
    }

    function currentChatInfo() {
        const ctx = getContext();
        const id = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null;
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const char = ctx.characters?.[ctx.characterId];
        const name = id || (char?.name ? `未命名-${char.name}` : '未命名');
        return { key: `chat:${id || name}`, id, name, chat, character: char?.name ?? '' };
    }

    function currentEntry() {
        const info = currentChatInfo();
        const data = store().data;
        return { info, entry: data[info.key] };
    }

    function snapshot() {
        const vault = store();
        if (!vault.enabled) return 0;
        const { key, id, name, chat, character } = currentChatInfo();
        if (!Array.isArray(chat) || !chat.length) return 0;
        const existing = vault.data[key] ?? { chatId: id, chatName: name, character, savedAt: 0, messages: [], index: {} };
        existing.index ??= {};
        let added = 0;
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg || typeof msg.mes !== 'string' || !msg.mes.trim()) continue;
            const record = toRecord(msg, i);
            if (existing.index[record.h]) continue;
            existing.index[record.h] = existing.messages.length;
            existing.messages.push(record);
            added++;
        }
        if (added) {
            existing.savedAt = Date.now();
            existing.chatName = name || existing.chatName;
            vault.data[key] = existing;
            prune();
            onChange?.();
            log('vault: +%d 条（当前聊天共 %d 条）', added, existing.messages.length);
        }
        return added;
    }

    function prune() {
        const vault = store();
        const cap = Math.max(10, Number(vault.maxPerChat) || 300);
        for (const entry of Object.values(vault.data)) {
            if (entry.messages.length <= cap) continue;
            const overflow = entry.messages.length - cap;
            entry.messages.splice(0, overflow);
            entry.index = {};
            entry.messages.forEach((m, i) => { entry.index[m.h] = i; });
        }
        const maxChats = Math.max(1, Number(vault.maxChats) || 20);
        const keys = Object.keys(vault.data);
        if (keys.length > maxChats) {
            keys.sort((a, b) => (vault.data[a].savedAt || 0) - (vault.data[b].savedAt || 0));
            for (const key of keys.slice(0, keys.length - maxChats)) delete vault.data[key];
        }
    }

    function currentStats() {
        const { entry } = currentEntry();
        return { count: entry?.messages?.length ?? 0, savedAt: entry?.savedAt ?? 0 };
    }

    function exportCurrent() {
        const { info, entry } = currentEntry();
        if (!entry || !entry.messages?.length) {
            globalThis.toastr?.warning?.('当前聊天还没有快照', 'Purge 破限');
            return;
        }
        const payload = {
            exportedAt: new Date().toISOString(),
            chatId: info.id,
            chatName: info.name,
            character: info.character,
            count: entry.messages.length,
            messages: entry.messages,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `purge-vault-${(info.name || 'chat').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')}-${Date.now()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        globalThis.toastr?.success?.(`已导出 ${entry.messages.length} 条消息`, 'Purge 破限');
    }

    async function restoreCurrent() {
        const ctx = getContext();
        const { info, entry } = currentEntry();
        if (!entry || !entry.messages?.length) {
            globalThis.toastr?.warning?.('当前聊天还没有快照', 'Purge 破限');
            return 0;
        }
        const chat = ctx.chat;
        if (!Array.isArray(chat)) return 0;
        const existing = new Set(chat.map((m) => hashMessage(m)));
        const missing = entry.messages.filter((m) => !existing.has(m.h));
        if (!missing.length) {
            globalThis.toastr?.info?.('保险箱里的消息当前聊天都有，无需合并', 'Purge 破限');
            return 0;
        }
        const missingMessages = missing.map(toMessage);
        const merged = [...chat, ...missingMessages].sort((a, b) => {
            const ta = Date.parse(a.send_date) || 0;
            const tb = Date.parse(b.send_date) || 0;
            return ta - tb;
        });
        chat.splice(0, chat.length, ...merged);
        try {
            if (typeof ctx.saveChat === 'function') await ctx.saveChat();
            if (typeof ctx.reloadCurrentChat === 'function') await ctx.reloadCurrentChat();
        } catch (err) {
            console.error(LOG_TAG, 'restore save failed', err);
        }
        globalThis.toastr?.success?.(`已合并 ${missingMessages.length} 条消息并重载聊天`, 'Purge 破限');
        onChange?.();
        return missingMessages.length;
    }

    function clearCurrent() {
        const { info } = currentEntry();
        delete store().data[info.key];
        onChange?.();
        globalThis.toastr?.info?.('已清空当前聊天的快照', 'Purge 破限');
    }

    return { snapshot, currentStats, exportCurrent, restoreCurrent, clearCurrent, hashMessage, _store: store };
}
