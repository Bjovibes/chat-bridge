// Chat Bridge — shell preload. Exposes exactly window.wab per docs/CONTRACT.md.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('wab', {
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    // v14 T3: platform 'whatsapp' | 'telegram' (default whatsapp); optional
    // userId defaults to the first user in the main process.
    add: (name, color, platform, userId) => ipcRenderer.invoke('accounts:add', { name, color, platform, userId }),
    update: (id, patch) => ipcRenderer.invoke('accounts:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('accounts:remove', { id }),
    relink: (id) => ipcRenderer.invoke('accounts:relink', { id }),
    onStatus: (cb) => subscribe('accounts:onStatus', cb),
    onListChanged: (cb) => subscribe('accounts:list-changed', cb)
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    add: (name) => ipcRenderer.invoke('users:add', { name })
  },
  privacy: {
    get: (accountId) => ipcRenderer.invoke('privacy:get', { accountId }),
    set: (accountId, config) => ipcRenderer.invoke('privacy:set', { accountId, config }),
    listChats: (accountId) => ipcRenderer.invoke('privacy:listChats', { accountId })
  },
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:config:get'),
    setConfig: (config) => ipcRenderer.invoke('ai:config:set', { config }),
    test: () => ipcRenderer.invoke('ai:test'),
    run: (accountId, command, instruction, chatId) => ipcRenderer.invoke('ai:run', { accountId, command, instruction, chatId }),
    insert: (accountId, text) => ipcRenderer.invoke('ai:insert', { accountId, text })
  },
  stats: {
    sent: () => ipcRenderer.invoke('sent:stats')
  },
  brain: {
    get: () => ipcRenderer.invoke('brain:get'),
    set: (brain) => ipcRenderer.invoke('brain:set', { brain })
  },
  chats: {
    listPeople: () => ipcRenderer.invoke('chats:listPeople'),
    searchAll: (query) => ipcRenderer.invoke('chats:searchAll', { query }),
    open: (accountId, title) => ipcRenderer.invoke('chats:open', { accountId, title })
  },
  eng: {
    people: () => ipcRenderer.invoke('eng:people'),
    messages: (accountId, chatId, limit) => ipcRenderer.invoke('eng:messages', { accountId, chatId, limit }),
    send: (accountId, chatId, text, title) => ipcRenderer.invoke('eng:send', { accountId, chatId, text, title }),
    preopen: (accountId, chatId) => ipcRenderer.invoke('eng:preopen', { accountId, chatId }),
    media: (accountId, chatId, msgId) => ipcRenderer.invoke('eng:media', { accountId, chatId, msgId }),
    history: (accountId, chatId, pages) => ipcRenderer.invoke('eng:history', { accountId, chatId, pages }),
    hasMore: (accountId, chatId) => ipcRenderer.invoke('eng:hasmore', { accountId, chatId }),
    health: () => ipcRenderer.invoke('eng:health'),
    onPeopleUpdated: (cb) => subscribe('eng:people-updated', cb),
    onTyping: (cb) => subscribe('eng:on-typing', cb)
  },
  debug: {
    dump: () => ipcRenderer.invoke('debug:dump'),
    onEvent: (cb) => subscribe('debug:on-event', cb),
    push: (kind, accountId, text) => ipcRenderer.invoke('debug:push', { kind, accountId, text })
  },
  app: {
    setLayout: (mode) => ipcRenderer.invoke('app:setLayout', { mode }),
    onLayout: (cb) => subscribe('app:layout', cb),
    onUnread: (cb) => subscribe('app:onUnread', cb),
    onToast: (cb) => subscribe('app:onToast', cb),
    setActivePane: (slot) => ipcRenderer.invoke('app:setActivePane', { slot }),
    getPrefs: () => ipcRenderer.invoke('app:getPrefs'),
    setPrefs: (prefs) => ipcRenderer.invoke('app:setPrefs', prefs || {}),
    setOverlayVisible: (on) => ipcRenderer.invoke('app:setOverlayVisible', { on }),
    getPanePrefs: () => ipcRenderer.invoke('app:getPanePrefs'),
    setPanePrefs: (slot, prefs) => ipcRenderer.invoke('app:setPanePrefs', { slot, prefs }),
    setPanePerson: (slot, accountId, chatId, title) =>
      ipcRenderer.invoke('app:setPanePerson', { slot, accountId, chatId, title }),
    onPaneState: (cb) => subscribe('panes:onState', cb)
  }
});
