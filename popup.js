document.addEventListener('DOMContentLoaded', () => {
    // Main UI Elements
    const powerBtn = document.getElementById('powerBtn');
    const btnStatusText = document.getElementById('btnStatusText');
    const vTitleText = document.getElementById('vTitleText');
    const vBadgeText = document.getElementById('vBadgeText');

    // Smart Control Buttons
    const btnPauseSite = document.getElementById('btnPauseSite');
    const txtPauseSite = document.getElementById('txtPauseSite') || (btnPauseSite ? btnPauseSite.querySelector('span') : null);
    const btnPause15 = document.getElementById('btnPause15');
    const txtPause15 = document.getElementById('txtPause15') || (btnPause15 ? btnPause15.querySelector('span') : null);
    const btnDisable = document.getElementById('btnDisable');
    const txtDisable = document.getElementById('txtDisable') || (btnDisable ? btnDisable.querySelector('span') : null);

    // Quick Actions & Domain Box
    const qaReload = document.getElementById('qaReload');
    const btnReset = document.getElementById('btnReset') || document.querySelector('.btn-reset');
    const displayDomainRight = document.getElementById('displayDomainRight');
    const dynamicDomainIcon = document.getElementById('dynamicDomainIcon');

    // GLOBAL Stats Elements (TODAY'S STATISTICS)
    const stAds = document.getElementById('stAds');
    const stPopups = document.getElementById('stPopups');
    const stTrackers = document.getElementById('stTrackers');
    const stTotal = document.getElementById('stTotal');

    // TAB/DOMAIN Stats Elements (TARGET DOMAIN SIDEBAR)
    const rsAds = document.getElementById('rsAds');
    const rsPopups = document.getElementById('rsPopups');
    const rsTrackers = document.getElementById('rsTrackers');
    const rsSuspicious = document.getElementById('rsSuspicious');

    let currentHost = "System Page";
    let isGlobalEnabled = true;
    let isWhitelisted = false;
    let pauseUntilTime = 0;
    let currentTabId = null;

    function formatHostName(urlStr) {
        try {
            if (!urlStr || urlStr === '' || urlStr.startsWith('chrome://newtab')) return "System Page";
            if (urlStr.startsWith('chrome://extensions')) return "Chrome Extensions";
            if (urlStr.startsWith('chrome://') || urlStr.startsWith('chrome-extension://')) return "System Page";
            const url = new URL(urlStr);
            return url.hostname.replace(/^www\./, '').toLowerCase();
        } catch (e) {
            return "System Page";
        }
    }

    function checkHostWhitelisted(host, list) {
        if (!host || host === "System Page" || host === "Chrome Extensions" || host === "unknown site") return false;
        if (!Array.isArray(list)) return false;
        return list.some(d => {
            const clean = String(d).trim().toLowerCase().replace(/^www\./, '');
            return clean && (host === clean || host.endsWith('.' + clean));
        });
    }

    // 100% Local Browser Favicon Loader (No external third-party server calls for CWS Privacy compliance!)
    function updateDomainIcon(hostname, tabUrl, tabFavIconUrl) {
        if (!dynamicDomainIcon) return;
        dynamicDomainIcon.style.display = 'inline-block';

        if (hostname === "System Page" || hostname === "Chrome Extensions" || hostname === "unknown site") {
            dynamicDomainIcon.src = 'icons/icon128.png';
            return;
        }

        const candidates = [];
        if (tabFavIconUrl && (tabFavIconUrl.startsWith('http') || tabFavIconUrl.startsWith('data:'))) {
            candidates.push(tabFavIconUrl);
        }
        if (tabUrl && tabUrl.startsWith('http')) {
            const chromeFaviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
            chromeFaviconUrl.searchParams.set('pageUrl', tabUrl);
            chromeFaviconUrl.searchParams.set('size', '32');
            candidates.push(chromeFaviconUrl.toString());
        }
        candidates.push('icons/icon128.png');

        let attemptIndex = 0;
        dynamicDomainIcon.onerror = function() {
            attemptIndex++;
            if (attemptIndex < candidates.length) {
                this.src = candidates[attemptIndex];
            } else {
                this.onerror = null;
            }
        };
        dynamicDomainIcon.src = candidates[0];
    }

    function updateUI() {
        const isSystemPage = (currentHost === "System Page" || currentHost === "Chrome Extensions" || currentHost === "unknown site");
        const isPaused15Active = (!isGlobalEnabled && pauseUntilTime > Date.now());

        if (qaReload) {
            qaReload.style.opacity = isSystemPage ? '0.45' : '1';
            qaReload.style.pointerEvents = isSystemPage ? 'none' : 'auto';
        }

        if (!isGlobalEnabled) {
            document.body.classList.add('disabled');
            if (btnStatusText) btnStatusText.innerText = isPaused15Active ? "PAUSED" : "OFF";
            if (vTitleText) vTitleText.innerText = "UNPROTECTED";
            if (vBadgeText) {
                if (isPaused15Active) {
                    const minsLeft = Math.max(1, Math.ceil((pauseUntilTime - Date.now()) / 60000));
                    vBadgeText.innerHTML = `⏳ PAUSED (${minsLeft}M)`;
                } else {
                    vBadgeText.innerHTML = "⚠ DISABLED";
                }
            }
            if (txtDisable) txtDisable.innerText = "Enable globally";
            if (txtPause15) txtPause15.innerText = "Resume Shield";
            if (btnDisable) btnDisable.style.opacity = '0.9';
            if (btnPause15) btnPause15.style.opacity = '0.9';
            if (btnPauseSite) {
                btnPauseSite.style.opacity = '0.4';
                btnPauseSite.style.pointerEvents = 'none';
            }
            if (txtPauseSite) txtPauseSite.innerText = "Pause on this site";
        } else {
            document.body.classList.remove('disabled');
            if (txtDisable) txtDisable.innerText = "Disable globally";
            if (txtPause15) txtPause15.innerText = "Pause for 15 Mins";
            if (btnDisable) btnDisable.style.opacity = '1';
            if (btnPause15) btnPause15.style.opacity = '1';

            if (isSystemPage) {
                if (btnPauseSite) {
                    btnPauseSite.style.opacity = '0.4';
                    btnPauseSite.style.pointerEvents = 'none';
                }
            } else if (btnPauseSite) {
                btnPauseSite.style.pointerEvents = 'auto';
            }

            if (isWhitelisted && !isSystemPage) {
                document.body.classList.add('disabled');
                if (btnStatusText) btnStatusText.innerText = "PAUSED";
                if (vTitleText) vTitleText.innerText = "UNPROTECTED";
                if (vBadgeText) vBadgeText.innerHTML = "⚠ ALLOWED SITE";
                if (txtPauseSite) txtPauseSite.innerText = "Resume on this site";
                if (btnPauseSite) btnPauseSite.style.opacity = '0.9';
            } else {
                if (btnStatusText) btnStatusText.innerText = "PROTECTED";
                if (vTitleText) vTitleText.innerText = "SECURE CONNECTION";
                if (vBadgeText) vBadgeText.innerHTML = "✓ ACTIVE";
                if (txtPauseSite) txtPauseSite.innerText = "Pause on this site";
                if (!isSystemPage && btnPauseSite) btnPauseSite.style.opacity = '1';
            }
        }
    }

    function renderGlobalStats(gs) {
        if (!gs) gs = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
        const adsCount = Number(gs.ads) || 0;
        const popupsCount = Number(gs.popups) || 0;
        const trackersCount = Number(gs.trackers) || 0;
        const suspiciousCount = Number(gs.suspicious) || 0;
        const total = adsCount + popupsCount + trackersCount + suspiciousCount;

        if (stAds) stAds.innerText = adsCount.toLocaleString();
        if (stPopups) stPopups.innerText = popupsCount.toLocaleString();
        if (stTrackers) stTrackers.innerText = trackersCount.toLocaleString();
        if (stTotal) stTotal.innerText = total.toLocaleString();
    }

    function renderTabStats(ts) {
        if (!ts) ts = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
        if (rsAds) rsAds.innerText = (Number(ts.ads) || 0).toLocaleString();
        if (rsPopups) rsPopups.innerText = (Number(ts.popups) || 0).toLocaleString();
        if (rsTrackers) rsTrackers.innerText = (Number(ts.trackers) || 0).toLocaleString();
        if (rsSuspicious) rsSuspicious.innerText = (Number(ts.suspicious) || 0).toLocaleString();
    }

    function refreshStatsFromBackground() {
        if (!currentTabId) return;
        const isSystemPage = (currentHost === "System Page" || currentHost === "Chrome Extensions" || currentHost === "unknown site");
        chrome.runtime.sendMessage({
            cmd: 'getStats',
            tabId: currentTabId,
            domain: isSystemPage ? '' : currentHost
        }, (res) => {
            if (chrome.runtime.lastError || !res) return;
            if (res.globalStats) renderGlobalStats(res.globalStats);
            if (res.stats) renderTabStats(isSystemPage ? { ads: 0, popups: 0, trackers: 0, suspicious: 0 } : res.stats);
        });
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            currentTabId = tabs[0].id;
            currentHost = formatHostName(tabs[0].url);

            if (displayDomainRight) displayDomainRight.innerText = currentHost;
            updateDomainIcon(currentHost, tabs[0].url, tabs[0].favIconUrl);

            chrome.storage.local.get(['adblockEnabled', 'whitelist', 'globalStats', 'domainStats', 'pauseUntil'], (result) => {
                isGlobalEnabled = result.adblockEnabled !== false;
                pauseUntilTime = Number(result.pauseUntil) || 0;
                if (!isGlobalEnabled && pauseUntilTime > 0 && Date.now() >= pauseUntilTime) {
                    isGlobalEnabled = true;
                    pauseUntilTime = 0;
                }
                isWhitelisted = checkHostWhitelisted(currentHost, result.whitelist || []);

                updateUI();
                renderGlobalStats(result.globalStats);
                if (result.domainStats && result.domainStats[currentHost]) {
                    renderTabStats(result.domainStats[currentHost]);
                }
                refreshStatsFromBackground();
            });
        }
    });

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.adblockEnabled !== undefined) {
            isGlobalEnabled = changes.adblockEnabled.newValue !== false;
        }
        if (changes.pauseUntil !== undefined) {
            pauseUntilTime = Number(changes.pauseUntil.newValue) || 0;
        }
        if (changes.whitelist && changes.whitelist.newValue) {
            isWhitelisted = checkHostWhitelisted(currentHost, changes.whitelist.newValue);
        }
        updateUI();
        if (changes.globalStats && changes.globalStats.newValue) {
            renderGlobalStats(changes.globalStats.newValue);
        }
        if (changes.domainStats && changes.domainStats.newValue && changes.domainStats.newValue[currentHost]) {
            renderTabStats(changes.domainStats.newValue[currentHost]);
        }
    });
    setInterval(refreshStatsFromBackground, 600);

    // 1. Main Power Radar Button & Disable Globally Button
    function toggleGlobalProtection() {
        isGlobalEnabled = !isGlobalEnabled;
        pauseUntilTime = 0;
        chrome.storage.local.set({
            adblockEnabled: isGlobalEnabled,
            pauseUntil: 0
        }, () => {
            updateUI();
        });
    }

    if (powerBtn) powerBtn.addEventListener('click', toggleGlobalProtection);
    if (btnDisable) btnDisable.addEventListener('click', toggleGlobalProtection);

    // 2. Pause on This Site Button
    if (btnPauseSite) {
        btnPauseSite.addEventListener('click', () => {
            if (currentHost === "unknown site" || currentHost === "System Page" || currentHost === "Chrome Extensions") return;
            chrome.storage.local.get(['whitelist'], (res) => {
                let list = Array.isArray(res.whitelist) ? res.whitelist : [];
                if (isWhitelisted) {
                    list = list.filter(d => {
                        const clean = String(d).trim().toLowerCase().replace(/^www\./, '');
                        return !(currentHost === clean || currentHost.endsWith('.' + clean));
                    });
                    isWhitelisted = false;
                } else {
                    if (!list.includes(currentHost)) {
                        list.push(currentHost);
                    }
                    isWhitelisted = true;
                }
                chrome.storage.local.set({ whitelist: list }, () => {
                    updateUI();
                });
            });
        });
    }

    // 3. Pause for 15 Mins Button
    if (btnPause15) {
        btnPause15.addEventListener('click', () => {
            if (isGlobalEnabled) {
                isGlobalEnabled = false;
                pauseUntilTime = Date.now() + (15 * 60 * 1000);
                chrome.storage.local.set({
                    adblockEnabled: false,
                    pauseUntil: pauseUntilTime
                }, () => {
                    updateUI();
                });
            } else {
                isGlobalEnabled = true;
                pauseUntilTime = 0;
                chrome.storage.local.set({
                    adblockEnabled: true,
                    pauseUntil: 0
                }, () => {
                    updateUI();
                });
            }
        });
    }

    // 4. Reload Page Button
    if (qaReload) {
        qaReload.addEventListener('click', () => {
            if (currentTabId && currentHost !== "System Page" && currentHost !== "Chrome Extensions") {
                chrome.tabs.reload(currentTabId);
                window.close();
            }
        });
    }

    // 5. Reset Statistics Button
    if (btnReset) {
        btnReset.addEventListener('click', () => {
            chrome.runtime.sendMessage({ cmd: 'resetStats', tabId: currentTabId }, () => {
                const zeroStats = { ads: 0, popups: 0, trackers: 0, suspicious: 0 };
                renderGlobalStats(zeroStats);
                renderTabStats(zeroStats);
            });
        });
    }

    // 6. Navigation & Allowlist Buttons
    document.querySelectorAll('.btn-options, .btn-support').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget.getAttribute('data-tab') || "tab-support";
            chrome.tabs.create({ url: `options.html?tab=${target}` });
            window.close();
        });
    });
});