(function() {
    'use strict';
    // Run only on twitch.tv
    if (!/(^|\\.)twitch\\.tv$/.test(location.hostname)) return;

    const VERSION = 2;
    if (window.twitchAdSolutionsVersion >= VERSION) {
        window.twitchAdSolutionsVersion = VERSION;
        return;
    }
    window.twitchAdSolutionsVersion = VERSION;

    // --- Configuration ---
    const OPT_MODE_STRIP_AD_SEGMENTS = true;
    const OPT_MODE_NOTIFY_ADS_WATCHED = false;
    const OPT_MODE_NOTIFY_ADS_WATCHED_MIN_REQUESTS = false;
    const OPT_BACKUP_PLAYER_TYPE = 'autoplay';
    const OPT_BACKUP_PLATFORM = 'ios';
    const OPT_REGULAR_PLAYER_TYPE = 'site';
    const OPT_ACCESS_TOKEN_PLAYER_TYPE = null;
    const OPT_SHOW_AD_BANNER = true;
    const AD_SIGNIFIER = 'stitched-ad';
    const LIVE_SIGNIFIER = ',live';
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

    // --- Private token storage ---
    let gqlDeviceId = null;
    let clientIntegrityHeader = null;
    let authorizationHeader = null;

    // --- Inject options into scope ---
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

    // --- Parse M3U8 attributes ---
    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=,]+)=(?:"[^"]*"|[^,]*))/)
               .filter(Boolean)
               .map(x => {
                   const idx = x.indexOf('=');
                   const key = x.slice(0, idx);
                   let val = x.slice(idx + 1);
                   if (val.startsWith('"') && val.endsWith('"')) val = JSON.parse(val);
                   const num = Number(val);
                   return [key, Number.isNaN(num) ? val : num];
               })
        );
    }

    // --- GraphQL packet builder ---
    function makeGraphQlPacket(event, radToken, payload) {
        return [{
            operationName: 'ClientSideAdEventHandling_RecordAdEvent',
            variables: { input: { eventName: event, eventPayload: JSON.stringify(payload), radToken } },
            extensions: { persistedQuery: { version: 1, sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b' } }
        }];
    }

    // --- Send GraphQL request ---
    function gqlRequest(body, realFetch) {
        return (realFetch || fetch)('https://gql.twitch.tv/gql', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {
                'Client-Id': CLIENT_ID,
                'Client-Integrity': clientIntegrityHeader,
                'X-Device-Id': gqlDeviceId,
                'Authorization': authorizationHeader
            }
        });
    }

    // --- Fetch access token ---
    function getAccessToken(channelName, playerType, platform, realFetch) {
        if (!platform) platform = 'web';
        const query = `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){`` +
            `streamPlaybackAccessToken(channelName:$login, params:{platform:"${platform}",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value,signature}`,
            `videoPlaybackAccessToken(id:$vodID, params:{platform:"${platform}",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value,signature}` +
          `}`,
        body = { operationName: 'PlaybackAccessToken_Template', query, variables: { login: channelName, isLive: true, isVod: false, vodID: '', playerType } };
        return gqlRequest([body], realFetch);
    }

    // --- Detected ad handler ---
    function onFoundAd(streamInfo, textStr, reload) {
        streamInfo.UseBackupStream = true;
        streamInfo.IsMidroll = /midroll/i.test(textStr);
        if (reload) postTwitchWorkerMessage('UboReloadPlayer');
        postTwitchWorkerMessage('UboShowAdBanner', streamInfo.IsMidroll);
    }

    // --- Process M3U8 playlists ---
    async function processM3U8(url, textStr, realFetch) {
        const info = StreamInfosByUrl[url];
        if (!info || !OPT_MODE_STRIP_AD_SEGMENTS) return textStr;
        if (info.UseBackupStream) {
            const u = info.BackupEncodings.match(/^https:.*.m3u8/m)[0];
            const r = await realFetch(u);
            return r.ok ? await r.text() : textStr;
        }
        if (textStr.includes(AD_SIGNIFIER)) {
            onFoundAd(info, textStr, true);
            return '';
        }
        return textStr;
    }

    // --- Hook fetch inside Worker ---
    function hookWorkerFetch() {
        const realFetch = fetch;
        fetch = (url, options) => {
            if (typeof url === 'string' && url.trim().endsWith('.m3u8')) {
                return realFetch(url, options).then(async res => {
                    const txt = await res.text();
                    const patched = await processM3U8(url, txt, realFetch);
                    return new Response(patched, { status: res.status, statusText: res.statusText, headers: res.headers });
                });
            }
            return realFetch(url, options);
        };
    }

    // --- Hook Worker constructor ---
    function hookWindowWorker() {
        const W = window.Worker;
        class SafeWorker extends W {
            constructor(blobUrl, options) {
                const twitch = (() => { try { return new URL(blobUrl).origin.endsWith('.twitch.tv'); } catch { return false; }})();
                if (!twitch) { super(blobUrl, options); return; }
                const xhr = new XMLHttpRequest(); xhr.open('GET', blobUrl, false); xhr.send();
                const workerCode = xhr.responseText;
                const wrapper = `
                    ${processM3U8}\n${hookWorkerFetch}\n${getWasmWorkerJs}\n${onFoundAd}\n${parseAttributes}\n${makeGraphQlPacket}\n${gqlRequest}\n${getAccessToken}\n${tryNotifyAdsWatchedM3U8}\n                    declareOptions(self); hookWorkerFetch(); eval(\`` + workerCode.replace(/`/g, '\\`') + `\`);
                super(URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' })), options);
                this.addEventListener('message', e => {
                    if (e.data.key) postTwitchWorkerMessage(e.data.key, e.data.value);
                });
            }
        }
        Object.defineProperty(window, 'Worker', { get: () => SafeWorker, set() {} });
    }

    // --- Utility to fetch original worker JS ---
    function getWasmWorkerJs(url) {
        const r = new XMLHttpRequest(); r.open('GET', url, false); r.send(); return r.responseText;
    }

    // --- Post messages to Workers ---
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach(w => w.postMessage({ key, value }));
    }

    // --- Initialization ---
    declareOptions(window);
    hookWindowWorker();
    hookFetch();
})();
