(function() {
    const worldKey = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
        ? '__htpIsolatedInjected'
        : '__htpMainInjected';
    if (window[worldKey]) return;
    window[worldKey] = true;

    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
        return;
    }

    const currentHostname = window.location.hostname.replace(/^www\./, '').toLowerCase();

    let topLevelHostname = currentHostname;
    try {
        if (window !== window.top && document.referrer) {
            const refHost = new URL(document.referrer).hostname.replace(/^www\./, '').toLowerCase();
            if (refHost) topLevelHostname = refHost;
        }
    } catch (e) {}

    const SAFE_PRODUCTIVITY_DOMAINS = [
        'gemini.google.com',
        'aistudio.google.com',
        'docs.google.com',
        'drive.google.com',
        'mail.google.com',
        'accounts.google.com',
        'chatgpt.com',
        'chat.openai.com',
        'claude.ai',
        'github.com',
        'stackoverflow.com'
    ];

    if (SAFE_PRODUCTIVITY_DOMAINS.some(d =>
        currentHostname === d || currentHostname.endsWith('.' + d) ||
        topLevelHostname === d || topLevelHostname.endsWith('.' + d)
    )) {
        return;
    }

    const isIsolatedWorld = Boolean(
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.id === 'string'
    );

    const PAUSE_STORAGE_KEY = '__htp_shield_paused_state';

    const isHostInWhitelist = (host, whitelistArray) => {
        if (!host || !Array.isArray(whitelistArray)) return false;
        const cleanHost = host.replace(/^www\./, '').toLowerCase();
        return whitelistArray.some(d => {
            const cleanRule = String(d).trim().toLowerCase().replace(/^www\./, '');
            return cleanRule && (cleanHost === cleanRule || cleanHost.endsWith('.' + cleanRule));
        });
    };

    const applyPauseStateToDOM = (shouldPause) => {
        try {
            localStorage.setItem(PAUSE_STORAGE_KEY, shouldPause ? '1' : '0');
        } catch (e) {}

        if (document.documentElement) {
            if (shouldPause) {
                document.documentElement.setAttribute('data-htp-paused', 'true');
            } else {
                document.documentElement.removeAttribute('data-htp-paused');
            }
        }

        if (shouldPause) {
            const styleEl = document.getElementById('htp-shield-styles');
            if (styleEl) styleEl.remove();
            const customStyleEl = document.getElementById('htp-custom-cosmetic-styles');
            if (customStyleEl) customStyleEl.remove();

            document.querySelectorAll('[data-htp-blocked], [data-htp-hidden]').forEach(el => {
                el.style.removeProperty('display');
                el.style.removeProperty('height');
                el.removeAttribute('data-htp-blocked');
                el.removeAttribute('data-htp-hidden');
            });
        }
    };

    // =================================================================
    // PART A: ISOLATED WORLD BRIDGE + SAFE CUSTOM COSMETIC FILTERS (##)
    // =================================================================
    if (isIsolatedWorld) {
        const applyCustomCosmeticFilters = (customFiltersText, isPaused) => {
            const existing = document.getElementById('htp-custom-cosmetic-styles');
            if (isPaused || !customFiltersText || typeof customFiltersText !== 'string') {
                if (existing) existing.remove();
                return;
            }

            const cssRules = [];
            customFiltersText.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('!') || !trimmed.includes('##')) return;
                const parts = trimmed.split('##');
                const domainPart = parts[0].trim().toLowerCase();
                const selectorPart = parts.slice(1).join('##').trim();
                if (!selectorPart) return;

                const matchesDomain = !domainPart || domainPart.split(',').some(d => {
                    const cleanD = d.trim().replace(/^www\./, '');
                    return cleanD && (
                        currentHostname === cleanD || currentHostname.endsWith('.' + cleanD) ||
                        topLevelHostname === cleanD || topLevelHostname.endsWith('.' + cleanD)
                    );
                });

                if (matchesDomain) {
                    try {
                        document.createDocumentFragment().querySelector(selectorPart);
                        cssRules.push(`html:not([data-htp-paused="true"]) ${selectorPart} { display: none !important; }`);
                    } catch (e) {}
                }
            });

            if (cssRules.length === 0) {
                if (existing) existing.remove();
                return;
            }

            const styleEl = existing || document.createElement('style');
            styleEl.id = 'htp-custom-cosmetic-styles';
            styleEl.textContent = cssRules.join('\n');
            if (!existing && document.documentElement) {
                document.documentElement.appendChild(styleEl);
            }
        };

        const computeAndSyncState = (adblockEnabled, whitelist, customFilters, explicitTabPaused = null) => {
            const isGlobalEnabled = adblockEnabled !== false;
            const isWhitelisted = isHostInWhitelist(currentHostname, whitelist) || isHostInWhitelist(topLevelHostname, whitelist);
            const shouldPause = explicitTabPaused !== null ? Boolean(explicitTabPaused) : (!isGlobalEnabled || isWhitelisted);

            applyPauseStateToDOM(shouldPause);
            applyCustomCosmeticFilters(customFilters, shouldPause);
            window.postMessage({ __htpPauseStateSync: true, paused: shouldPause }, '*');
        };

        const syncFromStorage = () => {
            chrome.storage.local.get(['adblockEnabled', 'whitelist', 'customFilters', 'pauseUntil'], (res) => {
                let isEnabled = res.adblockEnabled !== false;
                if (!isEnabled && res.pauseUntil && Number(res.pauseUntil) > 0 && Date.now() >= Number(res.pauseUntil)) {
                    isEnabled = true;
                    chrome.storage.local.set({ adblockEnabled: true, pauseUntil: 0 });
                }
                computeAndSyncState(isEnabled, res.whitelist, res.customFilters);
            });
        };

        syncFromStorage();
        document.addEventListener('DOMContentLoaded', syncFromStorage);

        chrome.storage.onChanged.addListener((changes) => {
            if (changes.adblockEnabled || changes.whitelist || changes.customFilters || changes.pauseUntil) {
                syncFromStorage();
            }
        });

        chrome.runtime.onMessage.addListener((msg) => {
            if (msg && msg.cmd === 'htp_state_updated') {
                chrome.storage.local.get(['customFilters'], (res) => {
                    computeAndSyncState(msg.adblockEnabled, msg.whitelist, res.customFilters, msg.tabPaused);
                });
            }
        });

        window.addEventListener('message', (event) => {
            if (event.source !== window || !event.data || event.data.__htpShieldBridge !== true) return;
            try {
                chrome.runtime.sendMessage({
                    cmd: 'record_block',
                    type: event.data.type,
                    count: event.data.count || 1,
                    host: topLevelHostname || currentHostname
                });
            } catch (e) {}
        });

        if (document.documentElement) {
            document.documentElement.setAttribute('data-htp-bridge-ready', 'true');
        }
        window.postMessage({ __htpBridgeReadySignal: true }, '*');

        return;
    }

    // =================================================================
    // PART B: MAIN WORLD ENGINE (100% FULL POWER RESTORED)
    // =================================================================
    let cachedPauseFlag = false;
    try {
        cachedPauseFlag = localStorage.getItem(PAUSE_STORAGE_KEY) === '1';
        if (cachedPauseFlag && document.documentElement) {
            document.documentElement.setAttribute('data-htp-paused', 'true');
        }
    } catch (e) {}

    const isProtectionPaused = () => {
        if (cachedPauseFlag) return true;
        return Boolean(document.documentElement && document.documentElement.getAttribute('data-htp-paused') === 'true');
    };

    const pendingBlocksQueue = [];
    let isBridgeReady = Boolean(document.documentElement && document.documentElement.getAttribute('data-htp-bridge-ready') === 'true');

    const flushPendingQueue = () => {
        if (isProtectionPaused()) {
            pendingBlocksQueue.length = 0;
            return;
        }
        while (pendingBlocksQueue.length > 0) {
            const item = pendingBlocksQueue.shift();
            try {
                window.postMessage({
                    __htpShieldBridge: true,
                    type: item.type,
                    count: item.count
                }, '*');
            } catch (e) {}
        }
    };

    const lastReportTime = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
    const reportBlock = (type, minGapMs = 20, count = 1) => {
        if (isProtectionPaused()) return;
        const now = Date.now();
        if (now - (lastReportTime[type] || 0) < minGapMs) return;
        lastReportTime[type] = now;

        if (!isBridgeReady && !(document.documentElement && document.documentElement.getAttribute('data-htp-bridge-ready') === 'true')) {
            pendingBlocksQueue.push({ type, count });
            return;
        }

        try {
            window.postMessage({
                __htpShieldBridge: true,
                type: type,
                count: count
            }, '*');
        } catch (e) {}
    };

    // Full Recursive Pruner Restored (Skips only heavy comment/storyboard trees)
    const HEAVY_NON_AD_KEYS = new Set([
        'contents', 'continuationContents', 'frameworkUpdates', 'responseContext',
        'storyboards', 'microformat', 'cards', 'endscreen', 'captions', 'annotations',
        'streamingData', 'playbackTracking'
    ]);
    const prunedObjects = new WeakSet();

    function silentAdPruner(obj, visited = new WeakSet(), depth = 0) {
        if (isProtectionPaused() || depth > 7 || !obj || typeof obj !== 'object' || visited.has(obj)) {
            return false;
        }
        if (depth === 0 && prunedObjects.has(obj)) return false;
        if (depth === 0) prunedObjects.add(obj);

        visited.add(obj);
        let modified = false;

        const adKeys = [
            'playerAds', 'adPlacements', 'adSlots', 'adEngineConfig',
            'adBreakHeartbeatParams', 'bka', 'companionAd', 'adCompanion'
        ];
        for (let i = 0; i < adKeys.length; i++) {
            const key = adKeys[i];
            if (key in obj) {
                delete obj[key];
                modified = true;
                reportBlock('ads', 40);
            }
        }

        if ('enforcementMessageViewModel' in obj) {
            delete obj.enforcementMessageViewModel;
            modified = true;
            reportBlock('suspicious', 40);
        }

        if (obj.auxiliaryUi?.messageRenderers?.enforcementMessageViewModel) {
            delete obj.auxiliaryUi.messageRenderers.enforcementMessageViewModel;
            modified = true;
            reportBlock('suspicious', 40);
        }

        if (Array.isArray(obj.markersMap)) {
            const beforeLen = obj.markersMap.length;
            obj.markersMap = obj.markersMap.filter(m => m.key !== 'AD_MARKERS');
            if (obj.markersMap.length !== beforeLen) {
                modified = true;
                reportBlock('trackers', 40);
            }
        }

        if (obj.playabilityStatus && obj.playabilityStatus.status === 'ERROR') {
            obj.playabilityStatus.status = 'OK';
            delete obj.playabilityStatus.reason;
            delete obj.playabilityStatus.errorScreen;
            modified = true;
            reportBlock('suspicious', 40);
        }

        for (const key in obj) {
            if (HEAVY_NON_AD_KEYS.has(key)) continue;
            const val = obj[key];
            if (val && typeof val === 'object') {
                if (silentAdPruner(val, visited, depth + 1)) modified = true;
            }
        }
        return modified;
    }

    // Full CSS Selectors Restored
    const injectCSS = () => {
        if (isProtectionPaused()) {
            const existing = document.getElementById('htp-shield-styles');
            if (existing) existing.remove();
            return;
        }
        if (document.getElementById('htp-shield-styles')) return;
        const style = document.createElement('style');
        style.id = 'htp-shield-styles';
        style.textContent = `
            html:not([data-htp-paused="true"]) :is(
                ytd-ad-slot-renderer, #masthead-ad, ytd-banner-promo-renderer, 
                ytd-in-feed-ad-layout-renderer, .ytd-in-feed-ad-layout-renderer,
                ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
                .video-ads, .ytp-ad-module, .ytp-ad-player-overlay, .ytp-ad-player-overlay-layout,
                .ytp-ad-image-overlay, .ytp-ad-action-interstitial, .ytp-ad-overlay-slot,
                .ytp-ad-text-overlay, .ytp-ad-player-overlay-instream-info,
                ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer,
                ytd-companion-slot-renderer, ytd-action-companion-ad-renderer,
                ytd-image-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer,
                ad-avatar-lockup-view-model, ytd-ad-inline-playback-meta-block,
                ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
                ytd-enforcement-message-view-model,
                #player-ads, .ytd-merch-shelf-renderer,
                ytd-statement-banner-renderer,
                div[id^="ad-"]:not([id*="download"]), div[class^="ad-"]:not([class*="download"]), 
                div[id*="vpaid"], div[class*="vast"], iframe[src*="/vast"], iframe[src*="/ads/"],
                iframe[id^="google_ads_iframe"], ins.adsbygoogle, .mgbox,
                .fluid_ad_playing, .vast_video_loading, [class*="preroll"], [id*="preroll"]
            ) {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                width: 0px !important;
                height: 0px !important;
                pointer-events: none !important;
            }
        `;
        if (document.documentElement) {
            document.documentElement.appendChild(style);
        }
    };
    injectCSS();

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data) return;
        if (event.data.__htpPauseStateSync === true) {
            const wasPausedBefore = cachedPauseFlag;
            cachedPauseFlag = Boolean(event.data.paused);
            applyPauseStateToDOM(cachedPauseFlag);
            if (!cachedPauseFlag) {
                injectCSS();
                if (wasPausedBefore && currentHostname.includes('youtube.com')) {
                    try {
                        if (window.ytInitialPlayerResponse) silentAdPruner(window.ytInitialPlayerResponse);
                        if (window.ytInitialData) silentAdPruner(window.ytInitialData);
                    } catch (e) {}
                }
            }
        } else if (event.data.__htpBridgeReadySignal === true) {
            isBridgeReady = true;
            flushPendingQueue();
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        isBridgeReady = true;
        flushPendingQueue();
    });

    window.addEventListener('error', (e) => {
        if (isProtectionPaused()) return;
        const el = e.target;
        if (!el || !el.tagName) return;
        const src = (el.src || el.href || '').toLowerCase();
        if (!src) return;

        if (
            src.includes('analytics') || src.includes('googletagmanager') ||
            src.includes('clarity.ms') || src.includes('facebook.net') ||
            src.includes('omtrdc.net') || src.includes('demdex.net') ||
            src.includes('scorecardresearch') || src.includes('clevertap') ||
            src.includes('moengage') || src.includes('fastly.net')
        ) {
            reportBlock('trackers', 15);
        } else if (
            src.includes('doubleclick') || src.includes('googlesyndication') ||
            src.includes('googleadservices') || src.includes('adsterra') ||
            src.includes('propeller') || src.includes('popads') ||
            src.includes('taboola') || src.includes('outbrain') ||
            src.includes('criteo') || src.includes('/pagead/')
        ) {
            reportBlock('ads', 15);
        }
    }, true);

    if (navigator.sendBeacon) {
        const origSendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function(url, data) {
            if (!isProtectionPaused() && typeof url === 'string') {
                const u = url.toLowerCase();
                if (
                    u.includes('stats/ads') ||
                    u.includes('pagead') ||
                    u.includes('ptracking') ||
                    u.includes('doubleclick') ||
                    u.includes('analytics') ||
                    u.includes('ad_break') ||
                    u.includes('collector') ||
                    u.includes('telemetry') ||
                    u.includes('/fdp') ||
                    u.includes('omtrdc') ||
                    u.includes('flixcart.com')
                ) {
                    reportBlock('trackers', 15);
                    return true;
                }
            }
            return origSendBeacon(url, data);
        };
    }

    const isYouTube = currentHostname.includes('youtube.com');

    // =================================================================
    // WEAPON 2: MOVIE SITES & FLIPKART ("AD" Banners + Trackers + Iframes)
    // =================================================================
    if (!isYouTube) {
        const isWebTrackerURL = (u) => {
            return (
                u.includes('/fdp') ||
                u.includes('rome.api.flipkart.com/1/fdp') ||
                u.includes('collector') ||
                u.includes('google-analytics') ||
                u.includes('googletagmanager') ||
                u.includes('clarity.ms') ||
                u.includes('omtrdc.net') ||
                u.includes('demdex.net') ||
                u.includes('clevertap') ||
                u.includes('moengage') ||
                u.includes('scorecardresearch')
            );
        };

        const isWebAdOrVastURL = (u) => {
            return (
                u.includes('/vast') ||
                u.includes('vpaid') ||
                u.includes('preroll') ||
                u.includes('adsterra') ||
                u.includes('propeller') ||
                u.includes('popads') ||
                u.includes('doubleclick.net') ||
                u.includes('googlesyndication') ||
                u.includes('criteo')
            );
        };

        const origWebFetch = window.fetch;
        window.fetch = async function(...args) {
            if (isProtectionPaused()) return origWebFetch.apply(this, args);
            const url = (typeof args[0] === 'string' ? args[0] : (args[0]?.url || '')).toLowerCase();

            if (url && isWebTrackerURL(url)) {
                reportBlock('trackers', 15);
                return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url && isWebAdOrVastURL(url)) {
                reportBlock('ads', 15);
                return new Response('<VAST version="3.0"></VAST>', {
                    status: 200,
                    headers: { 'Content-Type': 'application/xml' }
                });
            }
            return origWebFetch.apply(this, args);
        };

        const origWebOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._htpWebUrl = typeof url === 'string' ? url.toLowerCase() : '';
            return origWebOpen.call(this, method, url, ...rest);
        };

        const origWebSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
            if (!isProtectionPaused() && this._htpWebUrl) {
                if (isWebTrackerURL(this._htpWebUrl)) {
                    reportBlock('trackers', 15);
                    this.abort();
                    return;
                }
                if (isWebAdOrVastURL(this._htpWebUrl)) {
                    reportBlock('ads', 15);
                    this.abort();
                    return;
                }
            }
            return origWebSend.apply(this, arguments);
        };

        const isExplicitSpamURL = (urlStr) => {
            if (!urlStr) return true;
            const u = urlStr.toString().trim().toLowerCase();
            if (!u || u === 'about:blank' || u.startsWith('javascript:')) return true;

            const trashPatterns = [
                '.qpon', 'enagemimble', 'xm.com/register', 'utm_medium=affiliate', 'clickid=',
                'playin0', 'gohappyin', 'dot-0', '.cfd/', '.sbs/', '.icu/', '.cyou/',
                '.rest/', '.hair/', '.quest/', '.click/', '.bid/', '.win/', 'betting', 'casino',
                'adsterra', 'popunder', 'propeller', 'onclick', 'popads', 'ophionborish'
            ];
            return trashPatterns.some(k => u.includes(k));
        };

        const SAFE_POPUP_DOMAINS = [
            'google.com', 'accounts.google.com', 'drive.google.com', 'youtube.com',
            'mega.nz', 't.me', 'telegram.me', 'github.com', 'flipkart.com',
            'amazon.in', 'amazon.com', 'razorpay.com', 'paytm.com', 'phonepe.com',
            'apple.com', 'microsoft.com', 'live.com'
        ];

        let lastUserClickedAnchorHref = '';
        let lastUserClickTime = 0;

        window.addEventListener('pointerdown', (e) => {
            const targetNode = e.target;
            if (targetNode && typeof targetNode.closest === 'function') {
                const a = targetNode.closest('a[href]');
                if (a && a.href) {
                    lastUserClickedAnchorHref = a.href;
                    lastUserClickTime = Date.now();
                    return;
                }
            }
            lastUserClickedAnchorHref = '';
            lastUserClickTime = Date.now();
        }, true);

        const originalOpen = window.open;
        window.open = new Proxy(originalOpen, {
            apply: function(target, thisArg, args) {
                if (isProtectionPaused()) return target.apply(thisArg, args);
                const url = args[0] ? args[0].toString() : '';

                if (!navigator.userActivation || !navigator.userActivation.isActive || isExplicitSpamURL(url)) {
                    reportBlock('popups', 10);
                    return { close: function(){}, focus: function(){}, blur: function(){}, closed: true };
                }

                try {
                    const parsed = new URL(url, window.location.href);
                    const targetHost = parsed.hostname.replace(/^www\./, '').toLowerCase();
                    const isSameSite = (targetHost === currentHostname || targetHost === topLevelHostname);
                    const isSafeAuthOrService = SAFE_POPUP_DOMAINS.some(d => targetHost === d || targetHost.endsWith('.' + d));
                    const userClickedMatchingLink = Boolean(
                        lastUserClickedAnchorHref &&
                        (Date.now() - lastUserClickTime) < 1500 &&
                        lastUserClickedAnchorHref.includes(targetHost)
                    );

                    if (!isSameSite && !isSafeAuthOrService && !userClickedMatchingLink) {
                        reportBlock('popups', 10);
                        return { close: function(){}, focus: function(){}, blur: function(){}, closed: true };
                    }
                } catch (e) {}

                return target.apply(thisArg, args);
            }
        });

        document.addEventListener('click', (e) => {
            if (isProtectionPaused()) return;
            const targetNode = e.target;
            if (!targetNode || typeof targetNode.closest !== 'function') return;
            const el = targetNode.closest('a');
            if (!el) return;

            const href = el.getAttribute('href') || '';
            if (href && !href.startsWith('#') && isExplicitSpamURL(href)) {
                reportBlock('popups', 10);
                reportBlock('suspicious', 10);
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);

        const isProtectedLayoutContainer = (node) => {
            if (!node || node === document.body || node === document.documentElement) return true;
            const tag = (node.tagName || '').toUpperCase();
            if (['MAIN', 'ARTICLE', 'HEADER', 'NAV', 'PRE', 'CODE', 'TEXTAREA'].includes(tag)) return true;
            const role = (node.getAttribute && node.getAttribute('role')) || '';
            if (role === 'main' || role === 'document' || role === 'region') return true;
            const rect = node.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.85 && rect.height > window.innerHeight * 0.6) return true;
            return false;
        };

        let webScanScheduled = false;
        const scanWebAds = () => {
            webScanScheduled = false;
            if (isProtectionPaused() || document.hidden) return;
            injectCSS();

            const allElements = document.querySelectorAll('div, span, button, a');
            for (let i = 0; i < allElements.length; i++) {
                const el = allElements[i];
                if (el.dataset.htpBlocked) continue;
                if (el.childElementCount > 2) continue;
                if (el.closest('pre, code, textarea, [contenteditable="true"]')) continue;

                const directText = (el.textContent || '').trim();

                if (
                    /^Skip after\s*\d+$/i.test(directText) ||
                    directText === 'Skip Ad'
                ) {
                    let container = el.parentElement;
                    let bestAdBox = el;

                    for (let depth = 0; depth < 6 && container && !isProtectedLayoutContainer(container); depth++) {
                        const rect = container.getBoundingClientRect();
                        const textContent = container.textContent || '';
                        if (rect.height >= 120 && rect.height <= 580 && rect.width >= 200 && rect.width <= 950) {
                            if (!textContent.includes('Download Links') && !textContent.includes('G-Direct')) {
                                bestAdBox = container;
                            }
                        }
                        container = container.parentElement;
                    }

                    if (!bestAdBox.dataset.htpBlocked && !isProtectedLayoutContainer(bestAdBox)) {
                        bestAdBox.querySelectorAll('video, iframe').forEach(media => {
                            try {
                                if (media.tagName === 'VIDEO') {
                                    media.muted = true;
                                    media.pause();
                                    media.src = '';
                                }
                            } catch (e) {}
                        });
                        bestAdBox.dataset.htpBlocked = 'true';
                        bestAdBox.style.setProperty('display', 'none', 'important');
                        bestAdBox.style.setProperty('height', '0px', 'important');
                        reportBlock('ads', 10);
                    }
                    continue;
                }

                if (el.children.length <= 1 && (directText === 'AD' || directText === 'Sponsored')) {
                    const badgeRect = el.getBoundingClientRect();
                    if (badgeRect.width >= 12 && badgeRect.width <= 80 && badgeRect.height >= 10 && badgeRect.height <= 40) {
                        let bannerTarget = el.closest('a');

                        if (!bannerTarget || bannerTarget.getBoundingClientRect().height < 40) {
                            let parent = el.parentElement;
                            for (let depth = 0; depth < 6 && parent && !isProtectedLayoutContainer(parent); depth++) {
                                const r = parent.getBoundingClientRect();
                                if (r.width >= 200 && r.height >= 50 && r.height <= 480 && r.height < window.innerHeight * 0.55) {
                                    bannerTarget = parent;
                                    if (parent.tagName === 'A' || parent.getAttribute('data-id') || parent.getAttribute('data-tkid') || r.height >= 90) {
                                        break;
                                    }
                                }
                                parent = parent.parentElement;
                            }
                        }

                        if (
                            bannerTarget &&
                            !bannerTarget.dataset.htpBlocked &&
                            !isProtectedLayoutContainer(bannerTarget) &&
                            bannerTarget.getBoundingClientRect().height >= 45
                        ) {
                            bannerTarget.dataset.htpBlocked = 'true';
                            el.dataset.htpBlocked = 'true';
                            bannerTarget.style.setProperty('display', 'none', 'important');
                            bannerTarget.style.setProperty('height', '0px', 'important');
                            reportBlock('ads', 10);
                        }
                    }
                }
            }
        };

        const movieAdObserver = new MutationObserver(() => {
            if (!webScanScheduled) {
                webScanScheduled = true;
                setTimeout(scanWebAds, 250);
            }
        });
        if (document.documentElement) {
            movieAdObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        setInterval(scanWebAds, 650);
    } 
    // =================================================================
    // WEAPON 3: YOUTUBE ENGINE (100% FULL POWER + PAUSE & SCROLL FIXED)
    // =================================================================
    else {
        if (window !== window.top) return;

        let lastUserPauseIntentTime = 0;

        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space' || e.key === 'k' || e.key === 'K' || e.key === 'MediaPlayPause') {
                lastUserPauseIntentTime = Date.now();
            }
        }, true);

        window.addEventListener('pointerdown', (e) => {
            const target = e.target;
            if (target && typeof target.closest === 'function' && target.closest('#movie_player, .html5-video-player, ytd-player')) {
                lastUserPauseIntentTime = Date.now();
            }
        }, true);

        const origJSONParse = JSON.parse;
        JSON.parse = function(...args) {
            const rawStr = args[0];
            const parsed = origJSONParse.apply(this, args);
            try {
                if (
                    !isProtectionPaused() &&
                    typeof rawStr === 'string' &&
                    (rawStr.includes('playerAds') ||
                     rawStr.includes('adPlacements') ||
                     rawStr.includes('adSlots') ||
                     rawStr.includes('enforcementMessageViewModel'))
                ) {
                    silentAdPruner(parsed);
                }
            } catch (e) {}
            return parsed;
        };

        let ytPlayerResponse = window.ytInitialPlayerResponse;
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
            get: () => ytPlayerResponse,
            set: (val) => {
                if (!isProtectionPaused()) silentAdPruner(val);
                ytPlayerResponse = val;
            },
            configurable: true
        });

        let ytInitData = window.ytInitialData;
        Object.defineProperty(window, 'ytInitialData', {
            get: () => ytInitData,
            set: (val) => {
                if (!isProtectionPaused()) silentAdPruner(val);
                ytInitData = val;
            },
            configurable: true
        });

        const origResponseJson = Response.prototype.json;
        Response.prototype.json = async function(...args) {
            const data = await origResponseJson.apply(this, args);
            try {
                if (!isProtectionPaused() && data && typeof data === 'object') silentAdPruner(data);
            } catch (e) {}
            return data;
        };

        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            if (isProtectionPaused()) return origFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

            if (url.includes('/api/stats/ads') || url.includes('/ptracking')) {
                reportBlock('trackers', 30);
                return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.includes('/pagead/') || url.includes('/youtubei/v1/ad_break') || url.includes('/get_midroll_') || url.includes('doubleclick.net')) {
                reportBlock('ads', 30);
                return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.includes('/youtubei/v1/player')) {
                const response = await origFetch.apply(this, args);
                try {
                    if (response.status === 200) {
                        const clone = response.clone();
                        const text = await clone.text();
                        if (
                            text.includes('playerAds') ||
                            text.includes('adPlacements') ||
                            text.includes('adSlots') ||
                            text.includes('enforcementMessageViewModel')
                        ) {
                            const json = origJSONParse(text);
                            if (silentAdPruner(json)) {
                                return new Response(JSON.stringify(json), {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: response.headers
                                });
                            }
                        }
                    }
                } catch (e) {}
                return response;
            }
            return origFetch.apply(this, args);
        };

        // Helper to unlock Polymer's IronDropdownScrollManager when YouTube locks scrolling on Song 2
        const unlockPolymerScroll = () => {
            try {
                if (window.Polymer && window.Polymer.IronDropdownScrollManager) {
                    const mgr = window.Polymer.IronDropdownScrollManager;
                    if (Array.isArray(mgr._lockingElements) && mgr._lockingElements.length > 0) {
                        const copy = mgr._lockingElements.slice();
                        for (let i = 0; i < copy.length; i++) {
                            mgr.removeScrollLock(copy[i]);
                        }
                    }
                }
            } catch (e) {}
        };

        let wasAdPlaying = false;
        let lastSeekedAdSrc = '';
        let ytCheckScheduled = false;

        const destroyYouTubeAdsAndPopups = () => {
            ytCheckScheduled = false;
            if (isProtectionPaused() || document.hidden) return;
            injectCSS();

            const domAdSlots = document.querySelectorAll(
                'ytd-ad-slot-renderer:not([data-htp-counted]), #masthead-ad:not([data-htp-counted]), ytd-in-feed-ad-layout-renderer:not([data-htp-counted]), ytd-promoted-sparkles-web-renderer:not([data-htp-counted]), ytd-banner-promo-renderer:not([data-htp-counted]), ytd-statement-banner-renderer:not([data-htp-counted]), ytd-companion-slot-renderer:not([data-htp-counted]), ytd-action-companion-ad-renderer:not([data-htp-counted]), ytd-player-legacy-desktop-watch-ads-renderer:not([data-htp-counted]), ad-avatar-lockup-view-model:not([data-htp-counted]), #player-ads:not([data-htp-counted])'
            );
            domAdSlots.forEach(slot => {
                slot.setAttribute('data-htp-counted', 'true');
                slot.setAttribute('data-htp-blocked', 'true');
                slot.style.setProperty('display', 'none', 'important');
                reportBlock('ads', 5);
            });

            const belowPlayer = document.querySelector('#above-the-fold, #below, ytd-watch-metadata');
            if (belowPlayer) {
                belowPlayer.querySelectorAll('ytd-ad-inline-playback-meta-block, ad-button-view-model, [aria-label="Learn more"]').forEach(btn => {
                    const adBar = btn.closest('ytd-ad-slot-renderer, ytd-companion-slot-renderer, ytd-in-feed-ad-layout-renderer, #player-ads, ad-avatar-lockup-view-model');
                    if (adBar && !adBar.dataset.htpHidden) {
                        adBar.dataset.htpHidden = 'true';
                        adBar.style.setProperty('display', 'none', 'important');
                        reportBlock('ads', 10);
                    }
                });
            }

            const player = document.getElementById('movie_player');
            const adShowing = Boolean(
                player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))
            );
            const video = player ? player.querySelector('video.html5-main-video') : document.querySelector('video.html5-main-video');

            if (adShowing && video) {
                wasAdPlaying = true;
                video.muted = true;

                if (player) {
                    try {
                        if (typeof player.skipAd === 'function') player.skipAd();
                        if (typeof player.finishAd === 'function') player.finishAd();
                    } catch (e) {}
                }

                const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, .ytp-ad-overlay-close-button');
                if (skipBtn) {
                    skipBtn.click();
                    reportBlock('ads', 40);
                }

                if (isFinite(video.duration) && video.duration > 0.5 && !video.seeking) {
                    const targetTime = Math.max(0, video.duration - 0.1);
                    if (video.currentTime < targetTime - 0.3 && lastSeekedAdSrc !== video.src) {
                        lastSeekedAdSrc = video.src;
                        video.currentTime = targetTime;
                        reportBlock('ads', 40);
                    }
                }

                if (video.playbackRate !== 16) {
                    video.playbackRate = 16;
                }
                if (video.paused) {
                    video.play().catch(() => {});
                }
            } 
            else if (video) {
                if (wasAdPlaying) {
                    wasAdPlaying = false;
                    lastSeekedAdSrc = '';
                    video.playbackRate = 1;
                    video.muted = false;
                    if (player && typeof player.unMute === 'function') {
                        try { player.unMute(); } catch (e) {}
                    }
                    if (video.paused && !video.ended) {
                        video.play().catch(() => {});
                    }
                } else if (video.playbackRate === 16) {
                    video.playbackRate = 1;
                }
            }

            // 🟢 SURGICAL FIX: Mark enforcement dialog BEFORE removing child, and ONLY trigger popupKilled when an [opened] modal is closed!
            let popupKilled = false;
            const enforcementEl = document.querySelector('ytd-enforcement-message-view-model');
            if (enforcementEl) {
                const parentDialog = enforcementEl.closest('tp-yt-paper-dialog');
                if (parentDialog) {
                    parentDialog.dataset.htpEnforcement = 'true';
                    if (parentDialog.hasAttribute('opened')) {
                        popupKilled = true;
                    }
                    if (typeof parentDialog.cancel === 'function') parentDialog.cancel();
                    if (typeof parentDialog.close === 'function') parentDialog.close();
                    parentDialog.removeAttribute('opened');
                    parentDialog.style.setProperty('display', 'none', 'important');
                }
                enforcementEl.remove();
                reportBlock('suspicious', 40);
            }

            // Check ONLY currently [opened] dialogs so we NEVER loop on closed dialogs and NEVER block user Pause!
            const openedModals = document.querySelectorAll('tp-yt-paper-dialog[opened]');
            openedModals.forEach(modal => {
                const text = (modal.textContent || '').trim();
                if (
                    modal.dataset.htpEnforcement === 'true' ||
                    text.includes('ad blocker') ||
                    text.includes('Ad blockers') ||
                    text.includes('blocked after 3 videos') ||
                    text.includes('Which of these extensions') ||
                    text.includes('Allow YouTube Ads')
                ) {
                    modal.dataset.htpEnforcement = 'true';
                    const dismissBtn = modal.querySelector('#dismiss-button, [aria-label="Close"], .close-button');
                    if (dismissBtn) dismissBtn.click();
                    if (typeof modal.cancel === 'function') modal.cancel();
                    if (typeof modal.close === 'function') modal.close();
                    modal.removeAttribute('opened');
                    modal.style.setProperty('display', 'none', 'important');
                    popupKilled = true;
                    reportBlock('suspicious', 40);
                }
            });

            // Clean up leftover backdrop & Polymer scroll-lock (recognizes data-htp-enforcement so empty modal never locks scroll!)
            const backdrops = document.querySelectorAll('tp-yt-iron-overlay-backdrop');
            if (backdrops.length > 0 || popupKilled) {
                const legitOpenDialog = Array.from(document.querySelectorAll('tp-yt-paper-dialog[opened]')).some(d => {
                    return d.dataset.htpEnforcement !== 'true' && d.style.display !== 'none' && d.offsetWidth > 40 && !d.querySelector('ytd-enforcement-message-view-model');
                });
                if (!legitOpenDialog) {
                    backdrops.forEach(b => {
                        b.classList.remove('opened');
                        b.remove();
                    });
                    unlockPolymerScroll();
                }
            }

            if (document.body && document.body.style.pointerEvents === 'none') {
                document.body.style.pointerEvents = 'auto';
            }
            if (document.documentElement && document.documentElement.style.pointerEvents === 'none') {
                document.documentElement.style.pointerEvents = 'auto';
            }

            if (popupKilled && video && video.paused && !video.ended && !adShowing) {
                if ((Date.now() - lastUserPauseIntentTime) >= 1500) {
                    video.play().catch(() => {});
                }
            }
        };

        const observer = new MutationObserver(() => {
            if (!ytCheckScheduled) {
                ytCheckScheduled = true;
                setTimeout(destroyYouTubeAdsAndPopups, 200);
            }
        });
        if (document.documentElement) {
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
        setInterval(destroyYouTubeAdsAndPopups, 400);
    }
})();