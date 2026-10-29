// ============================================================================
// HTP SHIELD PRO v2.0 - ULTIMATE BACKGROUND ENGINE
// ============================================================================

let memoryGlobalStats = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
let memoryTabStats = {};
let memoryDomainStats = {};
let tabHostMap = {};
let lastActiveTabId = null;
let isGlobalShieldEnabled = true;
let cachedWhitelist = [];
let pauseUntilTimestamp = 0;
let pauseTimeoutHandle = null;

let isStorageLoaded = false;
let storageLoadPromise = null;
let isSyncingRules = false;
let syncPending = false;
let storageSaveTimer = null;
let lastMatchedRuleTimestamp = 0;
let lastProductionSyncCallTime = 0;

const WHITELIST_RULE_ID_START = 1000;
const CUSTOM_FILTER_RULE_ID_START = 2000;
const TRACKER_RULE_IDS = new Set([4, 11, 12, 17, 22, 24, 25, 26, 27, 28, 29, 30]);
const POPUP_RULE_IDS = new Set([2, 3, 13, 20, 21]);
const SUSPICIOUS_RULE_IDS = new Set([7, 8]);

function extractHost(urlStr) {
    try {
        if (!urlStr || urlStr.startsWith('chrome://') || urlStr.startsWith('chrome-extension://') || urlStr.startsWith('about:')) {
            return '';
        }
        return new URL(urlStr).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
        return '';
    }
}

function isDomainWhitelisted(domain) {
    if (!domain) return false;
    const clean = domain.replace(/^www\./, '').toLowerCase();
    return cachedWhitelist.some(w => {
        const cw = String(w).trim().toLowerCase().replace(/^www\./, '');
        return cw && (clean === cw || clean.endsWith('.' + cw));
    });
}

function checkAndExpirePauseTimer() {
    if (!isGlobalShieldEnabled && pauseUntilTimestamp > 0 && Date.now() >= pauseUntilTimestamp) {
        isGlobalShieldEnabled = true;
        pauseUntilTimestamp = 0;
        if (pauseTimeoutHandle) {
            clearTimeout(pauseTimeoutHandle);
            pauseTimeoutHandle = null;
        }
        chrome.storage.local.set({ adblockEnabled: true, pauseUntil: 0 });
        return true;
    }
    return false;
}

function flushStatsToStorage() {
    if (storageSaveTimer) return;
    storageSaveTimer = setTimeout(() => {
        storageSaveTimer = null;
        chrome.storage.local.set({
            globalStats: memoryGlobalStats,
            domainStats: memoryDomainStats
        });
    }, 350);
}

function ensureStorageHydrated() {
    if (isStorageLoaded) {
        checkAndExpirePauseTimer();
        return Promise.resolve();
    }
    if (storageLoadPromise) return storageLoadPromise;

    storageLoadPromise = new Promise((resolve) => {
        chrome.storage.local.get(['adblockEnabled', 'whitelist', 'globalStats', 'domainStats', 'pauseUntil'], (res) => {
            isGlobalShieldEnabled = res.adblockEnabled !== false;
            cachedWhitelist = Array.isArray(res.whitelist) ? res.whitelist : [];
            pauseUntilTimestamp = Number(res.pauseUntil) || 0;

            if (res.globalStats) {
                memoryGlobalStats = {
                    ads: (Number(res.globalStats.ads) || 0) + (memoryGlobalStats.ads || 0),
                    popups: (Number(res.globalStats.popups) || 0) + (memoryGlobalStats.popups || 0),
                    trackers: (Number(res.globalStats.trackers) || 0) + (memoryGlobalStats.trackers || 0),
                    suspicious: (Number(res.globalStats.suspicious) || 0) + (memoryGlobalStats.suspicious || 0)
                };
            }
            if (res.domainStats && typeof res.domainStats === 'object') {
                Object.keys(res.domainStats).forEach(dom => {
                    if (!memoryDomainStats[dom]) {
                        memoryDomainStats[dom] = res.domainStats[dom];
                    }
                });
            }
            isStorageLoaded = true;
            checkAndExpirePauseTimer();
            resolve();
        });
    });

    return storageLoadPromise;
}

function schedulePauseResumeTimer(pauseUntil) {
    if (pauseTimeoutHandle) {
        clearTimeout(pauseTimeoutHandle);
        pauseTimeoutHandle = null;
    }
    pauseUntilTimestamp = Number(pauseUntil) || 0;
    if (!pauseUntilTimestamp) return;

    const remainingMs = pauseUntilTimestamp - Date.now();
    if (remainingMs <= 0) {
        pauseUntilTimestamp = 0;
        chrome.storage.local.set({ adblockEnabled: true, pauseUntil: 0 });
    } else {
        pauseTimeoutHandle = setTimeout(() => {
            pauseUntilTimestamp = 0;
            chrome.storage.local.set({ adblockEnabled: true, pauseUntil: 0 });
        }, remainingMs);
    }
}

function broadcastStateToAllTabs() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (!tab.id) return;
            const host = extractHost(tab.url || '');
            if (host) tabHostMap[tab.id] = host;
            updateBadgeForTab(tab.id, host);

            const isTabPaused = !isGlobalShieldEnabled || isDomainWhitelisted(host);
            chrome.tabs.sendMessage(tab.id, {
                cmd: 'htp_state_updated',
                adblockEnabled: isGlobalShieldEnabled,
                whitelist: cachedWhitelist,
                tabPaused: isTabPaused
            }).catch(() => {});
        });
    });
}

chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
        if (tab.id && tab.url) {
            const h = extractHost(tab.url);
            if (h) tabHostMap[tab.id] = h;
            if (tab.active) lastActiveTabId = tab.id;
        }
    });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    lastActiveTabId = activeInfo.tabId;
    ensureStorageHydrated().then(() => {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            const h = extractHost(tab.url || '');
            if (h) tabHostMap[activeInfo.tabId] = h;
            updateBadgeForTab(activeInfo.tabId, h);
        });
    });
});

function getStatsForTarget(tabId, domain) {
    if (domain && memoryDomainStats[domain]) {
        return memoryDomainStats[domain];
    }
    if (tabId && memoryTabStats[tabId]) {
        return memoryTabStats[tabId];
    }
    return { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
}

function updateBadgeForTab(tabId, explicitDomain = '') {
    if (!tabId || tabId < 0) return;

    if (!isGlobalShieldEnabled) {
        chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#ef4444' }).catch(() => {});
        chrome.action.setBadgeText({ tabId: tabId, text: 'OFF' }).catch(() => {});
        return;
    }

    const domain = explicitDomain || tabHostMap[tabId] || '';
    if (!domain) {
        chrome.action.setBadgeText({ tabId: tabId, text: '' }).catch(() => {});
        return;
    }

    if (isDomainWhitelisted(domain)) {
        chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#f5b041' }).catch(() => {});
        chrome.action.setBadgeText({ tabId: tabId, text: 'PAUSE' }).catch(() => {});
        return;
    }

    const stats = getStatsForTarget(tabId, domain);
    const total = (stats.ads || 0) + (stats.popups || 0) + (stats.trackers || 0) + (stats.suspicious || 0);

    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#10b981' }).catch(() => {});
    chrome.action.setBadgeText({
        tabId: tabId,
        text: total > 0 ? (total > 999 ? '999+' : String(total)) : ''
    }).catch(() => {});
}

// 1. Record Blocked Item Safely After Storage Hydration
async function recordBlockedItem(type, tabId = null, initiatorHost = '', count = 1) {
    await ensureStorageHydrated();
    if (!isGlobalShieldEnabled) return;

    const effectiveTabId = (tabId !== null && tabId >= 0) ? tabId : lastActiveTabId;
    const domain = (effectiveTabId && tabHostMap[effectiveTabId]) ? tabHostMap[effectiveTabId] : initiatorHost;

    if (domain && isDomainWhitelisted(domain)) {
        return;
    }

    if (!['ads', 'popups', 'trackers', 'suspicious'].includes(type)) {
        type = 'ads';
    }

    memoryGlobalStats[type] = (Number(memoryGlobalStats[type]) || 0) + count;

    if (domain) {
        if (!memoryDomainStats[domain]) {
            memoryDomainStats[domain] = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
        }
        memoryDomainStats[domain][type] = (Number(memoryDomainStats[domain][type]) || 0) + count;
    }

    if (effectiveTabId !== null && effectiveTabId >= 0 && domain) {
        if (!memoryTabStats[effectiveTabId]) {
            memoryTabStats[effectiveTabId] = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
        }
        memoryTabStats[effectiveTabId][type] = (Number(memoryTabStats[effectiveTabId][type]) || 0) + count;
        updateBadgeForTab(effectiveTabId, domain);
    }

    flushStatsToStorage();
}

// 2A. NATIVE DNR NETWORK BLOCK LISTENER (Unpacked Mode)
const hasDebugDNRListener = Boolean(chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug);

if (hasDebugDNRListener) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        checkAndExpirePauseTimer();
        if (!isGlobalShieldEnabled || !info || !info.request) return;
        if (info.rule && info.rule.ruleId >= WHITELIST_RULE_ID_START && info.rule.ruleId < CUSTOM_FILTER_RULE_ID_START) {
            return;
        }

        const url = (info.request.url || '').toLowerCase();
        const tabId = info.request.tabId;
        const initiatorHost = extractHost(info.request.initiator || '');
        const tabDomain = (tabId >= 0 && tabHostMap[tabId]) ? tabHostMap[tabId] : initiatorHost;

        if (isDomainWhitelisted(tabDomain) || isDomainWhitelisted(initiatorHost)) {
            return;
        }

        if (tabId >= 0 && !tabHostMap[tabId] && initiatorHost) {
            tabHostMap[tabId] = initiatorHost;
        }

        let category = 'ads';
        if (
            url.includes('popads') ||
            url.includes('popunder') ||
            url.includes('propeller') ||
            url.includes('.qpon') ||
            url.includes('xm.com')
        ) {
            category = 'popups';
        } else if (
            url.includes('playin05') ||
            url.includes('gohappyin') ||
            url.includes('casino') ||
            url.includes('betting') ||
            url.includes('enagemimble')
        ) {
            category = 'suspicious';
        } else if (
            url.includes('/pagead/') ||
            url.includes('googlesyndication') ||
            url.includes('googleadservices') ||
            url.includes('ad_break') ||
            url.includes('get_midroll') ||
            url.includes('adsterra') ||
            url.includes('criteo') ||
            url.includes('taboola') ||
            url.includes('outbrain') ||
            url.includes('vast.xml') ||
            url.includes('vpaid.js') ||
            url.includes('doubleclick.net/pagead') ||
            url.includes('doubleclick.net/gampad')
        ) {
            category = 'ads';
        } else if (
            url.includes('analytics') ||
            url.includes('googletagmanager') ||
            url.includes('stats/ads') ||
            url.includes('clarity.ms') ||
            url.includes('facebook.net') ||
            url.includes('fastly.net') ||
            url.includes('omtrdc.net') ||
            url.includes('demdex.net') ||
            url.includes('scorecardresearch') ||
            url.includes('clevertap') ||
            url.includes('moengage') ||
            url.includes('doubleclick.net') ||
            info.request.type === 'ping'
        ) {
            category = 'trackers';
        }

        recordBlockedItem(category, tabId, tabDomain, 1);
    });
}

// 2B. PRODUCTION DNR MATCHED RULES SYNC (Throttled to respect Chrome's 20 calls / 10 min quota!)
async function syncProductionMatchedRules(tabId) {
    if (hasDebugDNRListener || !isGlobalShieldEnabled) return;
    if (!chrome.declarativeNetRequest || typeof chrome.declarativeNetRequest.getMatchedRules !== 'function') return;

    const now = Date.now();
    if (now - lastProductionSyncCallTime < 30000) return;
    lastProductionSyncCallTime = now;

    try {
        const filter = { minTimeStamp: lastMatchedRuleTimestamp || (now - 30000) };
        if (tabId && tabId >= 0) filter.tabId = tabId;

        const result = await chrome.declarativeNetRequest.getMatchedRules(filter);
        lastMatchedRuleTimestamp = now;

        if (result && Array.isArray(result.rulesMatchedInfo)) {
            result.rulesMatchedInfo.forEach(item => {
                const ruleId = item.rule ? item.rule.ruleId : 0;
                if (ruleId >= WHITELIST_RULE_ID_START && ruleId < CUSTOM_FILTER_RULE_ID_START) return;

                const tId = item.tabId >= 0 ? item.tabId : tabId;
                const domain = (tId && tabHostMap[tId]) ? tabHostMap[tId] : '';
                if (domain && isDomainWhitelisted(domain)) return;

                let category = 'ads';
                if (TRACKER_RULE_IDS.has(ruleId)) category = 'trackers';
                else if (POPUP_RULE_IDS.has(ruleId)) category = 'popups';
                else if (SUSPICIOUS_RULE_IDS.has(ruleId)) category = 'suspicious';

                recordBlockedItem(category, tId, domain, 1);
            });
        }
    } catch (e) {}
}

// 3. SPAM TAB & POP-UNDER ASSASSIN
function isSpamRedirectTabURL(urlStr) {
    if (!urlStr) return false;
    const u = urlStr.toLowerCase();
    if (u.startsWith('chrome://') || u.startsWith('chrome-extension://')) return false;

    const spamPatterns = [
        '.qpon/', 'enagemimble', 'xm.com/register', 'utm_medium=affiliate',
        'clickid=', 'playin05', 'gohappyin', 'popads.net', 'adsterra',
        'propellerads', 'ophionborish', 'dot-0', '.cfd/', '.sbs/', '.icu/'
    ];
    return spamPatterns.some(pattern => u.includes(pattern));
}

const closedSpamTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    checkAndExpirePauseTimer();
    const checkUrl = changeInfo.url || (tab && tab.url) || '';
    const host = extractHost(checkUrl);

    if (host) {
        tabHostMap[tabId] = host;
    }

    if (isGlobalShieldEnabled && checkUrl && isSpamRedirectTabURL(checkUrl)) {
        if (!closedSpamTabs.has(tabId)) {
            closedSpamTabs.add(tabId);
            const openerId = tab && tab.openerTabId ? tab.openerTabId : lastActiveTabId;
            const openerHost = openerId ? (tabHostMap[openerId] || '') : '';
            if (!isDomainWhitelisted(openerHost) && !isDomainWhitelisted(host)) {
                recordBlockedItem('popups', openerId, openerHost, 1);
                if (tab && tab.openerTabId) {
                    chrome.tabs.remove(tabId).catch(() => {});
                    return;
                }
            }
        }
        return;
    }

    if (changeInfo.status === 'complete' || changeInfo.url) {
        syncProductionMatchedRules(tabId);
        updateBadgeForTab(tabId, host);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    closedSpamTabs.delete(tabId);
    delete memoryTabStats[tabId];
    delete tabHostMap[tabId];
});

// 4. Mutex-Protected Engine Sync
async function syncProtectionEngine() {
    if (isSyncingRules) {
        syncPending = true;
        return;
    }
    isSyncingRules = true;

    try {
        await ensureStorageHydrated();
        const res = await chrome.storage.local.get(['adblockEnabled', 'whitelist', 'customFilters', 'pauseUntil']);
        isGlobalShieldEnabled = res.adblockEnabled !== false;
        cachedWhitelist = Array.isArray(res.whitelist) ? res.whitelist : [];
        const customFiltersText = typeof res.customFilters === 'string' ? res.customFilters : '';

        schedulePauseResumeTimer(res.pauseUntil || 0);

        if (isGlobalShieldEnabled) {
            await chrome.declarativeNetRequest.updateEnabledRulesets({
                enableRulesetIds: ['htp_rules'],
                disableRulesetIds: []
            });
        } else {
            await chrome.declarativeNetRequest.updateEnabledRulesets({
                enableRulesetIds: [],
                disableRulesetIds: ['htp_rules']
            });
        }

        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const removeRuleIds = existingRules.map(r => r.id);
        const whitelistRules = [];

        if (isGlobalShieldEnabled) {
            let ruleOffset = 0;
            cachedWhitelist.forEach((domain) => {
                const cleanDomain = String(domain).trim().toLowerCase().replace(/^www\./, '');
                if (!cleanDomain || /[^a-z0-9.-]/.test(cleanDomain)) return;

                whitelistRules.push({
                    id: WHITELIST_RULE_ID_START + ruleOffset++,
                    priority: 100000,
                    action: { type: 'allow' },
                    condition: {
                        initiatorDomains: [cleanDomain, `www.${cleanDomain}`],
                        resourceTypes: [
                            'main_frame', 'sub_frame', 'script', 'xmlhttprequest',
                            'image', 'media', 'ping', 'stylesheet', 'font', 'other'
                        ]
                    }
                });

                whitelistRules.push({
                    id: WHITELIST_RULE_ID_START + ruleOffset++,
                    priority: 100000,
                    action: { type: 'allowAllRequests' },
                    condition: {
                        requestDomains: [cleanDomain, `www.${cleanDomain}`],
                        resourceTypes: ['main_frame', 'sub_frame']
                    }
                });
            });
        }

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: removeRuleIds,
            addRules: whitelistRules
        });

        if (isGlobalShieldEnabled && customFiltersText) {
            const lines = customFiltersText.split('\n');
            let customIndex = 0;

            for (const line of lines) {
                let trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('#') || trimmed.includes('##') || trimmed.includes('#@#')) {
                    continue;
                }

                let isException = false;
                if (trimmed.startsWith('@@')) {
                    isException = true;
                    trimmed = trimmed.slice(2).trim();
                }

                if (trimmed.includes('$')) {
                    trimmed = trimmed.split('$')[0].trim();
                }

                if (!trimmed || /[^\x20-\x7E]/.test(trimmed)) continue;

                const customRule = {
                    id: CUSTOM_FILTER_RULE_ID_START + customIndex++,
                    priority: isException ? 50000 : 200,
                    action: { type: isException ? 'allow' : 'block' },
                    condition: {
                        urlFilter: trimmed,
                        resourceTypes: [
                            'main_frame', 'sub_frame', 'script', 'xmlhttprequest',
                            'image', 'media', 'ping'
                        ]
                    }
                };

                try {
                    await chrome.declarativeNetRequest.updateDynamicRules({
                        removeRuleIds: [],
                        addRules: [customRule]
                    });
                } catch (ruleErr) {
                    console.warn('Skipped invalid custom filter line:', line);
                }
            }
        }

        broadcastStateToAllTabs();
    } catch (e) {
        console.warn('HTP Shield Engine Sync Warning:', e);
    } finally {
        isSyncingRules = false;
        if (syncPending) {
            syncPending = false;
            syncProtectionEngine();
        }
    }
}

// 5. Startup Initialization
ensureStorageHydrated().then(() => {
    syncProtectionEngine();
});

chrome.runtime.onInstalled.addListener(() => {
    ensureStorageHydrated().then(() => {
        chrome.storage.local.get(['adblockEnabled', 'whitelist', 'globalStats', 'domainStats', 'customFilters'], (res) => {
            chrome.storage.local.set({
                adblockEnabled: res.adblockEnabled !== false,
                whitelist: Array.isArray(res.whitelist) ? res.whitelist : [],
                customFilters: typeof res.customFilters === 'string' ? res.customFilters : '',
                pauseUntil: 0,
                globalStats: res.globalStats || memoryGlobalStats,
                domainStats: res.domainStats || memoryDomainStats
            }, () => {
                syncProtectionEngine();
            });
        });
    });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes) => {
    if (changes.adblockEnabled || changes.whitelist || changes.customFilters || changes.pauseUntil) {
        syncProtectionEngine();
    }
});

// 6. Message Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.cmd === 'record_block') {
        const tabId = sender.tab ? sender.tab.id : lastActiveTabId;
        const topTabHost = (sender.tab && sender.tab.url) ? extractHost(sender.tab.url) : '';
        const senderHost = topTabHost || msg.host || '';
        if (tabId && senderHost) {
            tabHostMap[tabId] = senderHost;
        }
        recordBlockedItem(msg.type, tabId, senderHost, Number(msg.count) || 1);
        sendResponse({ ok: true });
        return true;
    }

    if (msg.cmd === 'getStats') {
        ensureStorageHydrated().then(async () => {
            const tabId = msg.tabId;
            await syncProductionMatchedRules(tabId);
            const domain = (msg.domain || (tabId ? tabHostMap[tabId] : '') || '').toLowerCase().replace(/^www\./, '');
            const stats = getStatsForTarget(tabId, domain);
            sendResponse({
                stats: stats,
                globalStats: memoryGlobalStats,
                adblockEnabled: isGlobalShieldEnabled,
                pauseUntil: pauseUntilTimestamp
            });
        });
        return true;
    }

    if (msg.cmd === 'resetStats') {
        if (storageSaveTimer) {
            clearTimeout(storageSaveTimer);
            storageSaveTimer = null;
        }
        memoryGlobalStats = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
        memoryTabStats = {};
        memoryDomainStats = {};
        if (msg.tabId) {
            updateBadgeForTab(msg.tabId);
        }
        chrome.storage.local.set({
            globalStats: memoryGlobalStats,
            domainStats: {}
        }, () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    return true;
});