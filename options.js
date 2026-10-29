document.addEventListener('DOMContentLoaded', () => {
    // 1. SIDEBAR & TAB NAVIGATION SYNC
    const urlParams = new URLSearchParams(window.location.search);
    let targetTab = urlParams.get('tab') || 'tab-whitelist';

    const tabContents = document.querySelectorAll('.tab-content');
    const navButtons = document.querySelectorAll('[data-tab]');

    function switchTab(tabId) {
        let selectedContent = document.getElementById(tabId);
        if (!selectedContent && tabContents.length > 0) {
            selectedContent = tabContents[0];
            tabId = selectedContent.id;
        }

        navButtons.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => {
            c.classList.remove('active');
            c.style.display = 'none';
        });

        const selectedBtn = document.querySelector(`[data-tab="${tabId}"]`);
        if (selectedBtn) selectedBtn.classList.add('active');
        if (selectedContent) {
            selectedContent.classList.add('active');
            selectedContent.style.display = 'block';
        }
    }

    switchTab(targetTab);

    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabId = e.currentTarget.getAttribute('data-tab');
            if (tabId) {
                window.history.pushState({}, '', `?tab=${tabId}`);
                switchTab(tabId);
            }
        });
    });

    // 2. MANAGE WHITELIST SYSTEM
    const domainInput = document.getElementById('domainInput') || document.querySelector('input[type="text"]');
    const addBtn = document.getElementById('addBtn') || document.querySelector('#tab-whitelist button');
    const whitelistUl = document.getElementById('whitelistUl') || document.querySelector('.whitelist');

    function loadWhitelist() {
        chrome.storage.local.get(['whitelist'], (res) => {
            const list = Array.isArray(res.whitelist) ? res.whitelist : [];
            if (!whitelistUl) return;

            whitelistUl.textContent = '';

            if (list.length === 0) {
                const emptyMsg = document.createElement('li');
                emptyMsg.className = 'empty-state';
                emptyMsg.textContent = 'Your whitelist is empty. All sites are protected.';
                whitelistUl.appendChild(emptyMsg);
            } else {
                list.forEach(domain => {
                    const li = document.createElement('li');
                    li.className = 'wl-item';

                    const span = document.createElement('span');
                    span.className = 'domain-name';
                    span.textContent = domain;

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-btn';
                    removeBtn.title = 'Remove from Whitelist';
                    removeBtn.textContent = '✕';

                    removeBtn.addEventListener('click', () => {
                        removeDomain(domain);
                    });

                    li.appendChild(span);
                    li.appendChild(removeBtn);
                    whitelistUl.appendChild(li);
                });
            }
        });
    }

    function removeDomain(domainToRemove) {
        chrome.storage.local.get(['whitelist'], (res) => {
            let list = Array.isArray(res.whitelist) ? res.whitelist : [];
            list = list.filter(d => d !== domainToRemove);
            chrome.storage.local.set({ whitelist: list }, loadWhitelist);
        });
    }

    if (addBtn && domainInput) {
        addBtn.addEventListener('click', () => {
            let val = domainInput.value.trim().toLowerCase();
            if (!val) return;

            try {
                if (val.startsWith('http://') || val.startsWith('https://')) {
                    val = new URL(val).hostname;
                }
            } catch (e) {}
            val = val.replace(/^www\./, '').replace(/\/.*$/, '');

            if (!val || !val.includes('.') || /[^a-z0-9.-]/.test(val)) {
                domainInput.style.borderColor = '#ef4444';
                setTimeout(() => { domainInput.style.borderColor = ''; }, 1500);
                return;
            }

            chrome.storage.local.get(['whitelist'], (res) => {
                const list = Array.isArray(res.whitelist) ? res.whitelist : [];
                if (!list.includes(val)) {
                    list.push(val);
                    chrome.storage.local.set({ whitelist: list }, () => {
                        domainInput.value = '';
                        loadWhitelist();
                    });
                } else {
                    domainInput.value = '';
                }
            });
        });

        domainInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addBtn.click();
            }
        });
    }

    loadWhitelist();

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.whitelist) loadWhitelist();
    });

    // 3. CUSTOM FILTERS ENGINE
    const rulesContainer = document.getElementById('tab-rules');
    const customFilterTextarea = document.getElementById('customFiltersInput') ||
        (rulesContainer ? rulesContainer.querySelector('textarea') : document.querySelector('textarea'));
    const saveFiltersBtn = document.getElementById('saveRulesBtn') ||
        document.getElementById('saveFiltersBtn') ||
        (rulesContainer ? rulesContainer.querySelector('button') : null);

    if (customFilterTextarea) {
        chrome.storage.local.get(['customFilters'], (res) => {
            if (res.customFilters) {
                customFilterTextarea.value = res.customFilters;
            }
        });
    }

    if (saveFiltersBtn && customFilterTextarea) {
        saveFiltersBtn.addEventListener('click', () => {
            const filterText = customFilterTextarea.value;
            const activeLines = filterText.split('\n').filter(l => {
                const t = l.trim();
                return t && !t.startsWith('!') && (!t.startsWith('#') || t.startsWith('##'));
            }).length;

            chrome.storage.local.set({ customFilters: filterText }, () => {
                saveFiltersBtn.textContent = `✓ Saved (${activeLines} Active Rules)`;
                saveFiltersBtn.style.background = '#10b981';

                setTimeout(() => {
                    saveFiltersBtn.textContent = 'Apply & Save Filters';
                    saveFiltersBtn.style.background = '';
                }, 2000);
            });
        });
    }

    // 4. SUPPORT / HELP CENTER BUTTON
    const helpCenterBtn = document.getElementById('helpCenterBtn');
    if (helpCenterBtn) {
        helpCenterBtn.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                window.open('https://www.youtube.com/@HackerTechProGroup', '_blank', 'noopener,noreferrer');
            } catch (err) {
                console.error('Failed to open help center link:', err);
            }
        });
    }
});