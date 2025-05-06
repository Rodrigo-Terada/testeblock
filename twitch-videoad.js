twitch-videoad.js text/javascript
(function() {
    'use strict';
    // Only run on twitch.tv
    if (!/(^|\.)twitch\.tv$/.test(document.location.hostname)) return;

    const ourVersion = 2;
    if (window.twitchAdSolutionsVersion >= ourVersion) {
        window.twitchAdSolutionsVersion = ourVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourVersion;

    // --- Configuration options ---
    const OPT_MODE_STRIP_AD_SEGMENTS = true;
    const OPT_MODE_NOTIFY_ADS_WATCHED = false;        // Disabled: no token capture or notifications
    const OPT_MODE_NOTIFY_ADS_WATCHED_MIN_REQUESTS = false;
    const OPT_BACKUP_PLAYER_TYPE = 'autoplay';
    const OPT_BACKUP_PLATFORM = 'ios';
    const OPT_REGULAR_PLAYER_TYPE = 'site';
    const OPT_ACCESS_TOKEN_PLAYER_TYPE = null;
    const OPT_SHOW_AD_BANNER = true;
    const AD_SIGNIFIER = 'stitched-ad';
    const LIVE_SIGNIFIER = ',live';
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

    // --- Internal token storage (in closure only) ---
    let gqlDeviceId = null;
    let clientIntegrityHeader = null;
    let authorizationHeader = null;

    // --- Worker hooking ---
    function hookWindowWorker() {
        const OriginalWorker = window.Worker;
        class SafeWorker extends OriginalWorker {
            constructor(blobUrl, options) {
                const isTwitch = (() => {
                    try { return new URL(blobUrl).origin.endsWith('.twitch.tv'); }
                    catch { return false; }
                })();
                if (!isTwitch) {
                    super(blobUrl, options);
                    return;
                }
                // Fetch worker code
                const code = (new XMLHttpRequest()).open('GET', blobUrl, false),
                      workerJS = code.send() || code.responseText;
                // Inject core functions without exposing tokens
                const patched = `
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${onFoundAd.toString()}
                    ${parseAttributes.toString()}
                    ${makeGraphQlPacket.toString()}
                    ${gqlRequest.toString()}
                    ${getAccessToken.toString()}
                    ${tryNotifyAdsWatchedM3U8.toString()}
                    declareOptions(self);
                    hookWorkerFetch();
                    eval(workerJS);
                `;
                super(URL.createObjectURL(new Blob([patched], { type: 'text/javascript' })), options);
            }
        }
        Object.defineProperty(window, 'Worker', {
            get: () => SafeWorker,
            set: _ => {
              // ignora atribuições
            }
          });
          
    }

    // --- Fetch hooking (with token guard) ---
    function hookFetch() {
        const realFetch = window.fetch;
        window.fetch = function(url, init) {
            if (OPT_MODE_NOTIFY_ADS_WATCHED && typeof url === 'string' && url.includes('gql')) {
                const headers = init.headers || {};
                gqlDeviceId = headers['X-Device-Id'] || gqlDeviceId;
                clientIntegrityHeader = headers['Client-Integrity'] || clientIntegrityHeader;
                authorizationHeader = headers['Authorization'] || authorizationHeader;
            }
            return realFetch.apply(this, arguments);
        };
    }

    // --- Minimal declareOptions (no token exposure) ---
    function declareOptions(scope) {
        scope.OPT_MODE_STRIP_AD_SEGMENTS = OPT_MODE_STRIP_AD_SEGMENTS;
        scope.OPT_MODE_NOTIFY_ADS_WATCHED = OPT_MODE_NOTIFY_ADS_WATCHED;
        scope.OPT_MODE_NOTIFY_ADS_WATCHED_MIN_REQUESTS = OPT_MODE_NOTIFY_ADS_WATCHED_MIN_REQUESTS;
        scope.OPT_BACKUP_PLAYER_TYPE = OPT_BACKUP_PLAYER_TYPE;
        scope.OPT_BACKUP_PLATFORM = OPT_BACKUP_PLATFORM;
        scope.OPT_REGULAR_PLAYER_TYPE = OPT_REGULAR_PLAYER_TYPE;
        scope.OPT_ACCESS_TOKEN_PLAYER_TYPE = OPT_ACCESS_TOKEN_PLAYER_TYPE;
        scope.OPT_SHOW_AD_BANNER = OPT_SHOW_AD_BANNER;
        scope.AD_SIGNIFIER = AD_SIGNIFIER;
        scope.LIVE_SIGNIFIER = LIVE_SIGNIFIER;
        scope.CLIENT_ID = CLIENT_ID;
    }

    // --- Core utility stubs ---
    function getWasmWorkerJs(url) {
        const req = new XMLHttpRequest(); req.open('GET', url, false); req.send();
        return req.responseText;
    }
    function parseAttributes(str) {
        return Object.fromEntries(str.split(/(?:^|,)([^=]+=...)/).filter(Boolean).map(x => {
            const [k, v] = x.split('='); return [k, JSON.parse(v)];
        }));
    }
    function makeGraphQlPacket(event, radToken, payload) {
        return [{
            operationName: 'ClientSideAdEventHandling_RecordAdEvent',
            variables: { input: { eventName: event, eventPayload: JSON.stringify(payload), radToken } },
            extensions: { persistedQuery: { version: 1, sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b' } }
        }];
    }
    function gqlRequest(body, realFetch) {
        return (realFetch || fetch)('https://gql.twitch.tv/gql', {
            method: 'POST', body: JSON.stringify(body),
            headers: {
                'Client-Id': CLIENT_ID,
                'Client-Integrity': clientIntegrityHeader,
                'X-Device-Id': gqlDeviceId,
                'Authorization': authorizationHeader
            }
        });
    }
    async function tryNotifyAdsWatchedM3U8(streamM3u8) {
        if (!OPT_MODE_NOTIFY_ADS_WATCHED || !streamM3u8 || !streamM3u8.includes(AD_SIGNIFIER)) return 1;
        // minimal implementation, tokens remain private
        return 0;
    }

    // --- Placeholder stubs for ad processing ---
    function processM3U8() { /* existing logic */ }
    function hookWorkerFetch() { /* existing logic */ }
    function onFoundAd() { /* existing logic */ }
    function getAccessToken() { /* existing logic */ }

    // --- Initialization ---
    hookWindowWorker();
    hookFetch();
})();
