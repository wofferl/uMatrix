/*******************************************************************************

    µBlock - a Chromium browser extension to block requests.
    Copyright (C) 2014 The µBlock authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global Services, XPCOMUtils */

// For background page

/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu['import']('resource://gre/modules/Services.jsm');
Cu['import']('resource://gre/modules/XPCOMUtils.jsm');

/******************************************************************************/

self.vAPI = self.vAPI || {};

vAPI.firefox = true;

/******************************************************************************/

vAPI.app = {
    name: 'µBlock',
    cleanName: 'ublock',
    version: '0.7.2.0'
};

/******************************************************************************/

vAPI.app.restart = function() {

};

/******************************************************************************/

var SQLite = {
    open: function() {
        var path = Services.dirsvc.get('ProfD', Ci.nsIFile);
        path.append('extension-data');

        if (!path.exists()) {
            path.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt('0774', 8));
        }

        if (!path.isDirectory()) {
            throw Error('Should be a directory...');
        }

        path.append(vAPI.app.cleanName + '.sqlite');
        this.db = Services.storage.openDatabase(path);
        this.db.executeSimpleSQL(
            'CREATE TABLE IF NOT EXISTS settings' +
            '(name TEXT PRIMARY KEY NOT NULL, value TEXT);'
        );
    },
    close: function() {
        this.run('VACUUM');
        this.db.asyncClose();
    },
    run: function(query, values, callback) {
        if (!this.db) {
            this.open();
        }

        var result = {};

        query = this.db.createAsyncStatement(query);

        if (Array.isArray(values) && values.length) {
            var i = values.length;

            while (i--) {
                query.bindByIndex(i, values[i]);
            }
        }

        query.executeAsync({
            handleResult: function(rows) {
                if (!rows || typeof callback !== 'function') {
                    return;
                }

                var row;

                while (row = rows.getNextRow()) {
                    // we assume that there will be two columns, since we're
                    // using it only for preferences
                    result[row.getResultByIndex(0)] = row.getResultByIndex(1);
                }
            },
            handleCompletion: function(reason) {
                if (typeof callback === 'function' && reason === 0) {
                    callback(result);
                }
            },
            handleError: function(error) {
                console.error('SQLite error ', error.result, error.message);
            }
        });
    }
};

/******************************************************************************/

vAPI.storage = {
    QUOTA_BYTES: 100 * 1024 * 1024,
    sqlWhere: function(col, params) {
        if (params > 0) {
            params = Array(params + 1).join('?, ').slice(0, -2);
            return ' WHERE ' + col + ' IN (' + params + ')';
        }

        return '';
    },
    get: function(details, callback) {
        if (typeof callback !== 'function') {
            return;
        }

        var values = [], defaults = false;

        if (details !== null) {
            if (Array.isArray(details)) {
                values = details;
            }
            else if (typeof details === 'object') {
                defaults = true;
                values = Object.keys(details);
            }
            else {
                values = [details.toString()];
            }
        }

        SQLite.run(
            'SELECT * FROM settings' + this.sqlWhere('name', values.length),
            values,
            function(result) {
                var key;

                for (key in result) {
                    result[key] = JSON.parse(result[key]);
                }

                if (defaults) {
                    for (key in details) {
                        if (!result[key]) {
                            result[key] = details[key];
                        }
                    }
                }

                callback(result);
            }
        );
    },
    set: function(details, callback) {
        var key, values = [], placeholders = [];

        for (key in details) {
            values.push(key);
            values.push(JSON.stringify(details[key]));
            placeholders.push('?, ?');
        }

        if (!values.length) {
            return;
        }

        SQLite.run(
            'INSERT OR REPLACE INTO settings (name, value) SELECT ' +
                placeholders.join(' UNION SELECT '),
            values,
            callback
        );
    },
    remove: function(keys, callback) {
        if (typeof keys === 'string') {
            keys = [keys];
        }

        SQLite.run(
            'DELETE FROM settings' + this.sqlWhere('name', keys.length),
            keys,
            callback
        );
    },
    clear: function(callback) {
        SQLite.run('DELETE FROM settings', null, callback);
        SQLite.run('VACUUM');
    },
    getBytesInUse: function(keys, callback) {
        if (typeof callback !== 'function') {
            return;
        }

        SQLite.run(
            'SELECT "size" AS size, SUM(LENGTH(value)) FROM settings' +
                this.sqlWhere('name', Array.isArray(keys) ? keys.length : 0),
            keys,
            function(result) {
                callback(result.size);
            }
        );
    }
};

/******************************************************************************/

var windowWatcher = {
    onTabClose: function(e) {
        vAPI.tabs.onClosed(vAPI.tabs.getTabId(e.target));
    },
    onTabSelect: function(e) {
        // vAPI.setIcon();
    },
    onLoad: function(e) {
        if (e) {
            this.removeEventListener('load', windowWatcher.onLoad);
        }

        var docElement = this.document.documentElement;

        if (docElement.getAttribute('windowtype') !== 'navigator:browser') {
            return;
        }

        if (!this.gBrowser || !this.gBrowser.tabContainer) {
            return;
        }

        var tC = this.gBrowser.tabContainer;

        this.gBrowser.addTabsProgressListener(tabsProgressListener);
        tC.addEventListener('TabClose', windowWatcher.onTabClose);
        tC.addEventListener('TabSelect', windowWatcher.onTabSelect);

        // when new window is opened TabSelect doesn't run on the selected tab?
    },
    unregister: function() {
        Services.ww.unregisterNotification(this);

        for (var win of vAPI.tabs.getWindows()) {
            win.removeEventListener('load', this.onLoad);
            win.gBrowser.removeTabsProgressListener(tabsProgressListener);

            var tC = win.gBrowser.tabContainer;
            tC.removeEventListener('TabClose', this.onTabClose);
            tC.removeEventListener('TabSelect', this.onTabSelect);
        }
    },
    observe: function(win, topic) {
        if (topic === 'domwindowopened') {
            win.addEventListener('load', this.onLoad);
        }
    }
};

/******************************************************************************/

var tabsProgressListener = {
    onLocationChange: function(browser, webProgress, request, location, flags) {
        if (!webProgress.isTopLevel) {
            return;
        }

        var tabId = vAPI.tabs.getTabId(browser);

        if (flags & 1) {
            vAPI.tabs.onUpdated(tabId, {url: location.spec}, {
                frameId: 0,
                tabId: tabId,
                url: browser.currentURI.spec
            });
        }
        else {
            vAPI.tabs.onNavigation({
                frameId: 0,
                tabId: tabId,
                url: location.spec
            });
        }
    }
};

/******************************************************************************/

vAPI.tabs = {};

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    // onNavigation and onUpdated handled with tabsProgressListener
    // onClosed - handled in windowWatcher.onTabClose
    // onPopup ?

    Services.ww.registerNotification(windowWatcher);

    // already opened windows
    for (var win of this.getWindows()) {
        windowWatcher.onLoad.call(win);
    }
};

/******************************************************************************/

vAPI.tabs.getTabId = function(target) {
    if (target.linkedPanel) {
        return target.linkedPanel.slice(6);
    }

    var gBrowser = target.ownerDocument.defaultView.gBrowser;
    var i = gBrowser.browsers.indexOf(target);

    if (i !== -1) {
        i = this.getTabId(gBrowser.tabs[i]);
    }

    return i;
};

/******************************************************************************/

vAPI.tabs.get = function(tabId, callback) {
    var tab, windows;

    if (tabId === null) {
        tab = Services.wm.getMostRecentWindow('navigator:browser').gBrowser.selectedTab;
        tabId = vAPI.tabs.getTabId(tab);
    }
    else {
        windows = this.getWindows();

        for (var win of windows) {
            tab = win.gBrowser.tabContainer.querySelector(
                'tab[linkedpanel="panel-' + tabId + '"]'
            );

            if (tab) {
                break;
            }
        }
    }

    if (!tab) {
        callback();
        return;
    }

    var browser = tab.linkedBrowser;
    var gBrowser = browser.ownerDocument.defaultView.gBrowser;

    if (!windows) {
        windows = this.getWindows();
    }

    callback({
        id: tabId,
        index: gBrowser.browsers.indexOf(browser),
        windowId: windows.indexOf(browser.ownerDocument.defaultView),
        active: tab === gBrowser.selectedTab,
        url: browser.currentURI.spec,
        title: tab.label
    });
};

/******************************************************************************/

vAPI.tabs.getAll = function(window) {
    var tabs = [];

    for (var win of this.getWindows()) {
        if (window && window !== win) {
            continue;
        }

        for (var tab of win.gBrowser.tabs) {
            tabs.push(tab);
        }
    }

    return tabs;
};

/******************************************************************************/

vAPI.tabs.getWindows = function() {
    var winumerator = Services.wm.getEnumerator('navigator:browser');
    var windows = [];

    while (winumerator.hasMoreElements()) {
        var win = winumerator.getNext();

        if (!win.closed) {
            windows.push(win);
        }
    }

    return windows;
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true // if a tab is already opened with that url, then select it instead of opening a new one

vAPI.tabs.open = function(details) {
    if (!details.url) {
        return null;
    }
    // extension pages
    if (!/^[\w-]{2,}:/.test(details.url)) {
        details.url = vAPI.getURL(details.url);
    }

    var tab, tabs;

    if (details.select) {
        var rgxHash = /#.*/;
        // this is questionable
        var url = details.url.replace(rgxHash, '');
        tabs = this.getAll();

        for (tab of tabs) {
            var browser = tab.linkedBrowser;

            if (browser.currentURI.spec.replace(rgxHash, '') === url) {
                browser.ownerDocument.defaultView.gBrowser.selectedTab = tab;
                return;
            }
        }
    }

    if (details.active === undefined) {
        details.active = true;
    }

    var gBrowser = Services.wm.getMostRecentWindow('navigator:browser').gBrowser;

    if (details.index === -1) {
        details.index = gBrowser.browsers.indexOf(gBrowser.selectedBrowser) + 1;
    }

    if (details.tabId) {
        tabs = tabs || this.getAll();

        for (tab of tabs) {
            if (vAPI.tabs.getTabId(tab) === details.tabId) {
                tab.linkedBrowser.loadURI(details.url);
                return;
            }
        }
    }

    tab = gBrowser.loadOneTab(details.url, {inBackground: !details.active});

    if (details.index !== undefined) {
        gBrowser.moveTabTo(tab, details.index);
    }
};

/******************************************************************************/

vAPI.tabs.close = function(tabIds) {
    if (!Array.isArray(tabIds)) {
        tabIds = [tabIds];
    }

    tabIds = tabIds.map(function(tabId) {
        return 'tab[linkedpanel="panel-' + tabId + '"]';
    }).join(',');

    for (var win of this.getWindows()) {
        var tabs = win.gBrowser.tabContainer.querySelectorAll(tabIds);

        if (!tabs) {
            continue;
        }

        for (var tab of tabs) {
            win.gBrowser.removeTab(tab);
        }
    }
};

/******************************************************************************/

/*vAPI.tabs.injectScript = function(tabId, details, callback) {

};*/

/******************************************************************************/

vAPI.setIcon = function() {

};

/******************************************************************************/

vAPI.messaging = {
    gmm: Cc['@mozilla.org/globalmessagemanager;1'].getService(Ci.nsIMessageListenerManager),
    frameScript: 'chrome://' + vAPI.app.cleanName + '/content/frameScript.js',
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: function(){},
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.gmm.loadFrameScript(vAPI.messaging.frameScript, true);

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

vAPI.messaging.onMessage = function(request) {
    var messageManager = request.target.messageManager;
    var listenerId = request.data.portName.split('|');
    var requestId = request.data.requestId;
    var portName = listenerId[1];
    listenerId = listenerId[0];

    var callback = vAPI.messaging.NOOPFUNC;
    if ( requestId !== undefined ) {
        callback = function(response) {
            messageManager.sendAsyncMessage(
                listenerId,
                JSON.stringify({
                    requestId: requestId,
                    portName: portName,
                    msg: response !== undefined ? response : null
                })
            );
        };
    }

    var sender = {
        tab: {
            id: vAPI.tabs.getTabId(request.target)
        }
    };

    // Specific handler
    var r = vAPI.messaging.UNHANDLED;
    var listener = vAPI.messaging.listeners[portName];
    if ( typeof listener === 'function' ) {
        r = listener(request.data.msg, sender, callback);
    }
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    // Default handler
    r = vAPI.messaging.defaultHandler(request.data.msg, sender, callback);
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    console.error('µBlock> messaging > unknown request: %o', request.data);

    // Unhandled:
    // Need to callback anyways in case caller expected an answer, or
    // else there is a memory leak on caller's side
    callback();
};

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function(){ return vAPI.messaging.UNHANDLED; };
    }
    this.defaultHandler = defaultHandler;

    this.gmm.addMessageListener(
        vAPI.app.cleanName + ':background',
        this.onMessage
    );
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    this.gmm.broadcastAsyncMessage(
        vAPI.app.cleanName + ':broadcast',
        JSON.stringify({broadcast: true, msg: message})
    );
};

/******************************************************************************/

vAPI.messaging.unload = function() {
    this.gmm.removeMessageListener(
        vAPI.app.cleanName + ':background',
        this.onMessage
    );
    this.gmm.removeDelayedFrameScript(this.frameScript);
};

/******************************************************************************/

vAPI.lastError = function() {
    return null;
};

/******************************************************************************/

var conentPolicy = {
    classDescription: vAPI.app.name + ' ContentPolicy',
    classID: Components.ID('{e6d173c8-8dbf-4189-a6fd-189e8acffd27}'),
    contractID: '@' + vAPI.app.cleanName + '/content-policy;1',
    ACCEPT: Ci.nsIContentPolicy.ACCEPT,
    REJECT: Ci.nsIContentPolicy.REJECT_REQUEST,
    types: {
        7: 'sub_frame',
        4: 'stylesheet',
        2: 'script',
        3: 'image',
        5: 'object',
        11: 'xmlhttprequest'
    },
    get registrar() {
        return Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    },
    get catManager() {
        return Cc['@mozilla.org/categorymanager;1']
                .getService(Ci.nsICategoryManager);
    },
    QueryInterface: XPCOMUtils.generateQI([
        Ci.nsIFactory,
        Ci.nsIContentPolicy,
        Ci.nsISupportsWeakReference
    ]),
    createInstance: function(outer, iid) {
        if (outer) {
            throw Components.results.NS_ERROR_NO_AGGREGATION;
        }

        return this.QueryInterface(iid);
    },
    shouldLoad: function(type, location, origin, context) {
        if (type === 6 || !context || !/^https?$/.test(location.scheme)) {
            return this.ACCEPT;
        }

        var win = (context.ownerDocument || context).defaultView;

        if (!win) {
            return this.ACCEPT;
        }

        var block = vAPI.net.onBeforeRequest;

        type = this.types[type] || 'other';

        if (block.types.indexOf(type) === -1) {
            return this.ACCEPT;
        }

        var browser = win.top.QueryInterface(Ci.nsIInterfaceRequestor)
                        .getInterface(Ci.nsIWebNavigation)
                        .QueryInterface(Ci.nsIDocShell)
                        .chromeEventHandler;

        if (!browser) {
            return this.ACCEPT;
        }

        block = block.callback({
            url: location.spec,
            type: type,
            tabId: vAPI.tabs.getTabId(browser),
            frameId: win === win.top ? 0 : 1,
            parentFrameId: win === win.top ? -1 : 0
        });

        if (block && typeof block === 'object') {
            if (block.cancel === true) {
                return this.REJECT;
            }
            else if (block.redirectURL) {
                location.spec = block.redirectURL;
                return this.REJECT;
            }
        }

        return this.ACCEPT;
    },/*
    shouldProcess: function() {
        return this.ACCEPT;
    }*/
};

/******************************************************************************/

vAPI.net = {};

/******************************************************************************/

vAPI.net.registerListeners = function() {
    conentPolicy.registrar.registerFactory(
        conentPolicy.classID,
        conentPolicy.classDescription,
        conentPolicy.contractID,
        conentPolicy
    );
    conentPolicy.catManager.addCategoryEntry(
        'content-policy',
        conentPolicy.contractID,
        conentPolicy.contractID,
        false,
        true
    );
};

/******************************************************************************/

vAPI.net.unregisterListeners = function() {
    conentPolicy.registrar.unregisterFactory(conentPolicy.classID, conentPolicy);
    conentPolicy.catManager.deleteCategoryEntry(
        'content-policy',
        conentPolicy.contractID,
        false
    );
};

/******************************************************************************/

// clean up when the extension is disabled

window.addEventListener('unload', function() {
    SQLite.close();
    windowWatcher.unregister();
    vAPI.messaging.unload();
    vAPI.net.unregisterListeners();

    // close extension tabs
    var extURI, win, tab, host = vAPI.app.cleanName;

    for (win of vAPI.tabs.getWindows()) {
        for (tab of win.gBrowser.tabs) {
            extURI = tab.linkedBrowser.currentURI;

            if (extURI.scheme === 'chrome' && extURI.host === host) {
                win.gBrowser.removeTab(tab);
            }
        }
    }
});

/******************************************************************************/

})();

/******************************************************************************/
